//! PTY backend for the terminal hot path.
//!
//! Each session opens a pseudo-terminal, spawns a command on the slave, and streams
//! the master's output to the frontend as RAW bytes over a `tauri::ipc::Channel`.
//! Two threads per session:
//!
//! - reader  — blocking reads from the PTY master (portable-pty's reader is sync I/O),
//! - flusher — coalesces bursts into ~8ms / 64KB batches before crossing the IPC boundary.
//!
//! Coalescing is the key perf lever against Claude Code's bursty, colored output.
//!
//! The process-lifecycle primitives here — `term`, `kill9`, `alive`, `wait_for_exit`,
//! `KILL_GRACE` — plus `resolve_cwd` and `CLAUDE_SESSION_MARKERS` are `pub(crate)`
//! because [`crate::agent`] (the headless backend) needs exactly the same semantics:
//! SIGTERM so `claude` flushes its session, SIGKILL only after the grace period, and a
//! cwd that must exist rather than silently becoming `$HOME`. They are deliberately NOT
//! duplicated — a divergence between the two shutdown paths is how children get orphaned.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter};

/// Emitted to the frontend when a session's child process exits.
#[derive(Clone, serde::Serialize)]
struct ExitPayload {
    id: String,
    code: Option<u32>,
}

/// A live PTY-backed session. Holds the master (for resize), a writer (for keystrokes),
/// and a killer to terminate the child on demand or at app exit.
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    /// Behind its OWN lock, deliberately: a pty write blocks for as long as the child
    /// refuses to drain its input, and that must never be done while holding the lock
    /// over the session map (see `PtyManager::write`).
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// OS pid of the spawned shell — used to send a graceful SIGTERM (so an inner
    /// `claude` gets SIGHUP and flushes its session) before we force-kill.
    pid: Option<u32>,
    /// Whether this session's flusher may still announce `session-exited`.
    ///
    /// Cleared when the session is displaced by a respawn under the same id: the dying
    /// child's exit would otherwise be reported under an id its *replacement* now owns,
    /// and the frontend would mark a freshly-started agent as exited.
    announce_exit: Arc<AtomicBool>,
}

/// Grace period between SIGTERM and SIGKILL.
pub(crate) const KILL_GRACE: Duration = Duration::from_millis(1800);
/// How often the grace period is re-checked while waiting for children to exit.
const KILL_POLL: Duration = Duration::from_millis(25);

/// Send SIGTERM to a process and its group so an interactive child (claude) is hung up.
pub(crate) fn term(pid: u32) {
    let p = pid as i32;
    unsafe {
        libc::kill(p, libc::SIGTERM);
        // Also the process group, to reach the foreground job (claude) directly.
        libc::kill(-p, libc::SIGHUP);
    }
}

/// Force-kill a process and its group.
///
/// This is the escalation `term` promises and portable-pty does NOT provide:
/// `ChildKiller::kill` sends SIGHUP, which is exactly the signal the child has already
/// been ignoring for a full grace period by the time we get here.
pub(crate) fn kill9(pid: u32) {
    let p = pid as i32;
    unsafe {
        libc::kill(p, libc::SIGKILL);
        // Mirror `term`: the foreground job lives in the shell's process group.
        libc::kill(-p, libc::SIGKILL);
    }
}

/// Whether `pid` still names a live process — signal 0 runs the kernel's existence and
/// permission checks without delivering anything.
///
/// Used both to poll for exit and as a pid-reuse guard before escalating. It is a cheap
/// guard, not a proof: a child that has already been reaped could in principle have had
/// its pid recycled within the grace period, and a child that has exited but not yet been
/// reaped still answers `true` (signalling a zombie is a harmless no-op).
pub(crate) fn alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

/// Wait until every pid in `pids` has gone, giving up after `grace`.
///
/// Polled rather than slept: this runs inside the app's `ExitRequested` callback, where a
/// flat sleep beachballs the quit for the full grace period even when every child is
/// already gone — or when there are no children at all, in which case this returns without
/// sleeping once.
pub(crate) fn wait_for_exit(pids: &[u32], grace: Duration) {
    let deadline = Instant::now() + grace;
    while pids.iter().any(|&pid| alive(pid)) {
        let now = Instant::now();
        if now >= deadline {
            return;
        }
        thread::sleep(KILL_POLL.min(deadline - now));
    }
}

/// Stop one session: SIGTERM now (so `claude` flushes its session), SIGKILL whatever is
/// still alive once the grace period is up. The wait happens off-thread so no caller —
/// and in particular no Tauri command on the main thread — ever blocks on it.
fn terminate(mut s: PtySession) {
    let Some(pid) = s.pid else {
        // portable-pty could not report a pid, so the killer's SIGHUP is all we have.
        let _ = s.killer.kill();
        return;
    };
    term(pid);
    thread::spawn(move || {
        wait_for_exit(&[pid], KILL_GRACE);
        if alive(pid) {
            kill9(pid);
        }
        // Held until now so the pty master stays open for the whole grace period, exactly
        // as it did before; dropping the session here closes it.
        drop(s);
    });
}

/// Owns every live session. Registered in Tauri managed state.
#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
}

/// Environment variables Claude Code stamps onto every process it spawns, to tell a
/// nested `claude` that it is a CHILD of a running session.
///
/// They matter to us because `CommandBuilder::new` seeds the child environment from our
/// own (`get_base_env`), so anything codesu inherited is handed to every pane. If codesu
/// is itself launched from a Claude Code session — `claude` running `pnpm tauri dev`, or
/// the app started from an agent's shell — then EVERY agent in the app looks like a child
/// session and degrades: transcript saving off (so `--resume` can't find the session),
/// and the parent's session id / pid / effort misreported as its own.
///
/// A codesu pane is a top-level session that happens to live in a GUI, so the marker is
/// wrong. Claude Code does exactly this itself before spawning stdio MCP servers, where
/// it destructures `CLAUDE_CODE_CHILD_SESSION` out of the inherited environment.
///
/// Only session-scoped markers are removed. Real configuration (`ANTHROPIC_*`,
/// `CLAUDE_CODE_USE_BEDROCK`, and every other `CLAUDE_CODE_*` setting) is left alone —
/// the user set those deliberately and they must reach the agent.
pub(crate) const CLAUDE_SESSION_MARKERS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "AI_AGENT",
    // Tracing/project context that would otherwise pin every pane to the launching
    // session's trace and project directory.
    "TRACEPARENT",
    "CLAUDE_PROJECT_DIR",
];

/// Drop every inherited {@link CLAUDE_SESSION_MARKERS} entry so the pane's `claude` is a
/// fresh top-level session rather than a child of whatever launched codesu.
fn scrub_claude_session_markers(cmd: &mut CommandBuilder) {
    for key in CLAUDE_SESSION_MARKERS {
        cmd.env_remove(key);
    }
}

/// Decide the directory to start a session in.
///
/// `Some(dir)` must exist: portable-pty SILENTLY drops a cwd that isn't a directory and
/// starts the shell in `$HOME` instead (`CommandBuilder::as_command` filters on `is_dir`).
/// That fallback is a trap — an agent whose workspace folder was moved, or whose worktree
/// was deleted, would quietly launch `claude` in the home directory, so Claude Code asked
/// to trust `~` on every open and never remembered the answer (`~` is not the project).
/// So a missing directory is an error the UI can show, not a silent redirect.
///
/// `None` (the system terminal, which has no workspace) legitimately means `$HOME`.
pub(crate) fn resolve_cwd(cwd: Option<String>) -> Result<Option<String>, String> {
    match cwd.map(|d| d.trim().to_string()).filter(|d| !d.is_empty()) {
        Some(dir) => {
            if std::path::Path::new(&dir).is_dir() {
                Ok(Some(dir))
            } else {
                Err(format!("Folder not found: {dir}"))
            }
        }
        None => Ok(std::env::var("HOME").ok()),
    }
}

/// Coalescer tuning.
const READ_BUF: usize = 8192;
const MAX_BATCH: usize = 64 * 1024;
const FLUSH_WINDOW: Duration = Duration::from_millis(8);
/// Depth of the reader → flusher queue, in chunks.
///
/// Bounded on purpose. A runaway child (`yes`, `cat` of a huge file) produces far faster
/// than the IPC boundary can absorb, and an unbounded queue simply turns that into
/// megabytes per second of resident memory per pane. Blocking the reader on a full queue
/// is the backpressure: the kernel's pty buffer fills, and the child blocks in `write`,
/// which is precisely what a real terminal does.
const QUEUE_DEPTH: usize = 64;

/// Drain the reader's queue into the frontend channel, coalescing bursts into
/// ~`FLUSH_WINDOW` / `MAX_BATCH` batches. Returns when either end goes away.
///
/// Takes `rx` BY VALUE so the receiver is dropped the moment draining stops. That is
/// load-bearing: if the frontend channel dies (a webview reload) while the receiver stayed
/// alive, the reader would go on filling a queue nobody reads — leaking a thread and, with
/// a bounded queue, wedging that thread on a send that can never complete.
fn pump(rx: mpsc::Receiver<Vec<u8>>, on_data: &Channel<Response>) {
    // Block until the first chunk; exit when the reader disconnects.
    while let Ok(mut batch) = rx.recv() {
        let deadline = Instant::now() + FLUSH_WINDOW;
        while batch.len() < MAX_BATCH {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            match rx.recv_timeout(deadline - now) {
                Ok(c) => batch.extend_from_slice(&c),
                Err(_) => break, // timeout or disconnect -> flush what we have
            }
        }
        if on_data.send(Response::new(batch)).is_err() {
            break; // frontend channel dropped
        }
    }
}

impl PtyManager {
    /// Open a PTY, spawn the shell, and start streaming output over `on_data`.
    ///
    /// If `run` is provided it is typed into the shell (with a trailing newline) so the
    /// agent's program (e.g. `claude`) launches with the login shell's full PATH — this
    /// is more robust than spawning the program directly, whose PATH depends on how the
    /// app itself was launched.
    ///
    /// A `cwd` that no longer exists is an ERROR, never a silent fallback: launching an
    /// agent in the wrong directory is worse than not launching it at all.
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        &self,
        app: AppHandle,
        id: String,
        cols: u16,
        rows: u16,
        shell: Option<String>,
        cwd: Option<String>,
        run: Option<String>,
        env: Option<HashMap<String, String>>,
        on_data: Channel<Response>,
    ) -> Result<(), String> {
        // Resolved FIRST: a workspace folder that has gone away fails the whole call
        // before any pty is allocated, and the caller shows the message in the pane.
        let dir = resolve_cwd(cwd)?;

        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        // Build the command — default to the user's login shell.
        let shell = shell
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var("SHELL").ok())
            .unwrap_or_else(|| "/bin/bash".into());
        let mut cmd = CommandBuilder::new(shell);
        cmd.env("TERM", "xterm-256color");
        // The child env is seeded from ours, so anything codesu inherited leaks into every
        // agent. Session markers must not (see CLAUDE_SESSION_MARKERS).
        scrub_claude_session_markers(&mut cmd);
        // Caller-supplied overrides go on LAST so they win over both the inherited
        // environment and the scrub above. This is how an agent is pointed at its own
        // Claude home (see `claude_home`), which is what keeps one agent's typed-prompt
        // history out of another's ↑ list.
        for (key, value) in env.into_iter().flatten() {
            cmd.env(key, value);
        }
        if let Some(dir) = dir {
            cmd.cwd(dir);
        }

        let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        let killer = child.clone_killer();
        let pid = child.process_id();

        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        // Drop the slave so the reader sees EOF once the child exits.
        drop(pair.slave);
        let master = pair.master;

        // Optionally auto-run a command (typed-ahead; the PTY buffers it until the shell reads).
        if let Some(cmd) = run.filter(|c| !c.trim().is_empty()) {
            let line = format!("{cmd}\n");
            let _ = writer.write_all(line.as_bytes());
            let _ = writer.flush();
        }

        // reader -> flusher hand-off, bounded so a runaway child can't outrun the IPC
        // boundary into unbounded memory (see QUEUE_DEPTH).
        let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(QUEUE_DEPTH);
        let exit_id = id.clone();
        let announce_exit = Arc::new(AtomicBool::new(true));
        let may_announce = Arc::clone(&announce_exit);

        // Reader thread: blocking reads, push chunks downstream. A send blocks while the
        // queue is full (that IS the backpressure) and fails once the flusher has dropped
        // the receiver, which is how this thread learns to stop.
        thread::spawn(move || {
            let mut buf = [0u8; READ_BUF];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF: child exited / pty closed
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break; // flusher gone
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // Flusher thread: coalesce bursts, then send as raw bytes to the frontend.
        thread::spawn(move || {
            // `pump` owns the receiver, so it is gone the instant draining stops and the
            // reader thread unblocks and exits — before the (possibly long) wait below.
            pump(rx, &on_data);
            // Reap the child so it doesn't linger as a zombie, then notify the frontend.
            let status = child.wait();
            let code = status.ok().map(|s| s.exit_code());
            // Silent if this session has since been displaced — the id belongs to a
            // different, live child now (see PtySession::announce_exit).
            if may_announce.load(Ordering::SeqCst) {
                let _ = app.emit("session-exited", ExitPayload { id: exit_id, code });
            }
        });

        let session = PtySession {
            master,
            writer: Arc::new(Mutex::new(writer)),
            killer,
            pid,
            announce_exit,
        };
        // An id is only reused if the frontend lost track of a session it never killed.
        // Dropping the displaced entry would leave its child running with nothing left to
        // stop it, so it is terminated on the way out — muted first, so its exit isn't
        // reported against the id the session just installed above now owns.
        if let Some(displaced) = self.sessions.lock().unwrap().insert(id, session) {
            displaced.announce_exit.store(false, Ordering::SeqCst);
            terminate(displaced);
        }
        Ok(())
    }

    /// Forward keystrokes (a UTF-8 string incl. control/escape sequences) to the PTY.
    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        // The map lock is held only long enough to clone the writer handle. A pty write
        // blocks for as long as the child declines to read its input, and Tauri runs sync
        // commands on the main thread — holding the map lock across the write would stall
        // resize/kill/kill_all/spawn behind it, i.e. deadlock the whole app.
        let writer = {
            let sessions = self.sessions.lock().unwrap();
            let s = sessions.get(id).ok_or("no such session")?;
            Arc::clone(&s.writer)
        };
        let mut writer = writer.lock().unwrap();
        writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())
    }

    /// Resize the PTY (portable-pty issues the SIGWINCH equivalent internally).
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let s = sessions.get(id).ok_or("no such session")?;
        s.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }

    /// Gracefully stop a session: SIGTERM (so `claude` flushes its session), then
    /// SIGKILL after a short grace period. Runs the wait off-thread so the UI never blocks.
    pub fn kill(&self, id: &str) {
        if let Some(s) = self.sessions.lock().unwrap().remove(id) {
            terminate(s);
        }
    }

    /// Stop every child on app exit — SIGTERM all so `claude` sessions persist, wait for
    /// them to go, then SIGKILL any survivors so no orphans remain.
    ///
    /// Called from the `ExitRequested` callback, so the wait is a poll that returns the
    /// moment the last child is gone: with no sessions open, quitting costs nothing.
    pub fn kill_all(&self) {
        let mut sessions: Vec<PtySession> =
            self.sessions.lock().unwrap().drain().map(|(_, s)| s).collect();
        let pids: Vec<u32> = sessions.iter().filter_map(|s| s.pid).collect();
        for &pid in &pids {
            term(pid);
        }
        wait_for_exit(&pids, KILL_GRACE);
        for s in &mut sessions {
            match s.pid {
                // Still here after the full grace period, so it is not going to leave.
                Some(pid) if alive(pid) => kill9(pid),
                Some(_) => {}
                // No pid to signal; the killer's SIGHUP is the only lever we have.
                None => {
                    let _ = s.killer.kill();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The regression this guard exists for: portable-pty answers a missing cwd with
    /// `$HOME`. If this ever stops being true the guard is merely redundant, not wrong —
    /// but while it IS true, dropping the guard silently relocates agents to `~`, which
    /// is what made Claude Code re-ask to trust the home directory on every open.
    #[test]
    fn portable_pty_silently_falls_back_to_home() {
        let home = std::env::var("HOME").expect("HOME");
        let bogus = "/definitely/not/a/real/directory";

        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "pwd"]);
        cmd.cwd(bogus);
        // The builder still reports what we asked for; the substitution happens later,
        // when the command is actually built, which is why it is so easy to miss.
        assert_eq!(cmd.get_cwd().unwrap(), bogus);

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        let mut reader = pair.master.try_clone_reader().expect("reader");
        drop(pair.slave); // so the read below sees EOF once `pwd` has exited

        // A pty master often reports EIO rather than a clean EOF once the child is gone,
        // so any read error ends the loop; whatever arrived before it is the output.
        let mut out = Vec::new();
        let mut buf = [0u8; 1024];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            out.extend_from_slice(&buf[..n]);
        }
        let _ = child.wait();

        let printed = String::from_utf8_lossy(&out);
        assert!(
            printed.contains(home.trim_end_matches('/')),
            "expected the shell to land in {home} (got {printed:?}) — a missing cwd is \
             silently redirected, which is exactly what resolve_cwd must prevent"
        );
    }

    #[test]
    fn existing_dir_is_kept() {
        let tmp = std::env::temp_dir();
        let dir = tmp.to_str().unwrap().to_string();
        assert_eq!(resolve_cwd(Some(dir.clone())).unwrap(), Some(dir));
    }

    #[test]
    fn missing_dir_is_an_error_naming_the_path() {
        let err = resolve_cwd(Some("/definitely/not/a/real/directory".into())).unwrap_err();
        assert!(err.contains("/definitely/not/a/real/directory"), "got: {err}");
    }

    /// A file is not a working directory — and portable-pty would fall back to $HOME
    /// for it too, so it must be rejected just like a missing path.
    #[test]
    fn a_file_is_not_a_directory() {
        assert!(resolve_cwd(Some("/etc/hosts".into())).is_err());
    }

    /// No cwd is the system terminal, which has no workspace: $HOME is correct there.
    #[test]
    fn absent_or_blank_cwd_means_home() {
        let home = std::env::var("HOME").ok();
        assert_eq!(resolve_cwd(None).unwrap(), home);
        assert_eq!(resolve_cwd(Some("".into())).unwrap(), home);
        assert_eq!(resolve_cwd(Some("   ".into())).unwrap(), home);
    }

    /// The whole point of the scrub: a marker in OUR environment must not reach the pane,
    /// or every agent reports itself as a child session (transcript saving off, the
    /// parent's session id and pid misreported as its own).
    ///
    /// Both halves are asserted in one test because it mutates process-wide environment,
    /// which the other tests in this binary run alongside. For the same reason it stays
    /// off `CLAUDE_CODE_CHILD_SESSION`, which the end-to-end test below owns — two tests
    /// setting and unsetting one variable in parallel threads would be flaky.
    #[test]
    fn session_markers_are_scrubbed_but_real_config_survives() {
        // What Claude Code stamps on a child (KDt in the CLI bundle), minus the variable
        // the end-to-end test owns.
        std::env::set_var("CLAUDE_CODE_SESSION_ID", "parent-session-uuid");
        std::env::set_var("CLAUDECODE", "1");
        // ...next to a real setting the user chose, which must be left alone.
        std::env::set_var("CLAUDE_CODE_USE_BEDROCK", "1");

        // Built AFTER the vars are set, since `new` snapshots the environment.
        let mut cmd = CommandBuilder::new("/bin/sh");
        assert_eq!(
            cmd.get_env("CLAUDE_CODE_SESSION_ID").map(|v| v.to_str().unwrap()),
            Some("parent-session-uuid"),
            "precondition: the builder inherits our environment"
        );

        scrub_claude_session_markers(&mut cmd);

        for key in CLAUDE_SESSION_MARKERS {
            assert!(cmd.get_env(key).is_none(), "{key} should have been scrubbed");
        }
        assert_eq!(
            cmd.get_env("CLAUDE_CODE_USE_BEDROCK").map(|v| v.to_str().unwrap()),
            Some("1"),
            "user configuration must still reach the agent"
        );
        // TERM and friends are untouched by the scrub.
        assert!(cmd.get_env("PATH").is_some(), "PATH must survive");

        std::env::remove_var("CLAUDE_CODE_SESSION_ID");
        std::env::remove_var("CLAUDECODE");
        std::env::remove_var("CLAUDE_CODE_USE_BEDROCK");
    }

    /// Run a command in a real pty and return everything it printed.
    fn pty_output(mut cmd: CommandBuilder) -> String {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        cmd.cwd(std::env::temp_dir());
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        let mut reader = pair.master.try_clone_reader().expect("reader");
        drop(pair.slave);
        let mut out = Vec::new();
        let mut buf = [0u8; 1024];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            out.extend_from_slice(&buf[..n]);
        }
        let _ = child.wait();
        String::from_utf8_lossy(&out).into_owned()
    }

    /// End-to-end proof through a real pty, asserting BOTH directions — without the scrub
    /// the marker reaches the shell, with it the shell sees nothing. The negative half
    /// matters: it shows this test would actually fail if the scrub were removed, rather
    /// than passing vacuously.
    #[test]
    fn marker_reaches_the_shell_without_the_scrub_and_not_with_it() {
        std::env::set_var("CLAUDE_CODE_CHILD_SESSION", "1");
        let probe = r#"printf 'MARKER=[%s]' "$CLAUDE_CODE_CHILD_SESSION""#;

        let mut leaky = CommandBuilder::new("/bin/sh");
        leaky.args(["-c", probe]);
        let leaked = pty_output(leaky);

        let mut clean = CommandBuilder::new("/bin/sh");
        clean.args(["-c", probe]);
        scrub_claude_session_markers(&mut clean);
        let scrubbed = pty_output(clean);

        std::env::remove_var("CLAUDE_CODE_CHILD_SESSION");

        assert!(
            leaked.contains("MARKER=[1]"),
            "inherited env DOES reach the shell (this is the bug): {leaked:?}"
        );
        assert!(
            scrubbed.contains("MARKER=[]"),
            "the scrub must leave the shell with no marker: {scrubbed:?}"
        );
    }

    /// `kill_all` runs inside the app's ExitRequested callback, so this wait is on the
    /// critical path of every quit. With nothing to wait for it must not sleep at all —
    /// the flat `thread::sleep(KILL_GRACE)` it replaced beachballed the quit for 1.8s even
    /// with zero sessions open.
    #[test]
    fn waiting_on_no_children_returns_immediately() {
        let started = Instant::now();
        wait_for_exit(&[], KILL_GRACE);
        assert!(
            started.elapsed() < Duration::from_millis(50),
            "waited {:?} for nothing",
            started.elapsed()
        );
    }

    /// And a child that exits early ends the wait early, rather than serving the whole
    /// grace period out.
    #[test]
    fn waiting_ends_as_soon_as_the_child_is_gone() {
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .spawn()
            .expect("spawn");
        let pid = child.id();
        let _ = child.wait(); // reap, so the pid is genuinely gone

        let started = Instant::now();
        wait_for_exit(&[pid], KILL_GRACE);
        assert!(
            started.elapsed() < KILL_GRACE / 2,
            "waited {:?} for an already-dead child",
            started.elapsed()
        );
    }

    /// Paths arriving with stray whitespace (hand-edited state file) still resolve.
    #[test]
    fn surrounding_whitespace_is_trimmed() {
        let tmp = std::env::temp_dir();
        let padded = format!("  {}  ", tmp.to_str().unwrap());
        assert_eq!(
            resolve_cwd(Some(padded)).unwrap(),
            Some(tmp.to_str().unwrap().to_string())
        );
    }
}
