//! Headless Claude Code sessions for the Chat view.
//!
//! The terminal view runs `claude` inside a PTY and reads its screen. The Chat view runs
//! the same CLI with `--print --input-format stream-json --output-format stream-json`:
//! one JSON object per line on stdout, one per line on stdin. This module owns the
//! process and nothing else — every line is forwarded to the webview as a `chat-line`
//! event and parsed there, and every line the UI wants to send is written verbatim to
//! stdin. Keeping the protocol out of Rust means a CLI upgrade that adds a message type
//! needs no rebuild.
//!
//! The session persists on disk exactly as a terminal session does (same `--session-id`
//! / `--resume`, same per-agent Claude home), so a pane can switch between the two views
//! and `claude --resume <id>` keeps working.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Environment variables a Claude session leaves behind for its children. Codesu itself
/// may be running under Claude Code; the sessions it starts must not look nested.
const CLAUDE_SESSION_MARKERS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "CLAUDE_PROJECT_DIR",
];

/// Where package managers put `claude` when the inherited PATH is the bare GUI one.
const FALLBACK_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/opt/homebrew/opt/node/bin",
];

struct Proc {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    pid: u32,
}

#[derive(Default)]
pub struct ChatManager {
    procs: Arc<Mutex<HashMap<String, Proc>>>,
}

#[derive(Serialize, Clone)]
struct LinePayload<'a> {
    id: &'a str,
    line: &'a str,
}

#[derive(Serialize, Clone)]
struct ExitPayload<'a> {
    id: &'a str,
    code: Option<i32>,
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// Locate the `claude` binary once per process: inherited PATH, then the login shell's
/// PATH (a GUI app launched from the Dock does not have it), then the usual folders.
fn claude_bin() -> Result<PathBuf, String> {
    static BIN: OnceLock<Option<PathBuf>> = OnceLock::new();
    BIN.get_or_init(|| {
        let from_path = |var: &str| {
            var.split(':')
                .filter(|d| !d.is_empty())
                .map(|d| Path::new(d).join("claude"))
                .find(|p| is_executable(p))
        };
        if let Some(p) = std::env::var("PATH").ok().and_then(|v| from_path(&v)) {
            return Some(p);
        }
        if let Some(home) = std::env::var_os("HOME") {
            let local = Path::new(&home).join(".local/bin/claude");
            if is_executable(&local) {
                return Some(local);
            }
        }
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        if let Ok(out) = Command::new(&shell).args(["-lc", "command -v claude"]).output() {
            let line = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let candidate = PathBuf::from(&line);
            if out.status.success() && !line.is_empty() && is_executable(&candidate) {
                return Some(candidate);
            }
        }
        FALLBACK_DIRS
            .iter()
            .map(|d| Path::new(d).join("claude"))
            .find(|p| is_executable(p))
    })
    .clone()
    .ok_or_else(|| "Couldn't find the `claude` command. Install Claude Code or add it to your PATH.".to_string())
}

fn sigterm(pid: u32) {
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGTERM);
    }
}

impl ChatManager {
    /// Spawn `claude <args>` in `cwd` and start forwarding its stdout lines.
    ///
    /// A running process under the same id is replaced: it is stopped first, and its
    /// reader is told not to announce an exit (the UI only cares about the live one).
    pub fn start(
        &self,
        app: AppHandle,
        id: String,
        cwd: String,
        args: Vec<String>,
        env: Option<HashMap<String, String>>,
    ) -> Result<(), String> {
        let dir = PathBuf::from(cwd.trim());
        if !dir.is_dir() {
            return Err(format!("the folder no longer exists: {}", dir.display()));
        }
        let bin = claude_bin()?;
        let mut cmd = Command::new(bin);
        cmd.args(&args)
            .current_dir(&dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for key in CLAUDE_SESSION_MARKERS {
            cmd.env_remove(key);
        }
        // Keep the UI's own terminal width out of it; the CLI wraps nothing in print mode.
        cmd.env("TERM", "dumb");
        for (k, v) in env.into_iter().flatten() {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().map_err(|e| format!("failed to start claude: {e}"))?;
        let pid = child.id();
        let stdin = child.stdin.take().ok_or("claude has no stdin")?;
        let stdout = child.stdout.take().ok_or("claude has no stdout")?;
        let stderr = child.stderr.take().ok_or("claude has no stderr")?;

        // Replace any earlier process for this id.
        if let Some(old) = self.procs.lock().unwrap().remove(&id) {
            stop_proc(old);
        }

        // stdout: one JSON line per event, forwarded as-is.
        let app_out = app.clone();
        let id_out = id.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                let _ = app_out.emit("chat-line", LinePayload { id: &id_out, line: &line });
            }
        });
        // stderr: the CLI's own complaints (not logged in, bad flag) — shown by the UI.
        let app_err = app.clone();
        let id_err = id.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                let _ = app_err.emit("chat-stderr", LinePayload { id: &id_err, line: &line });
            }
        });

        self.procs.lock().unwrap().insert(
            id.clone(),
            Proc { child, stdin: Arc::new(Mutex::new(stdin)), pid },
        );

        // Exit watcher. It must REAP the child (`try_wait`), not just probe the pid: an
        // exited child stays a zombie until something waits on it, and `kill(pid, 0)`
        // keeps answering "alive" for a zombie — so a probe loop would never end and a
        // CLI that died (logged out, crashed) would look like it was still running.
        let procs_app = app;
        let id_exit = id;
        let procs = Arc::clone(&self.procs);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(250));
            let done = {
                let mut procs = procs.lock().unwrap();
                match procs.get_mut(&id_exit) {
                    // Only the live process for this id may report; a replaced one was
                    // already removed from the map by `start`/`stop` (and is reaped there).
                    Some(p) if p.pid == pid => match p.child.try_wait() {
                        Ok(Some(status)) => {
                            procs.remove(&id_exit);
                            Some(status.code())
                        }
                        Ok(None) => None,
                        Err(_) => {
                            procs.remove(&id_exit);
                            Some(None)
                        }
                    },
                    _ => break,
                }
            };
            if let Some(code) = done {
                let _ = procs_app.emit("chat-exit", ExitPayload { id: &id_exit, code });
                break;
            }
        });
        Ok(())
    }

    /// Write one line (a JSON object) to the session's stdin.
    pub fn send(&self, id: &str, line: &str) -> Result<(), String> {
        let stdin = {
            let procs = self.procs.lock().unwrap();
            let p = procs.get(id).ok_or("this chat session is not running")?;
            Arc::clone(&p.stdin)
        };
        let mut w = stdin.lock().unwrap();
        w.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        w.write_all(b"\n").map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())
    }

    /// End the session: close stdin (the CLI exits once its queue drains), then SIGTERM
    /// after a grace period so a stuck process never lingers.
    pub fn stop(&self, id: &str) {
        if let Some(p) = self.procs.lock().unwrap().remove(id) {
            stop_proc(p);
        }
    }

    /// Stop every session before the app exits. Unlike `stop`, this WAITS: the process
    /// is about to end, and a session still mid-turn would otherwise be orphaned with
    /// nobody left to kill it (the PTY side's `kill_all` has the same shape).
    pub fn stop_all(&self) {
        let all: Vec<Proc> = self.procs.lock().unwrap().drain().map(|(_, p)| p).collect();
        let mut children = Vec::new();
        for p in all {
            drop(p.stdin);
            sigterm(p.pid);
            children.push(p.child);
        }
        let deadline = Instant::now() + Duration::from_millis(1500);
        while Instant::now() < deadline && children.iter_mut().any(|c| matches!(c.try_wait(), Ok(None))) {
            std::thread::sleep(Duration::from_millis(50));
        }
        for mut c in children {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

fn stop_proc(mut p: Proc) {
    // Dropping the writer closes stdin.
    drop(p.stdin);
    let pid = p.pid;
    // `try_wait`, not a pid probe: an exited child is a zombie until reaped and a probe
    // would call it alive for the whole grace period.
    std::thread::spawn(move || {
        let exited = |c: &mut Child| !matches!(c.try_wait(), Ok(None));
        let deadline = Instant::now() + Duration::from_millis(1500);
        while !exited(&mut p.child) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        if !exited(&mut p.child) {
            sigterm(pid);
        }
        let deadline = Instant::now() + Duration::from_millis(1500);
        while !exited(&mut p.child) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = p.child.kill();
        let _ = p.child.wait();
    });
}
