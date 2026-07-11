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

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc;
use std::sync::Mutex;
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
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// OS pid of the spawned shell — used to send a graceful SIGTERM (so an inner
    /// `claude` gets SIGHUP and flushes its session) before we force-kill.
    pid: Option<u32>,
}

/// Grace period between SIGTERM and SIGKILL.
const KILL_GRACE: Duration = Duration::from_millis(1800);

/// Send SIGTERM to a process and its group so an interactive child (claude) is hung up.
fn term(pid: u32) {
    let p = pid as i32;
    unsafe {
        libc::kill(p, libc::SIGTERM);
        // Also the process group, to reach the foreground job (claude) directly.
        libc::kill(-p, libc::SIGHUP);
    }
}

/// Owns every live session. Registered in Tauri managed state.
#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
}

/// Coalescer tuning.
const READ_BUF: usize = 8192;
const MAX_BATCH: usize = 64 * 1024;
const FLUSH_WINDOW: Duration = Duration::from_millis(8);

impl PtyManager {
    /// Open a PTY, spawn the shell, and start streaming output over `on_data`.
    ///
    /// If `run` is provided it is typed into the shell (with a trailing newline) so the
    /// agent's program (e.g. `claude`) launches with the login shell's full PATH — this
    /// is more robust than spawning the program directly, whose PATH depends on how the
    /// app itself was launched.
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
        on_data: Channel<Response>,
    ) -> Result<(), String> {
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
        match cwd.filter(|d| !d.is_empty()) {
            Some(dir) => cmd.cwd(dir),
            None => {
                if let Ok(home) = std::env::var("HOME") {
                    cmd.cwd(home);
                }
            }
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

        // reader -> flusher hand-off.
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let exit_id = id.clone();

        // Reader thread: blocking reads, push chunks downstream.
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
            // Reap the child so it doesn't linger as a zombie, then notify the frontend.
            let status = child.wait();
            let code = status.ok().map(|s| s.exit_code());
            let _ = app.emit("session-exited", ExitPayload { id: exit_id, code });
        });

        let session = PtySession {
            master,
            writer,
            killer,
            pid,
        };
        self.sessions.lock().unwrap().insert(id, session);
        Ok(())
    }

    /// Forward keystrokes (a UTF-8 string incl. control/escape sequences) to the PTY.
    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let s = sessions.get_mut(id).ok_or("no such session")?;
        s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        s.writer.flush().map_err(|e| e.to_string())
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
        if let Some(mut s) = self.sessions.lock().unwrap().remove(id) {
            if let Some(pid) = s.pid {
                term(pid);
            }
            thread::spawn(move || {
                thread::sleep(KILL_GRACE);
                let _ = s.killer.kill();
            });
        }
    }

    /// Stop every child on app exit — SIGTERM all so `claude` sessions persist, wait once,
    /// then SIGKILL any survivors so no orphans remain.
    pub fn kill_all(&self) {
        let mut sessions: Vec<PtySession> =
            self.sessions.lock().unwrap().drain().map(|(_, s)| s).collect();
        for s in &sessions {
            if let Some(pid) = s.pid {
                term(pid);
            }
        }
        thread::sleep(KILL_GRACE);
        for s in &mut sessions {
            let _ = s.killer.kill();
        }
    }
}
