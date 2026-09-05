//! Headless agent backend — Claude Code driven over line-delimited JSON instead of a PTY.
//!
//! Same child program as [`crate::pty`], same session model, no terminal:
//!
//! ```text
//!   claude -p --input-format stream-json --output-format stream-json --verbose
//! ```
//!
//! stdin takes one JSON user message per line; stdout emits one JSON frame per line
//! (`system` init, `assistant` blocks, `user` tool results, `stream_event` deltas,
//! `result` at end of turn). That stream is the whole point: it carries the turn state
//! that `claudeScreen.ts` currently has to infer from rendered TUI text, exactly and
//! without a settle delay.
//!
//! Three threads per session, mirroring the PTY backend's shape:
//!
//! - stdout reader — blocking `read_line`, parses each line, pushes a frame downstream,
//! - stderr reader — same, tagged so startup failures stay visible instead of vanishing,
//! - forwarder     — coalesces frames into batches before crossing the IPC boundary.
//!
//! The coalescer earns its keep here for the same reason it does for the PTY:
//! `--include-partial-messages` turns one assistant turn into hundreds of tiny
//! `stream_event` frames, and one IPC message each would be pure overhead.
//!
//! WHY THE CHILD IS A LOGIN SHELL: `claude` is resolved through `$SHELL -lc`, not spawned
//! directly. A GUI app launched from Finder inherits a minimal PATH — no nvm shim, no
//! `~/.local/bin` — so a direct spawn fails for exactly the users who never see a
//! terminal. `exec` in the command line means the shell is *replaced* by `claude`, so the
//! pid we hold is the agent's own and the signal handling below reaches it directly.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};

use crate::pty::{
    alive, kill9, resolve_cwd, term, wait_for_exit, CLAUDE_SESSION_MARKERS, KILL_GRACE,
};
use crate::store;

/// Emitted to the frontend when a headless agent's child process exits.
///
/// Deliberately a DIFFERENT event name from the PTY backend's `session-exited`: the two
/// kinds of session have different restart semantics, and a single listener that could
/// not tell them apart would resume the wrong one.
#[derive(Clone, serde::Serialize)]
struct ExitPayload {
    id: String,
    code: Option<i32>,
}

/// One unit of output from a headless session.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentFrame {
    /// A well-formed JSON frame from stdout — the normal case.
    Frame { data: Value },
    /// A stdout line that was not valid JSON.
    ///
    /// Surfaced rather than swallowed on purpose. It should never happen, and if it does
    /// (a stray `console.log` in a hook, a wrapper script printing a banner) a silent
    /// drop would look like the agent simply stopped responding.
    Malformed { line: String },
    /// A line from stderr — usually the reason a session that never produced a frame
    /// failed, e.g. `claude: command not found` or an auth error.
    Stderr { line: String },
}

/// A live headless session.
struct AgentSession {
    /// Behind its OWN lock, for the same reason as the PTY writer: a write blocks while
    /// the child declines to read, and that must never happen while holding the lock over
    /// the session map (see [`AgentManager::send`]).
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    /// The child, kept so it can be reaped and so its handles outlive the grace period.
    child: Arc<Mutex<Child>>,
    pid: u32,
    /// Whether this session's reader may still announce `agent-exited`. Cleared when the
    /// session is displaced by a respawn under the same id, so the dying child's exit is
    /// not reported against an id its replacement now owns.
    announce_exit: Arc<AtomicBool>,
}

/// Owns every live headless session. Registered in Tauri managed state, alongside — not
/// instead of — [`crate::pty::PtyManager`]: shell panes and the script runner still need
/// a real terminal, so both backends run side by side.
#[derive(Default)]
pub struct AgentManager {
    sessions: Mutex<HashMap<String, AgentSession>>,
}

/// Coalescer tuning. Frames are small and already framed, so this window only needs to be
/// wide enough to absorb a partial-message burst — not to batch bytes.
const FLUSH_WINDOW: Duration = Duration::from_millis(16);
const MAX_BATCH: usize = 256;
/// Depth of the reader → forwarder queue, in frames. Bounded for the same reason as the
/// PTY's: blocking the reader is the backpressure that makes the child block in `write`,
/// instead of turning a fast turn into unbounded resident memory.
const QUEUE_DEPTH: usize = 512;

/// Wrap a string so a POSIX shell passes it through as one literal argument.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Permission modes accepted for a headless session.
///
/// Allow-listed rather than passed through: the value lands in a shell command line, and
/// `manual` is excluded on purpose — nobody is there to answer a prompt, so a session
/// started in that mode would silently deny every tool call and look like a hung agent.
/// Answering prompts in the UI needs `--permission-prompt-tool` and an MCP server to host
/// it; until that exists, the honest options are the ones that never prompt.
const PERMISSION_MODES: &[&str] = &["acceptEdits", "auto", "bypassPermissions", "dontAsk", "plan"];

/// Build the `claude` command line for a headless session.
///
/// `--resume` vs `--session-id` is decided here, from whether a transcript already exists
/// (see [`store::claude_session_exists`]). The PTY path can chain the two with `||` and
/// let the shell sort it out; there is no interactive shell here, and a wrong guess would
/// exit non-zero before emitting a single frame.
fn command_line(
    session_id: &str,
    prompt: Option<&str>,
    permission_mode: Option<&str>,
    partial_messages: bool,
) -> Result<String, String> {
    let mut parts = vec![
        "exec".to_string(),
        "claude".to_string(),
        "-p".to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        // Required for stream-json output under --print, and what makes the stream carry
        // tool calls and results rather than only assistant text.
        "--verbose".to_string(),
    ];
    if partial_messages {
        parts.push("--include-partial-messages".to_string());
    }
    if let Some(mode) = permission_mode.map(str::trim).filter(|m| !m.is_empty()) {
        if !PERMISSION_MODES.contains(&mode) {
            return Err(format!("unsupported permission mode: {mode}"));
        }
        parts.push("--permission-mode".to_string());
        parts.push(mode.to_string());
    }
    if store::claude_session_exists(session_id) {
        parts.push("--resume".to_string());
    } else {
        parts.push("--session-id".to_string());
    }
    parts.push(shell_quote(session_id));
    // The opening message, when the caller has one to seed. Later turns go over stdin.
    if let Some(prompt) = prompt.map(str::trim).filter(|p| !p.is_empty()) {
        parts.push(shell_quote(prompt));
    }
    Ok(parts.join(" "))
}

/// One JSON line for a user message, in the shape `--input-format stream-json` expects.
fn user_message(text: &str) -> Result<String, String> {
    let frame = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": text }] },
    });
    serde_json::to_string(&frame).map_err(|e| e.to_string())
}

/// Drain the readers' queue into the frontend channel, coalescing bursts. Returns when
/// either end goes away.
///
/// Takes `rx` BY VALUE so the receiver drops the moment draining stops — otherwise a dead
/// frontend channel (a webview reload) would leave the readers filling a queue nobody
/// reads, wedged forever on a send into a full bounded channel.
fn pump(rx: mpsc::Receiver<AgentFrame>, on_data: &Channel<Vec<AgentFrame>>) {
    while let Ok(first) = rx.recv() {
        let mut batch = vec![first];
        let deadline = Instant::now() + FLUSH_WINDOW;
        while batch.len() < MAX_BATCH {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            match rx.recv_timeout(deadline - now) {
                Ok(frame) => batch.push(frame),
                Err(_) => break, // timeout or disconnect -> flush what we have
            }
        }
        if on_data.send(batch).is_err() {
            break; // frontend channel dropped
        }
    }
}

/// Read a child stream line by line, mapping each line through `wrap` into the queue.
///
/// Lines are read as bytes and lossily decoded: a frame split mid-UTF-8 must not kill the
/// reader, which would silently end the session's output.
fn read_lines<R: BufRead>(
    mut reader: R,
    tx: mpsc::SyncSender<AgentFrame>,
    wrap: impl Fn(String) -> AgentFrame,
) {
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break, // EOF: child exited / stream closed
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf).trim_end().to_string();
                if line.is_empty() {
                    continue;
                }
                if tx.send(wrap(line)).is_err() {
                    break; // forwarder gone
                }
            }
            Err(_) => break,
        }
    }
}

/// Classify one stdout line: a JSON object is a frame, anything else is malformed.
fn parse_stdout_line(line: String) -> AgentFrame {
    match serde_json::from_str::<Value>(&line) {
        Ok(data) => AgentFrame::Frame { data },
        Err(_) => AgentFrame::Malformed { line },
    }
}

/// Stop one session: SIGTERM now (so `claude` flushes its transcript, which is what makes
/// `--resume` work later), SIGKILL whatever survives the grace period. The wait runs
/// off-thread so no Tauri command on the main thread ever blocks on it.
fn terminate(s: AgentSession) {
    let pid = s.pid;
    // Closing stdin is the polite hang-up: a headless session reading stream-json input
    // treats EOF as "no more turns" and shuts down on its own.
    if let Ok(mut stdin) = s.stdin.lock() {
        stdin.take();
    }
    term(pid);
    thread::spawn(move || {
        wait_for_exit(&[pid], KILL_GRACE);
        if alive(pid) {
            kill9(pid);
        }
        // Reap, so the child does not linger as a zombie. The reader thread may have
        // already done this, in which case the error is expected and ignored.
        if let Ok(mut child) = s.child.lock() {
            let _ = child.wait();
        }
        drop(s);
    });
}

impl AgentManager {
    /// Start a headless `claude` and stream its frames over `on_data`.
    ///
    /// A `cwd` that no longer exists is an ERROR, never a silent fallback — and it matters
    /// more here than for a PTY: `--resume` is project-scoped, so the wrong directory
    /// means the session id resolves to nothing and the conversation appears to be gone.
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        &self,
        app: AppHandle,
        id: String,
        session_id: String,
        cwd: Option<String>,
        prompt: Option<String>,
        permission_mode: Option<String>,
        partial_messages: bool,
        env: Option<HashMap<String, String>>,
        on_data: Channel<Vec<AgentFrame>>,
    ) -> Result<(), String> {
        // Resolved FIRST: a workspace folder that has gone away fails the whole call
        // before any process is started, and the caller shows the message in the pane.
        let dir = resolve_cwd(cwd)?;
        let line = command_line(
            &session_id,
            prompt.as_deref(),
            permission_mode.as_deref(),
            partial_messages,
        )?;

        let shell = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "/bin/bash".into());
        let mut cmd = Command::new(shell);
        cmd.args(["-lc", &line]);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // The child env is seeded from ours, so anything codesu inherited would leak into
        // every agent. Session markers must not (see CLAUDE_SESSION_MARKERS): with them
        // in place `claude` believes it is a nested child session and stops writing a
        // transcript, which is precisely what --resume needs.
        for key in CLAUDE_SESSION_MARKERS {
            cmd.env_remove(key);
        }
        // Caller overrides go on LAST so they beat both the inherited environment and the
        // scrub above — this is how an agent is pointed at its own Claude home.
        for (key, value) in env.into_iter().flatten() {
            cmd.env(key, value);
        }
        if let Some(dir) = dir {
            cmd.current_dir(dir);
        }

        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let pid = child.id();
        let stdin = child.stdin.take().ok_or("no stdin on child")?;
        let stdout = child.stdout.take().ok_or("no stdout on child")?;
        let stderr = child.stderr.take().ok_or("no stderr on child")?;

        let (tx, rx) = mpsc::sync_channel::<AgentFrame>(QUEUE_DEPTH);
        let stderr_tx = tx.clone();
        thread::spawn(move || {
            read_lines(BufReader::new(stdout), tx, parse_stdout_line);
        });
        thread::spawn(move || {
            read_lines(BufReader::new(stderr), stderr_tx, |line| {
                AgentFrame::Stderr { line }
            });
        });

        let child = Arc::new(Mutex::new(child));
        let announce_exit = Arc::new(AtomicBool::new(true));
        let may_announce = Arc::clone(&announce_exit);
        let exit_child = Arc::clone(&child);
        let exit_id = id.clone();

        // Forwarder thread. It owns the receiver, so both readers unblock the instant
        // draining stops — before the (possibly long) wait below.
        thread::spawn(move || {
            pump(rx, &on_data);
            let code = exit_child
                .lock()
                .ok()
                .and_then(|mut c| c.wait().ok())
                .and_then(|s| s.code());
            // Silent if this session has since been displaced — the id belongs to a
            // different, live child now (see AgentSession::announce_exit).
            if may_announce.load(Ordering::SeqCst) {
                let _ = app.emit("agent-exited", ExitPayload { id: exit_id, code });
            }
        });

        let session = AgentSession {
            stdin: Arc::new(Mutex::new(Some(stdin))),
            child,
            pid,
            announce_exit,
        };
        // An id is only reused if the frontend lost track of a session it never killed.
        // Dropping the displaced entry would leave its child running with nothing left to
        // stop it, so it is terminated on the way out — muted first, so its exit is not
        // reported against the id the session just installed above now owns.
        if let Some(displaced) = self.sessions.lock().unwrap().insert(id, session) {
            displaced.announce_exit.store(false, Ordering::SeqCst);
            terminate(displaced);
        }
        Ok(())
    }

    /// Send one user message, as a single stream-json line on the child's stdin.
    pub fn send(&self, id: &str, text: &str) -> Result<(), String> {
        let line = user_message(text)?;
        // The map lock is held only long enough to clone the stdin handle. A pipe write
        // blocks while the child declines to read, and Tauri runs sync commands on the
        // main thread — holding the map lock across the write would stall spawn/kill/
        // kill_all behind it, i.e. deadlock the whole app.
        let stdin = {
            let sessions = self.sessions.lock().unwrap();
            let s = sessions.get(id).ok_or("no such session")?;
            Arc::clone(&s.stdin)
        };
        let mut guard = stdin.lock().unwrap();
        let stdin = guard.as_mut().ok_or("session is shutting down")?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|()| stdin.write_all(b"\n"))
            .and_then(|()| stdin.flush())
            .map_err(|e| e.to_string())
    }

    /// Gracefully stop a session. Runs the wait off-thread so the UI never blocks.
    pub fn kill(&self, id: &str) {
        if let Some(s) = self.sessions.lock().unwrap().remove(id) {
            terminate(s);
        }
    }

    /// Stop every child on app exit — SIGTERM all so transcripts are flushed and every
    /// session stays resumable, wait for them to go, then SIGKILL any survivors.
    ///
    /// Called from the `ExitRequested` callback, so the wait is a poll that returns the
    /// moment the last child is gone: with no sessions open, quitting costs nothing.
    pub fn kill_all(&self) {
        let sessions: Vec<AgentSession> =
            self.sessions.lock().unwrap().drain().map(|(_, s)| s).collect();
        for s in &sessions {
            if let Ok(mut stdin) = s.stdin.lock() {
                stdin.take();
            }
            term(s.pid);
        }
        let pids: Vec<u32> = sessions.iter().map(|s| s.pid).collect();
        wait_for_exit(&pids, KILL_GRACE);
        for s in &sessions {
            if alive(s.pid) {
                kill9(s.pid);
            }
            if let Ok(mut child) = s.child.lock() {
                let _ = child.wait();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_survives_embedded_quotes_and_spaces() {
        assert_eq!(shell_quote("hello world"), "'hello world'");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
    }

    /// The prompt lands in a shell command line, so quoting is the boundary that keeps a
    /// task description from becoming a command. Asserted through a real shell rather
    /// than by string comparison — this is the property that actually matters.
    #[test]
    fn a_quoted_prompt_cannot_run_a_command() {
        let nasty = "'; touch /tmp/codesu-pwned-$$; echo '";
        let out = Command::new("/bin/sh")
            .args(["-c", &format!("printf %s {}", shell_quote(nasty))])
            .output()
            .expect("sh");
        assert_eq!(String::from_utf8_lossy(&out.stdout), nasty);
    }

    #[test]
    fn a_new_session_is_created_and_a_known_one_resumed() {
        // A uuid-shaped id with no transcript anywhere: must be created, not resumed.
        let fresh = "00000000-dead-4bee-8000-000000000000";
        let line = command_line(fresh, None, None, false).unwrap();
        assert!(line.contains("--session-id"), "{line}");
        assert!(!line.contains("--resume"), "{line}");
        // The invariants the frontend depends on, in one place.
        assert!(line.starts_with("exec claude -p "), "{line}");
        assert!(line.contains("--input-format stream-json"), "{line}");
        assert!(line.contains("--output-format stream-json"), "{line}");
        assert!(line.contains("--verbose"), "{line}");
    }

    #[test]
    fn partial_messages_and_permission_mode_are_opt_in() {
        let id = "00000000-dead-4bee-8000-000000000001";
        let bare = command_line(id, None, None, false).unwrap();
        assert!(!bare.contains("--include-partial-messages"), "{bare}");
        assert!(!bare.contains("--permission-mode"), "{bare}");

        let full = command_line(id, None, Some("acceptEdits"), true).unwrap();
        assert!(full.contains("--include-partial-messages"), "{full}");
        assert!(full.contains("--permission-mode acceptEdits"), "{full}");
    }

    /// `manual` is the trap this guard exists for: it is a real Claude Code mode, but with
    /// no one to answer a prompt it denies every tool call, and the agent looks hung.
    #[test]
    fn unanswerable_and_unknown_permission_modes_are_rejected() {
        let id = "00000000-dead-4bee-8000-000000000002";
        for bad in ["manual", "none", "yolo", "acceptEdits; rm -rf /"] {
            let err = command_line(id, None, Some(bad), false).unwrap_err();
            assert!(err.contains(bad), "{bad:?} should be named in: {err}");
        }
    }

    /// The frame the CLI expects on stdin. One line, and the text carried verbatim —
    /// JSON encoding is what keeps a multi-line prompt from splitting into two turns.
    #[test]
    fn a_user_message_is_one_json_line() {
        let line = user_message("first\nsecond").unwrap();
        assert!(!line.contains('\n'), "must be a single line: {line}");
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["role"], "user");
        assert_eq!(v["message"]["content"][0]["text"], "first\nsecond");
    }

    #[test]
    fn stdout_lines_are_json_frames_and_anything_else_is_flagged() {
        match parse_stdout_line(r#"{"type":"result","is_error":false}"#.into()) {
            AgentFrame::Frame { data } => assert_eq!(data["type"], "result"),
            _ => panic!("valid JSON must parse as a frame"),
        }
        match parse_stdout_line("Debugger attached.".into()) {
            AgentFrame::Malformed { line } => assert_eq!(line, "Debugger attached."),
            _ => panic!("non-JSON must be flagged, not swallowed"),
        }
    }

    /// Both streams feed one bounded queue, and the forwarder must batch whatever is
    /// waiting rather than emitting one IPC message per frame.
    #[test]
    fn frames_are_coalesced_into_batches() {
        let (tx, rx) = mpsc::sync_channel::<AgentFrame>(QUEUE_DEPTH);
        for i in 0..5 {
            tx.send(AgentFrame::Stderr { line: i.to_string() }).unwrap();
        }
        drop(tx);

        // pump() needs a Channel, which only Tauri can build, so the batching loop is
        // exercised directly here with the same recv/deadline shape.
        let first = rx.recv().unwrap();
        let mut batch = vec![first];
        let deadline = Instant::now() + FLUSH_WINDOW;
        while batch.len() < MAX_BATCH {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            match rx.recv_timeout(deadline - now) {
                Ok(f) => batch.push(f),
                Err(_) => break,
            }
        }
        assert_eq!(batch.len(), 5, "all five frames should ride in one batch");
    }
}
