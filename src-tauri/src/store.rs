//! Lightweight JSON persistence for the workspace/agent tree.
//!
//! Terminals (PTYs) are runtime-only and never persisted — on load the frontend
//! restores the tree and respawns terminals lazily when a tab is first opened.
//! (SQLite via rusqlite is the eventual home per the plan; JSON keeps this phase
//! dependency-light.)
//!
//! Durability model (see `load_from_dir` / `save_to_dir`):
//!
//! - `state.json` — the live file.
//! - `state.json.bak` — the previous good copy, rotated on every save.
//! - `state.json.tmp` — scratch file for the atomic write.
//! - `state.corrupt.json` — quarantined bytes of an unreadable live file.
//! - `state.pre-projects.json` — one-time archive taken the first time a state file
//!   from before the projects tree is loaded (see `archive_pre_projects`).
//!
//! Writes go temp → fsync → rotate backup → atomic rename, so a crash or power
//! loss can never leave a truncated `state.json`, and an unreadable one always
//! falls back to the backup (or is preserved for manual recovery) instead of
//! being silently overwritten with empty state.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::Value;
use tauri::{AppHandle, Manager};

const STATE_FILE: &str = "state.json";
const BAK_FILE: &str = "state.json.bak";
const TMP_FILE: &str = "state.json.tmp";
const CORRUPT_FILE: &str = "state.corrupt.json";
/// One-time archive of the last pre-`projects` state (see `archive_pre_projects`).
const PRE_PROJECTS_FILE: &str = "state.pre-projects.json";
/// The folder earlier releases used, derived from the reverse-DNS bundle identifier.
const LEGACY_DIR: &str = "com.kmlcnclk.codesu";

/// The folder that holds Codesu's state, e.g. `~/Library/Application Support/codesu`
/// on macOS. We build this off the OS data dir + a friendly `codesu` leaf rather than
/// Tauri's `app_data_dir()` (which appends the reverse-DNS bundle identifier,
/// `com.kmlcnclk.codesu`) so users see a clean, recognizable folder name.
fn state_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .data_dir()
        .map_err(|e| format!("no data dir: {e}"))?
        .join("codesu");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Narrow a state file to owner-only (0600).
///
/// The blob is opaque to us but it carries whatever the user typed into an agent's notes,
/// which in practice includes pasted tokens and credentials. `fs::File::create` and
/// `fs::copy` both leave 0644 behind, i.e. readable by every account on the machine, so
/// every file this module creates is narrowed as soon as it exists.
#[cfg(unix)]
fn set_private(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

/// No unix mode bits to set; the OS default ACL applies.
#[cfg(not(unix))]
fn set_private(_path: &Path) {}

/// Parse a state file into JSON, treating an empty file as "no state".
fn parse_state(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// True when a loaded state has no meaningful user content (no workspaces, agents,
/// or tasks) — i.e. a fresh/default tree with nothing to lose.
fn is_empty_state(v: &Value) -> bool {
    let empty = |key: &str| {
        v.get(key)
            .and_then(|x| x.as_array())
            .is_none_or(|a| a.is_empty())
    };
    empty("workspaces") && empty("agents") && empty("tasks")
}

/// Migration for users upgrading from a build that stored state under the
/// bundle-identifier folder. Copies the legacy state file — and its backup — into
/// `new_dir` so nobody loses data when the folder name changes.
///
/// Migrates when the new folder has no meaningful state yet: either no file at all,
/// OR a file that parses to an empty/default tree. The empty-file case is essential:
/// if a first launch ever creates an empty `state.json` before data is migrated
/// (an interrupted run, a crash, a stale build), a "migrate only when absent" rule
/// would skip migration forever and strand the legacy data. Once the new folder
/// holds real content, migration is a no-op, so genuine new-folder data is never
/// overwritten.
fn migrate_legacy_dir(new_dir: &Path, legacy_dir: &Path) -> Result<(), String> {
    let legacy = legacy_dir.join(STATE_FILE);
    if !legacy.exists() {
        return Ok(());
    }
    let new_path = new_dir.join(STATE_FILE);
    let should_migrate = if new_path.exists() {
        // An unreadable new file is left for load_from_dir's backup recovery.
        parse_state(&new_path).map(|v| is_empty_state(&v)).unwrap_or(false)
    } else {
        true
    };
    if !should_migrate {
        return Ok(());
    }
    fs::create_dir_all(new_dir).map_err(|e| e.to_string())?;
    fs::copy(&legacy, &new_path).map_err(|e| e.to_string())?;
    set_private(&new_path);
    let legacy_bak = legacy_dir.join(BAK_FILE);
    if legacy_bak.exists() {
        let new_bak = new_dir.join(BAK_FILE);
        if fs::copy(&legacy_bak, &new_bak).is_ok() {
            set_private(&new_bak);
        }
    }
    Ok(())
}

/// Load the state blob from `dir`, recovering from the backup if the live file is
/// unreadable. Returns `Value::Null` only when there is genuinely nothing to load.
fn load_from_dir(dir: &Path) -> Result<Value, String> {
    let path = dir.join(STATE_FILE);
    let bak = dir.join(BAK_FILE);

    if path.exists() {
        match parse_state(&path) {
            Ok(value) => return Ok(value),
            Err(primary_err) => {
                // The live file is corrupt. Try the rotated backup before giving up.
                if bak.exists() {
                    if let Ok(value) = parse_state(&bak) {
                        // Quarantine the corrupt live file (don't destroy it) and
                        // reinstate the good backup so the next save rotates cleanly.
                        let corrupt = dir.join(CORRUPT_FILE);
                        let _ = fs::rename(&path, &corrupt);
                        set_private(&corrupt);
                        let _ = fs::copy(&bak, &path);
                        set_private(&path);
                        return Ok(value);
                    }
                }
                // No usable backup: keep the raw bytes for manual recovery and start
                // fresh rather than letting the frontend overwrite them with empty state.
                let corrupt = dir.join(CORRUPT_FILE);
                let _ = fs::rename(&path, &corrupt);
                set_private(&corrupt);
                return Err(format!(
                    "state.json was corrupt (preserved as state.corrupt.json): {primary_err}"
                ));
            }
        }
    }

    // No live file — try a backup left behind by an interrupted rotation.
    if bak.exists() {
        if let Ok(value) = parse_state(&bak) {
            let _ = fs::copy(&bak, &path);
            set_private(&path);
            return Ok(value);
        }
    }

    Ok(Value::Null)
}

/// Serialises the whole write sequence below.
///
/// Saves are debounced and arrive on Tauri's sync command path, so today they are already
/// one-at-a-time on the main thread — but that is an accident of how the commands are
/// declared, not a guarantee, and the sequence uses one fixed scratch name. Two concurrent
/// saves sharing `state.json.tmp` would interleave their writes and rename each other's
/// half-written file into place. A mutex is cheap insurance against that ever becoming
/// true (an async command, a background flush).
static SAVE_LOCK: Mutex<()> = Mutex::new(());

/// Persist `state` into `dir` atomically, keeping the previous good copy as the
/// backup. Order: write temp → fsync → snapshot current file to `.bak` → rename.
fn save_to_dir(dir: &Path, state: &Value) -> Result<(), String> {
    // A panicking save would poison this; the data is not what the lock protects, so a
    // poisoned lock is simply taken over rather than turned into a failure to save.
    let _guard = SAVE_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(STATE_FILE);
    let tmp = dir.join(TMP_FILE);
    // Compact, not pretty: this runs on a 250ms debounce behind every state change and
    // serialises the whole snapshot (workspaces, agents, tasks, months of activity), so
    // the indentation is pure write amplification on a hot path. Nothing reads the file
    // by hand — it is machine state, and load_from_dir parses either form.
    let text = serde_json::to_string(state).map_err(|e| e.to_string())?;

    // Write the new state to a temp file and flush it all the way to disk before we
    // touch the live file, so a crash mid-write can never leave a truncated state.json.
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        // Narrowed BEFORE the bytes land, so the notes are never briefly world-readable.
        set_private(&tmp);
        f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        // Best-effort durability; the atomic rename below is the real guarantee.
        let _ = f.sync_all();
    }
    // Snapshot the current (last-known-good) file into the backup before swapping.
    // A failed backup must not block the save, so it is best-effort.
    if path.exists() {
        let bak = dir.join(BAK_FILE);
        if fs::copy(&path, &bak).is_ok() {
            set_private(&bak);
        }
    }
    // The rename carries the temp file's 0600 over to `state.json`.
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Keep one copy of the last state written before the projects tree existed.
///
/// `state.json.bak` holds only the PREVIOUS save, and saves run on a 250ms debounce, so
/// it is overwritten seconds after launch — useless as a way back from a structural
/// migration that rewrites how every workspace is filed. This snapshot is taken once,
/// never overwritten, and never read by the app: it exists purely so a migration that
/// goes wrong is recoverable by hand.
///
/// Best-effort by design — a failure here must not stop the app from loading.
fn archive_pre_projects(dir: &Path, state: &Value) {
    // Only a state file that predates the migration, and only if there is real content
    // to lose. Once `projects` is present, this has already been done (or never applied).
    let legacy = state.get("projects").is_none()
        && state
            .get("workspaces")
            .and_then(|w| w.as_array())
            .is_some_and(|w| !w.is_empty());
    if !legacy {
        return;
    }
    let archive = dir.join(PRE_PROJECTS_FILE);
    if archive.exists() {
        return;
    }
    let live = dir.join(STATE_FILE);
    if live.exists() && fs::copy(&live, &archive).is_ok() {
        set_private(&archive);
    }
}

/// Load the persisted state blob (opaque JSON owned by the frontend), or `null` if
/// absent. Migrates data from the old identifier-named folder on first launch.
pub fn load(app: &AppHandle) -> Result<Value, String> {
    let dir = state_dir(app)?;
    let base = app.path().data_dir().map_err(|e| e.to_string())?;
    migrate_legacy_dir(&dir, &base.join(LEGACY_DIR))?;
    let state = load_from_dir(&dir)?;
    archive_pre_projects(&dir, &state);
    Ok(state)
}

/// Persist the state blob atomically, keeping a rotating backup.
pub fn save(app: &AppHandle, state: Value) -> Result<(), String> {
    let dir = state_dir(app)?;
    save_to_dir(&dir, &state)
}

/// Whether `session_id` is a plain UUID-shaped token — ASCII alphanumerics and dashes,
/// nothing else.
///
/// The id is interpolated into a filename, so anything looser turns this into a
/// path-existence oracle for the webview: `../../.ssh/id_rsa` (or a bare `.` slipping a
/// second extension in) would report on files that have nothing to do with Claude Code.
/// Real session ids are UUIDs, so the check costs nothing.
fn is_safe_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Whether Claude Code has a persisted conversation for `session_id`.
/// Sessions live at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.
/// Used to choose `--resume` (exists) vs `--session-id` (create) with no error flash.
pub fn claude_session_exists(session_id: &str) -> bool {
    if !is_safe_session_id(session_id) {
        return false;
    }
    let Ok(home) = std::env::var("HOME") else {
        return false;
    };
    let projects = PathBuf::from(home).join(".claude").join("projects");
    let file = format!("{session_id}.jsonl");
    let Ok(entries) = fs::read_dir(&projects) else {
        return false;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if dir.is_dir() && dir.join(&file).exists() {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU32, Ordering};

    // A unique scratch directory per test, avoiding any external crate.
    // Date.now/rand are unavailable, so uniqueness comes from a process-local counter.
    static COUNTER: AtomicU32 = AtomicU32::new(0);

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let pid = std::process::id();
            let dir = std::env::temp_dir().join(format!("codesu-test-{pid}-{n}"));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn read(path: PathBuf) -> String {
        fs::read_to_string(path).unwrap()
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = TempDir::new();
        let state = json!({ "version": 1, "workspaces": [{ "id": "w1" }] });
        save_to_dir(dir.path(), &state).unwrap();
        assert_eq!(load_from_dir(dir.path()).unwrap(), state);
    }

    #[test]
    fn missing_file_loads_as_null() {
        let dir = TempDir::new();
        assert_eq!(load_from_dir(dir.path()).unwrap(), Value::Null);
    }

    #[test]
    fn empty_file_loads_as_null() {
        let dir = TempDir::new();
        fs::write(dir.path().join(STATE_FILE), "").unwrap();
        assert_eq!(load_from_dir(dir.path()).unwrap(), Value::Null);
    }

    #[test]
    fn second_save_rotates_previous_into_backup() {
        let dir = TempDir::new();
        let v1 = json!({ "n": 1 });
        let v2 = json!({ "n": 2 });
        save_to_dir(dir.path(), &v1).unwrap();
        save_to_dir(dir.path(), &v2).unwrap();
        // Live file holds the newest; backup holds the previous good copy.
        assert_eq!(load_from_dir(dir.path()).unwrap(), v2);
        // Compare parsed, not raw text, so the assertion survives a serialiser format change.
        let backup: serde_json::Value =
            serde_json::from_str(&read(dir.path().join(BAK_FILE))).unwrap();
        assert_eq!(backup, v1);
    }

    #[test]
    fn corrupt_live_file_recovers_from_backup() {
        let dir = TempDir::new();
        let good = json!({ "keep": "me" });
        save_to_dir(dir.path(), &good).unwrap();
        save_to_dir(dir.path(), &json!({ "keep": "me2" })).unwrap(); // creates .bak = good
        // Corrupt the live file.
        fs::write(dir.path().join(STATE_FILE), "{ not json").unwrap();

        // Recovers the backup's contents rather than losing everything...
        let loaded = load_from_dir(dir.path()).unwrap();
        assert_eq!(loaded, good);
        // ...the corrupt bytes are preserved for manual recovery...
        assert!(dir.path().join(CORRUPT_FILE).exists());
        // ...and the live file is healthy again on the next read.
        assert_eq!(load_from_dir(dir.path()).unwrap(), good);
    }

    #[test]
    fn corrupt_live_file_without_backup_is_quarantined_not_destroyed() {
        let dir = TempDir::new();
        fs::write(dir.path().join(STATE_FILE), "{ totally broken").unwrap();

        // With no backup, load errors (frontend starts fresh)...
        assert!(load_from_dir(dir.path()).is_err());
        // ...but the original bytes are never destroyed.
        assert_eq!(read(dir.path().join(CORRUPT_FILE)), "{ totally broken");
    }

    #[test]
    fn load_falls_back_to_backup_when_live_file_absent() {
        let dir = TempDir::new();
        let good = json!({ "from": "bak" });
        fs::write(
            dir.path().join(BAK_FILE),
            serde_json::to_string(&good).unwrap(),
        )
        .unwrap();
        // No live state.json, only a backup (e.g. interrupted rotation).
        assert_eq!(load_from_dir(dir.path()).unwrap(), good);
        // Backup is reinstated as the live file.
        assert!(dir.path().join(STATE_FILE).exists());
    }

    #[test]
    fn migration_copies_legacy_when_new_folder_empty() {
        let base = TempDir::new();
        let legacy = base.path().join(LEGACY_DIR);
        let new_dir = base.path().join("codesu");
        fs::create_dir_all(&legacy).unwrap();
        let data = json!({ "migrated": true });
        fs::write(
            legacy.join(STATE_FILE),
            serde_json::to_string(&data).unwrap(),
        )
        .unwrap();
        fs::write(legacy.join(BAK_FILE), "backup-bytes").unwrap();

        migrate_legacy_dir(&new_dir, &legacy).unwrap();

        assert_eq!(load_from_dir(&new_dir).unwrap(), data);
        assert_eq!(read(new_dir.join(BAK_FILE)), "backup-bytes");
    }

    #[test]
    fn migration_never_overwrites_real_new_data() {
        let base = TempDir::new();
        let legacy = base.path().join(LEGACY_DIR);
        let new_dir = base.path().join("codesu");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&new_dir).unwrap();
        let legacy_data = json!({ "workspaces": [{ "id": "legacy" }] });
        // New folder already has real content (a workspace) — must be preserved.
        let new_data = json!({ "workspaces": [{ "id": "new" }] });
        fs::write(
            legacy.join(STATE_FILE),
            serde_json::to_string(&legacy_data).unwrap(),
        )
        .unwrap();
        save_to_dir(&new_dir, &new_data).unwrap();

        migrate_legacy_dir(&new_dir, &legacy).unwrap();

        // Real new-folder data wins; legacy is ignored.
        assert_eq!(load_from_dir(&new_dir).unwrap(), new_data);
    }

    #[test]
    fn migration_recovers_when_new_file_exists_but_is_empty() {
        // Reproduces the real bug: an empty state.json was created before migration
        // could run, which used to skip migration forever and strand legacy data.
        let base = TempDir::new();
        let legacy = base.path().join(LEGACY_DIR);
        let new_dir = base.path().join("codesu");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&new_dir).unwrap();
        let legacy_data = json!({ "workspaces": [{ "id": "w1" }, { "id": "w2" }] });
        fs::write(
            legacy.join(STATE_FILE),
            serde_json::to_string(&legacy_data).unwrap(),
        )
        .unwrap();
        // A default/empty tree already sitting in the new folder.
        save_to_dir(&new_dir, &json!({ "workspaces": [], "agents": [], "tasks": [] })).unwrap();

        migrate_legacy_dir(&new_dir, &legacy).unwrap();

        // Legacy data is pulled in over the empty tree.
        assert_eq!(load_from_dir(&new_dir).unwrap(), legacy_data);
    }

    /// The id lands in a filename, so anything that could steer the lookup out of
    /// `~/.claude/projects` turns the command into a path-existence oracle for the webview.
    #[test]
    fn only_uuid_shaped_session_ids_are_looked_up() {
        assert!(is_safe_session_id("3f2a1b4c-5d6e-7f80-91a2-b3c4d5e6f708"));
        assert!(is_safe_session_id("abc123"));
        for bad in [
            "",
            "../../.ssh/id_rsa",
            "a/b",
            "a\\b",
            "..",
            "id.jsonl",     // a dot would let a second extension through
            "id\0",         // NUL truncates the path at the syscall boundary
            "id with space",
        ] {
            assert!(!is_safe_session_id(bad), "{bad:?} must be rejected");
            assert!(!claude_session_exists(bad));
        }
    }

    #[test]
    fn pre_projects_state_is_archived_once_and_never_overwritten() {
        let d = TempDir::new();
        let legacy = json!({ "workspaces": [{ "id": "w1" }], "agents": [] });
        save_to_dir(d.path(), &legacy).unwrap();

        archive_pre_projects(d.path(), &legacy);
        let archive = d.path().join(PRE_PROJECTS_FILE);
        assert!(archive.exists(), "a pre-projects state must be archived");
        assert!(read(archive.clone()).contains("w1"));

        // A later load must not clobber the archive with post-migration content.
        let migrated = json!({ "projects": [{ "id": "p1" }], "workspaces": [{ "id": "w1" }] });
        save_to_dir(d.path(), &migrated).unwrap();
        archive_pre_projects(d.path(), &migrated);
        assert!(!read(archive.clone()).contains("p1"));

        // Even a second legacy-shaped load leaves the original archive alone.
        archive_pre_projects(d.path(), &legacy);
        assert!(!read(archive).contains("p1"));
    }

    #[test]
    fn empty_or_migrated_state_is_not_archived() {
        let d = TempDir::new();
        // Already migrated: nothing to preserve.
        let migrated = json!({ "projects": [], "workspaces": [{ "id": "w1" }] });
        save_to_dir(d.path(), &migrated).unwrap();
        archive_pre_projects(d.path(), &migrated);
        assert!(!d.path().join(PRE_PROJECTS_FILE).exists());

        // A fresh install has no workspaces, so there is no history to lose.
        let fresh = json!({ "workspaces": [] });
        save_to_dir(d.path(), &fresh).unwrap();
        archive_pre_projects(d.path(), &fresh);
        assert!(!d.path().join(PRE_PROJECTS_FILE).exists());
    }

    #[test]
    fn migration_is_noop_when_no_legacy_exists() {
        let base = TempDir::new();
        let legacy = base.path().join(LEGACY_DIR);
        let new_dir = base.path().join("codesu");
        migrate_legacy_dir(&new_dir, &legacy).unwrap();
        assert_eq!(load_from_dir(&new_dir).unwrap(), Value::Null);
    }
}
