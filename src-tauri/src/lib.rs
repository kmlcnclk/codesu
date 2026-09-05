mod claude_home;
mod editor;
mod fsx;
mod git;
mod pty;
mod runner;
mod search;
mod store;
mod testing;

use fsx::{DirEntry, FileContent};
use git::{RepoStatus, Worktree};
use runner::Script;
use search::Hit;
use testing::TestTarget;
use pty::PtyManager;
use serde_json::Value;
use std::collections::HashMap;
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
    env: Option<HashMap<String, String>>,
    on_data: Channel<Response>,
) -> Result<(), String> {
    manager.spawn(app, id, cols, rows, shell, cwd, run, env, on_data)
}

/// Forward keystrokes to a PTY.
///
/// Deliberately NOT `(async)`, unlike the slow filesystem commands below. Sync commands
/// run on the main thread one after another, and that serialisation is what keeps
/// keystrokes in order — dispatched onto a thread pool, two rapid invokes could land
/// out of order and scramble what the user typed. The cost is that a child which has
/// stopped draining its input can stall this call (see PtyManager::write, which at
/// least keeps that stall off the session map so other panes stay killable).
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

#[tauri::command(async)]
fn create_worktree(
    repo: String,
    branch: String,
    base_ref: Option<String>,
) -> Result<Worktree, String> {
    git::create_worktree(&repo, &branch, base_ref)
}

#[tauri::command(async)]
fn list_worktrees(repo: String) -> Result<Vec<Worktree>, String> {
    git::list_worktrees(&repo)
}

#[tauri::command(async)]
fn remove_worktree(
    repo: String,
    worktree_path: String,
    delete_branch: Option<String>,
) -> Result<(), String> {
    git::remove_worktree(&repo, &worktree_path, delete_branch)
}

#[tauri::command(async)]
fn is_git_repo(path: String) -> bool {
    git::is_git_repo(&path)
}

/// Whether `path` is still an existing directory on disk.
///
/// The UI calls this for every live workspace so a folder that was moved, renamed or
/// (for worktrees) deleted is flagged in the sidebar instead of being discovered only
/// when an agent fails to spawn. See `PtyManager::spawn`.
#[tauri::command(async)]
fn dir_exists(path: String) -> bool {
    !path.trim().is_empty() && std::path::Path::new(path.trim()).is_dir()
}

// ---------- Review (git status / diff) commands ----------

/// Working-tree status of `repo` — the changed-file list the review panel shows.
#[tauri::command(async)]
fn git_status(repo: String) -> Result<RepoStatus, String> {
    git::status(&repo)
}

/// Unified diff for one path (`staged` reads the index, `untracked` diffs against
/// /dev/null — see `git::diff_file`).
#[tauri::command(async)]
fn git_diff_file(
    repo: String,
    path: String,
    staged: bool,
    untracked: bool,
) -> Result<String, String> {
    git::diff_file(&repo, &path, staged, untracked)
}

/// Diff of every tracked change at once.
#[tauri::command(async)]
fn git_diff_all(repo: String, staged: bool) -> Result<String, String> {
    git::diff_all(&repo, staged)
}

/// Stage or unstage one path.
#[tauri::command(async)]
fn git_stage_file(repo: String, path: String, staged: bool) -> Result<(), String> {
    git::stage_file(&repo, &path, staged)
}

// ---------- Run commands ----------

/// Every command the workspace can run (package.json scripts, make targets, …).
/// Discovery only — the chosen script is executed by the UI through a normal PTY.
#[tauri::command(async)]
fn discover_scripts(root: String) -> Result<Vec<Script>, String> {
    runner::discover(&root)
}

/// The command that runs one test — what the editor's Run-gutter arrow clicks.
///
/// The UI finds the tests in the buffer it already has; this resolves the build tool,
/// sub-project and package manager off disk and hands back a `Script` the Run panel types
/// into its shell, exactly like a discovered one.
#[tauri::command(async)]
fn resolve_test_command(root: String, file: String, target: TestTarget) -> Result<Script, String> {
    testing::resolve(&root, &file, &target)
}

// ---------- Search commands ----------

/// Search the workspace for `query`: `kind` is "file" (by name/path), "symbol" (by
/// declaration) or "text" (a grep). Results come back ranked, best first.
#[tauri::command(async)]
fn search_workspace(
    root: String,
    query: String,
    kind: String,
    limit: Option<usize>,
) -> Result<Vec<Hit>, String> {
    search::search(&root, &query, &kind, limit.unwrap_or(60))
}

/// Build the search index up front (called when the Code view opens).
#[tauri::command(async)]
fn warm_search_index(root: String) {
    search::warm(&root)
}

/// Drop the cached search index for a workspace (the file tree's refresh button).
#[tauri::command(async)]
fn invalidate_search_index(root: String) {
    search::invalidate(&root)
}

// ---------- Built-in editor filesystem commands ----------

/// One directory level inside the workspace (the file tree loads lazily).
#[tauri::command(async)]
fn list_dir(root: String, path: String) -> Result<Vec<DirEntry>, String> {
    fsx::list_dir(&root, &path)
}

/// Read a workspace file into the editor.
#[tauri::command(async)]
fn read_text_file(root: String, path: String) -> Result<FileContent, String> {
    fsx::read_text_file(&root, &path)
}

/// Save an edited buffer back to disk, refusing if the file changed underneath it.
#[tauri::command(async)]
fn write_text_file(
    root: String,
    path: String,
    content: String,
    expect_modified_ms: Option<u64>,
) -> Result<u64, String> {
    fsx::write_text_file(&root, &path, &content, expect_modified_ms)
}

/// Persist a pasted image to a temp file so an agent can be handed a path to read.
#[tauri::command(async)]
fn save_pasted_file(data_b64: String, ext: String) -> Result<String, String> {
    fsx::save_pasted_file(&data_b64, &ext)
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

// ---------- Per-agent Claude home commands ----------

/// Environment that gives this agent its OWN Claude Code prompt history.
///
/// Claude Code scopes the ↑ / ⌃R history to the project directory, so sibling agents in
/// one workspace would otherwise complete from each other's prompts. Returns the env vars
/// `start_pty` should spawn the agent's shell with; see `claude_home` for what is isolated
/// and what stays shared. An `Err` means "launch with the shared config dir" — never a
/// reason to refuse to start an agent.
#[tauri::command(async)]
fn claude_agent_env(
    agent_id: String,
    session_id: Option<String>,
) -> Result<HashMap<String, String>, String> {
    claude_home::prepare(&agent_id, session_id.as_deref())
}

/// Drop the per-agent Claude homes of agents that no longer exist. Called once at startup
/// with every live agent id.
#[tauri::command(async)]
fn prune_claude_homes(live_agent_ids: Vec<String>) -> Result<(), String> {
    claude_home::prune(&live_agent_ids)
}

// ---------- Editor commands ----------

/// Open a folder in an external editor ("vscode" | "intellij").
#[tauri::command(async)]
fn open_in_editor(path: String, editor: String) -> Result<(), String> {
    editor::open_in_editor(&path, &editor)
}

// ---------- Asset protocol ----------

/// File types the asset protocol may ever be opened up for: the image extensions the
/// attachment UI renders as thumbnails (`IMAGE_EXTS` in `src/lib/store/app.svelte.ts`)
/// plus `pdf`, the one non-image attachment worth previewing.
const ATTACHMENT_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "heic", "pdf",
];

/// Whether `path` ends in an extension the webview is allowed to load.
fn is_attachment(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .is_some_and(|e| ATTACHMENT_EXTENSIONS.contains(&e.as_str()))
}

/// Grant the asset protocol read access to a single file at runtime.
///
/// The static `assetProtocol.scope` is empty; instead the UI calls this for the
/// specific files a user attaches, so the webview can only ever load images the
/// user explicitly picked — never the whole filesystem.
///
/// The path is NOT taken on trust. This command is reachable from anything running in the
/// webview, and a grant is permanent for the life of the process, so a bare `allow_file`
/// would let one stray call hand the renderer `~/.ssh/id_rsa`. Three things are checked:
///
///   - the path is absolute (a relative one would resolve against the app's cwd),
///   - it resolves — following any symlink — to an existing REGULAR file, never a
///     directory, device or dangling link,
///   - both the link and its target carry an attachment extension, so a `shot.png`
///     pointing at a private key is rejected on what it actually opens.
///
/// The original (unresolved) path is what gets granted, because that is the path the UI
/// hands to `convertFileSrc`.
#[tauri::command]
fn allow_asset(app: AppHandle, path: String) -> Result<(), String> {
    let path = std::path::Path::new(path.trim());
    if !path.is_absolute() {
        return Err(format!("attachment path must be absolute: {}", path.display()));
    }
    let target = std::fs::canonicalize(path)
        .map_err(|e| format!("cannot resolve attachment {}: {e}", path.display()))?;
    if !target.is_file() {
        return Err(format!("not a regular file: {}", path.display()));
    }
    if !is_attachment(path) || !is_attachment(&target) {
        return Err(format!("unsupported attachment type: {}", path.display()));
    }
    app.asset_protocol_scope()
        .allow_file(path)
        .map_err(|e| e.to_string())
}

/// Read one attached file as text, for the in-app viewer.
///
/// Deliberately NOT `read_text_file`: that one is scoped to a workspace root, and an
/// attachment routinely lives outside every workspace (a README dragged in from
/// another checkout). Same size and binary guards; `refused` tells the UI to offer the
/// system opener instead of pretending it can show the file.
#[tauri::command]
fn read_attachment(path: String) -> Result<FileContent, String> {
    fsx::read_attachment(&path)
}

/// Extensions we refuse to hand to the system opener.
///
/// Opening a file with its default application is a "run this" gesture for anything
/// the OS treats as executable, and this command is reachable from the webview. Images
/// and documents are the point of the feature; scripts and app bundles are not.
const UNOPENABLE_EXTENSIONS: &[&str] = &[
    "app", "command", "sh", "bash", "zsh", "csh", "fish", "scpt", "scptd", "applescript",
    "workflow", "action", "shortcut", "pkg", "mpkg", "dmg", "term", "webloc", "url",
    "inetloc", "jar", "exe", "bat", "cmd", "com", "msi", "ps1", "vbs", "vbe", "js", "jse",
    "wsf", "wsh", "scr", "cpl", "hta", "reg", "lnk",
];

/// Open one attached file with the system's default application.
///
/// This exists instead of the opener plugin's JS API because that API is gated by a
/// STATIC path scope in the capability file, and attachments live anywhere on disk —
/// the scope would have to be `**` to cover them, which hands the whole filesystem to
/// anything running in the webview. Routing through Rust keeps the JS-facing scope
/// closed and lets each call be checked on its merits, the same bargain `allow_asset`
/// makes for thumbnails.
///
/// The path is not taken on trust:
///
///   - it must be absolute (a relative one resolves against the app's cwd),
///   - it must resolve — following symlinks — to an existing REGULAR file, which also
///     rules out `.app` bundles and every other directory,
///   - neither the link nor its target may carry an extension the OS would execute,
///     so a `notes.txt` symlinked to a shell script is refused on what it opens.
#[tauri::command]
fn open_attachment(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt as _;

    let raw = std::path::Path::new(path.trim());
    if !raw.is_absolute() {
        return Err(format!("attachment path must be absolute: {}", raw.display()));
    }
    let target = std::fs::canonicalize(raw)
        .map_err(|e| format!("cannot resolve attachment {}: {e}", raw.display()))?;
    if !target.is_file() {
        return Err(format!("not a regular file: {}", raw.display()));
    }

    let executable = |p: &std::path::Path| {
        p.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .is_some_and(|e| UNOPENABLE_EXTENSIONS.contains(&e.as_str()))
    };
    if executable(raw) || executable(&target) {
        return Err(format!(
            "refusing to open an executable file: {}",
            raw.display()
        ));
    }

    app.opener()
        .open_path(target.to_string_lossy().into_owned(), None::<&str>)
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
            dir_exists,
            load_state,
            save_state,
            claude_session_exists,
            claude_agent_env,
            prune_claude_homes,
            open_in_editor,
            git_status,
            git_diff_file,
            git_diff_all,
            git_stage_file,
            discover_scripts,
            resolve_test_command,
            search_workspace,
            warm_search_index,
            invalidate_search_index,
            list_dir,
            read_text_file,
            write_text_file,
            save_pasted_file,
            allow_asset,
            open_attachment,
            read_attachment
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
