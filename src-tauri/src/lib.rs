mod editor;
mod git;
mod pty;
mod store;

use git::Worktree;
use pty::PtyManager;
use serde_json::Value;
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Manager, RunEvent, State};

// ---------- PTY commands ----------

/// Open a PTY and begin streaming its output over `on_data`.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn start_pty(
    app: AppHandle,
    manager: State<PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    cwd: Option<String>,
    run: Option<String>,
    on_data: Channel<Response>,
) -> Result<(), String> {
    manager.spawn(app, id, cols, rows, shell, cwd, run, on_data)
}

/// Forward keystrokes to a PTY.
#[tauri::command]
fn write_pty(manager: State<PtyManager>, id: String, data: String) -> Result<(), String> {
    manager.write(&id, &data)
}

/// Resize a PTY.
#[tauri::command]
fn resize_pty(manager: State<PtyManager>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    manager.resize(&id, cols, rows)
}

/// Kill a PTY session.
#[tauri::command]
fn kill_pty(manager: State<PtyManager>, id: String) {
    manager.kill(&id);
}

// ---------- Git worktree commands ----------

#[tauri::command]
fn create_worktree(
    repo: String,
    branch: String,
    base_ref: Option<String>,
) -> Result<Worktree, String> {
    git::create_worktree(&repo, &branch, base_ref)
}

#[tauri::command]
fn list_worktrees(repo: String) -> Result<Vec<Worktree>, String> {
    git::list_worktrees(&repo)
}

#[tauri::command]
fn remove_worktree(
    repo: String,
    worktree_path: String,
    delete_branch: Option<String>,
) -> Result<(), String> {
    git::remove_worktree(&repo, &worktree_path, delete_branch)
}

#[tauri::command]
fn is_git_repo(path: String) -> bool {
    git::is_git_repo(&path)
}

// ---------- Persistence commands ----------

#[tauri::command]
fn load_state(app: AppHandle) -> Result<Value, String> {
    store::load(&app)
}

#[tauri::command]
fn save_state(app: AppHandle, state: Value) -> Result<(), String> {
    store::save(&app, state)
}

/// Whether Claude Code has a persisted conversation for this session id.
#[tauri::command]
fn claude_session_exists(session_id: String) -> bool {
    store::claude_session_exists(&session_id)
}

// ---------- Editor commands ----------

/// Open a folder in an external editor ("vscode" | "intellij").
#[tauri::command]
fn open_in_editor(path: String, editor: String) -> Result<(), String> {
    editor::open_in_editor(&path, &editor)
}

// ---------- Asset protocol ----------

/// Grant the asset protocol read access to a single file at runtime.
///
/// The static `assetProtocol.scope` is empty; instead the UI calls this for the
/// specific files a user attaches, so the webview can only ever load images the
/// user explicitly picked — never the whole filesystem.
#[tauri::command]
fn allow_asset(app: AppHandle, path: String) -> Result<(), String> {
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(PtyManager::default())
        .invoke_handler(tauri::generate_handler![
            start_pty,
            write_pty,
            resize_pty,
            kill_pty,
            create_worktree,
            list_worktrees,
            remove_worktree,
            is_git_repo,
            load_state,
            save_state,
            claude_session_exists,
            open_in_editor,
            allow_asset
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Ensure no child processes are orphaned when the app quits.
            if let RunEvent::ExitRequested { .. } = event {
                let manager: State<PtyManager> = app_handle.state();
                manager.kill_all();
            }
        });
}
