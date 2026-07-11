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
//!
//! Writes go temp → fsync → rotate backup → atomic rename, so a crash or power
//! loss can never leave a truncated `state.json`, and an unreadable one always
//! falls back to the backup (or is preserved for manual recovery) instead of
//! being silently overwritten with empty state.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::{AppHandle, Manager};

const STATE_FILE: &str = "state.json";
const BAK_FILE: &str = "state.json.bak";
const TMP_FILE: &str = "state.json.tmp";
const CORRUPT_FILE: &str = "state.corrupt.json";
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
    let legacy_bak = legacy_dir.join(BAK_FILE);
    if legacy_bak.exists() {
        let _ = fs::copy(&legacy_bak, new_dir.join(BAK_FILE));
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
                        let _ = fs::rename(&path, dir.join(CORRUPT_FILE));
                        let _ = fs::copy(&bak, &path);
                        return Ok(value);
                    }
                }
                // No usable backup: keep the raw bytes for manual recovery and start
                // fresh rather than letting the frontend overwrite them with empty state.
                let _ = fs::rename(&path, dir.join(CORRUPT_FILE));
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
            return Ok(value);
        }
    }

    Ok(Value::Null)
}

/// Persist `state` into `dir` atomically, keeping the previous good copy as the
/// backup. Order: write temp → fsync → snapshot current file to `.bak` → rename.
fn save_to_dir(dir: &Path, state: &Value) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(STATE_FILE);
    let tmp = dir.join(TMP_FILE);
    let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;

    // Write the new state to a temp file and flush it all the way to disk before we
    // touch the live file, so a crash mid-write can never leave a truncated state.json.
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        // Best-effort durability; the atomic rename below is the real guarantee.
        let _ = f.sync_all();
    }
    // Snapshot the current (last-known-good) file into the backup before swapping.
    // A failed backup must not block the save, so it is best-effort.
    if path.exists() {
        let _ = fs::copy(&path, dir.join(BAK_FILE));
    }
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Load the persisted state blob (opaque JSON owned by the frontend), or `null` if
/// absent. Migrates data from the old identifier-named folder on first launch.
pub fn load(app: &AppHandle) -> Result<Value, String> {
    let dir = state_dir(app)?;
    let base = app.path().data_dir().map_err(|e| e.to_string())?;
    migrate_legacy_dir(&dir, &base.join(LEGACY_DIR))?;
    load_from_dir(&dir)
}

/// Persist the state blob atomically, keeping a rotating backup.
pub fn save(app: &AppHandle, state: Value) -> Result<(), String> {
    let dir = state_dir(app)?;
    save_to_dir(&dir, &state)
}

/// Whether Claude Code has a persisted conversation for `session_id`.
/// Sessions live at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.
/// Used to choose `--resume` (exists) vs `--session-id` (create) with no error flash.
pub fn claude_session_exists(session_id: &str) -> bool {
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
        assert!(read(dir.path().join(BAK_FILE)).contains("\"n\": 1"));
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

    #[test]
    fn migration_is_noop_when_no_legacy_exists() {
        let base = TempDir::new();
        let legacy = base.path().join(LEGACY_DIR);
        let new_dir = base.path().join("codesu");
        migrate_legacy_dir(&new_dir, &legacy).unwrap();
        assert_eq!(load_from_dir(&new_dir).unwrap(), Value::Null);
    }
}
