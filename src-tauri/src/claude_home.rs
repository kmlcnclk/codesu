//! Per-agent Claude Code homes — one isolated `CLAUDE_CONFIG_DIR` per Claude agent.
//!
//! ## The bug this exists for
//!
//! Claude Code appends every prompt the user types to `<config dir>/history.jsonl`, and
//! each entry records both the `project` (the session's directory) and the `sessionId`.
//! The ↑ / ⌃R history a session offers back is filtered by **project**, not by session —
//! so every session started in the same directory shares one prompt history.
//!
//! codesu deliberately runs several agents in one workspace folder, each with its own
//! session id. With the default config dir they therefore all read and write the same
//! history: pressing ↑ in one agent walks into prompts typed at another. There is no
//! Claude Code flag or setting that scopes prompt history to a session
//! (`CLAUDE_CODE_SKIP_PROMPT_HISTORY` is not it — it also turns transcript saving off,
//! which would break `--resume`, i.e. the whole idle-sleep model).
//!
//! ## The fix
//!
//! Give every Claude agent its own config dir at `~/.codesu/claude-home/<agent id>`,
//! populated with SYMLINKS back into the real `~/.claude`. Everything that must stay
//! shared resolves to the one true copy:
//!
//!   - `projects/` — the transcripts `--resume` reads, and what `claude_session_exists`
//!     scans. Sessions keep landing in `~/.claude/projects/<project>/<id>.jsonl`.
//!   - `settings.json`, `CLAUDE.md`, `commands/`, `agents/`, `skills/`, `plugins/` — the
//!     user's own configuration must reach every agent.
//!   - `~/.claude.json`, linked in as `.config.json` (Claude Code prefers that name over
//!     the config-dir default): trust answers, MCP servers, onboarding state.
//!
//! Only `history.jsonl` is a real, private file per agent — which is exactly the
//! separation the bug is about.
//!
//! `CLAUDE_SECURESTORAGE_CONFIG_DIR` is set to the EMPTY STRING alongside
//! `CLAUDE_CONFIG_DIR`. Claude Code derives the credential store's location — and, on
//! macOS, the Keychain item's name — from the config dir; empty means "use the default
//! `~/.claude` store". Without it, every isolated agent would be asked to log in again.
//!
//! ## Failure is not fatal
//!
//! Every entry point returns a plain `Result` and the UI treats an error as "launch with
//! the shared config dir": an agent that starts with shared prompt history is a much
//! smaller problem than an agent that refuses to start.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// Shared-home entries that must NOT be linked.
///
/// `history.jsonl` is the one this module exists for — keeping it private is the point.
/// `.credentials.json` is here for a different reason: it is the OAuth token store, and
/// `CLAUDE_SECURESTORAGE_CONFIG_DIR` is already set to the empty string so credentials
/// resolve to the default `~/.claude` store. Linking it in as well would put a second,
/// writable route to the user's token inside every per-agent home for no benefit.
const PRIVATE_ENTRIES: &[&str] = &["history.jsonl", ".credentials.json"];
/// Entries never worth linking.
const SKIP_ENTRIES: &[&str] = &[".DS_Store"];

/// Resolve the user's home directory (`$HOME`, or `%USERPROFILE%` on Windows).
fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "could not resolve home directory".into())
}

/// The real Claude Code home every agent home links back into.
fn shared_home(home: &Path) -> PathBuf {
    home.join(".claude")
}

/// The user-scope config file, which lives beside `~/.claude` rather than inside it.
fn shared_config_file(home: &Path) -> PathBuf {
    home.join(".claude.json")
}

/// Root for all per-agent homes: `~/.codesu/claude-home` (next to `~/.codesu/worktrees`).
fn root(home: &Path) -> PathBuf {
    home.join(".codesu").join("claude-home")
}

/// One path segment per agent id.
///
/// Ids are app-generated (`agent-12-345678`), but they round-trip through a JSON state
/// file on disk, so they are sanitized rather than trusted: anything that is not
/// `[A-Za-z0-9._-]` becomes `-`, and a segment that would name the parent (`.`, `..`) or
/// nothing at all is rejected outright.
fn segment(agent_id: &str) -> Result<String, String> {
    let mapped: String = agent_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if mapped.is_empty() || mapped.chars().all(|c| c == '.') {
        return Err(format!("unusable agent id: {agent_id:?}"));
    }
    Ok(mapped)
}

#[cfg(unix)]
fn make_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

/// Windows symlinks need Developer Mode or elevation, so isolation is unix-only; the
/// caller falls back to the shared config dir.
#[cfg(not(unix))]
fn make_symlink(_target: &Path, _link: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "symlinks are not supported on this platform",
    ))
}

/// Point `link` at `target`, leaving anything real that already sits there alone.
///
/// Claude Code writes some config files by rename, which replaces a symlink with a real
/// file. That file is then the agent's own copy of something that was meant to be shared
/// — mildly wrong, but silently deleting a file we did not create would be worse, so it
/// is kept and only stale/broken links are repointed.
fn link_shared(link: &Path, target: &Path) {
    match fs::read_link(link) {
        // Already ours (this also covers a link whose target has gone missing).
        Ok(existing) if existing == target => return,
        Ok(_) => {
            let _ = fs::remove_file(link);
        }
        Err(_) => {
            if link.exists() {
                return; // a real file or directory — never clobber it
            }
        }
    }
    let _ = make_symlink(target, link);
}

/// The key a history line is ordered and de-duplicated by: `(timestamp, sessionId)` —
/// the same pair Claude Code itself uses to recognise an entry it has already seen.
/// `timestamp` is written as a string but accepted as a number too.
fn history_key(line: &str) -> Option<(i64, String)> {
    let entry: Value = serde_json::from_str(line).ok()?;
    let ts = match entry.get("timestamp")? {
        Value::String(s) => s.parse::<i64>().ok()?,
        Value::Number(n) => n.as_i64()?,
        _ => return None,
    };
    let session = entry
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Some((ts, session))
}

/// Put history lines in the order Claude Code reads them back, and drop exact repeats.
///
/// The ↑ / ⌃R list is the file walked BACKWARDS from the end, so "newest last" is not a
/// nicety — it IS the ordering the user sees. Two things break it in practice:
///
///   - The shared `~/.claude/history.jsonl` is ordered by FLUSH, not by keystroke: each
///     session appends its buffer in batches under a lock, so concurrent sessions
///     interleave and the file is not globally chronological (measured on a real file:
///     every session ordered within itself, the file as a whole not). Anything copied out
///     of it inherits that jumble.
///   - A slept agent flushes its buffer as it exits, which can land AFTER the relaunched
///     process has already appended newer prompts.
///
/// Sorting is stable and keyed on `(timestamp, original position)`, so entries stamped in
/// the same millisecond keep the order they were written in. Duplicate keys are dropped
/// because `THo` (the ↑ generator) does NOT de-duplicate what it reads out of the file —
/// two identical lines mean the same prompt twice in the list. Lines that are not JSON, or
/// carry no timestamp, are kept (Claude Code skips them when reading) but parked at the
/// end where they cannot displace a real entry.
///
/// Returns the normalised text and whether it differs from the input.
fn ordered_history(text: &str) -> (String, bool) {
    let mut dated: Vec<(i64, usize, &str)> = Vec::new();
    let mut undated: Vec<&str> = Vec::new();
    let mut seen: HashSet<(i64, String)> = HashSet::new();
    for (position, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let Some(key) = history_key(line) else {
            undated.push(line);
            continue;
        };
        let ts = key.0;
        if !seen.insert(key) {
            continue;
        }
        dated.push((ts, position, line));
    }
    dated.sort_by_key(|(ts, position, _)| (*ts, *position));

    let mut out = String::with_capacity(text.len());
    for (_, _, line) in &dated {
        out.push_str(line);
        out.push('\n');
    }
    for line in &undated {
        out.push_str(line);
        out.push('\n');
    }
    let changed = out != text;
    (out, changed)
}

/// Seed a brand-new agent home with the agent's OWN past prompts.
///
/// Called once, when `history.jsonl` does not exist yet: an agent that has been typing
/// into the shared history until now would otherwise look like its ↑ history had been
/// wiped. Entries from other sessions are exactly what is being separated, so they stay
/// behind, and what is kept is re-ordered by {@link ordered_history} rather than trusted
/// to be chronological. The file is written even when nothing matches — its existence is
/// what marks this home as seeded, so the shared history is scanned once per agent, not
/// once per launch.
fn seed_history(home: &Path, dir: &Path, session_id: Option<&str>) {
    let target = dir.join("history.jsonl");
    if target.exists() {
        return;
    }
    let mut kept = String::new();
    if let Some(session_id) = session_id {
        if let Ok(text) = fs::read_to_string(shared_home(home).join("history.jsonl")) {
            for line in text.lines() {
                let Ok(entry) = serde_json::from_str::<Value>(line) else {
                    continue;
                };
                if entry.get("sessionId").and_then(Value::as_str) == Some(session_id) {
                    kept.push_str(line);
                    kept.push('\n');
                }
            }
        }
    }
    let (ordered, _) = ordered_history(&kept);
    write_history(&target, &ordered);
}

/// Replace a history file in one step: write a scratch file, then rename it over the
/// target.
///
/// `fs::write` truncates first, so a crash (or a quit) mid-write would leave the agent
/// holding a half-written history — and a torn last line is a line Claude Code drops. A
/// rename is atomic, so a reader sees either the old file or the new one, never a
/// truncated one. Same convention as `store::save`. Best effort: if the scratch write
/// fails the existing file is left exactly as it was.
fn write_history(path: &Path, contents: &str) {
    let tmp = path.with_extension("jsonl.tmp");
    if fs::write(&tmp, contents).is_err() {
        let _ = fs::remove_file(&tmp);
        return;
    }
    if fs::rename(&tmp, path).is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

/// Repair the order of an agent's own history, so ↑ walks it newest-first.
///
/// Runs on every launch, before the agent's process exists, and rewrites the file ONLY
/// when it is actually out of order or holds duplicates — the common case touches nothing.
/// Claude Code appends under a `proper-lockfile` lock, which is the directory
/// `history.jsonl.lock`; while that exists another process is mid-append, so the repair is
/// skipped rather than raced (the next launch does it).
fn normalize_history(dir: &Path) {
    let path = dir.join("history.jsonl");
    if dir.join("history.jsonl.lock").exists() {
        return;
    }
    let Ok(text) = fs::read_to_string(&path) else {
        return;
    };
    let (ordered, changed) = ordered_history(&text);
    if changed {
        write_history(&path, &ordered);
    }
}

/// The environment an agent's shell needs to use its own home.
fn env_for(dir: &Path) -> HashMap<String, String> {
    HashMap::from([
        (
            "CLAUDE_CONFIG_DIR".to_string(),
            dir.to_string_lossy().into_owned(),
        ),
        // Empty, NOT unset: it means "credentials live in the default ~/.claude store",
        // which is what keeps every isolated agent signed in with the one login.
        ("CLAUDE_SECURESTORAGE_CONFIG_DIR".to_string(), String::new()),
    ])
}

/// Create (or refresh) this agent's home and return the env vars that select it.
///
/// Refreshing on every launch is deliberate and cheap: entries the user has added to
/// `~/.claude` since the home was built (a new skill, a new plugin) get linked in, and a
/// link left dangling by a moved target is repointed.
pub fn prepare(agent_id: &str, session_id: Option<&str>) -> Result<HashMap<String, String>, String> {
    prepare_in(&home_dir()?, agent_id, session_id)
}

/// `prepare`, against an explicit home directory. Split out so the tests can work in a
/// scratch home instead of mutating the process-wide `$HOME` (which other tests read).
fn prepare_in(
    home: &Path,
    agent_id: &str,
    session_id: Option<&str>,
) -> Result<HashMap<String, String>, String> {
    if !cfg!(unix) {
        return Err("per-agent Claude homes require symlink support".into());
    }
    let shared = shared_home(home);
    if !shared.is_dir() {
        // Claude Code has never run for this user; there is nothing to share yet, and
        // guessing at a home would only produce a config dir with no settings in it.
        return Err(format!("{} does not exist yet", shared.display()));
    }
    let dir = root(home).join(segment(agent_id)?);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    for entry in fs::read_dir(&shared).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if PRIVATE_ENTRIES.contains(&name.as_ref()) || SKIP_ENTRIES.contains(&name.as_ref()) {
            continue;
        }
        link_shared(&dir.join(name.as_ref()), &entry.path());
    }

    // The config file sits outside the home, so it is linked in by hand. `.config.json`
    // is the name Claude Code looks for inside the config dir before falling back to
    // `<config dir>/.claude.json`; both are linked so either resolution order shares the
    // user's real trust/MCP/onboarding state instead of starting from scratch.
    let config = shared_config_file(home);
    if config.is_file() {
        link_shared(&dir.join(".config.json"), &config);
        link_shared(&dir.join(".claude.json"), &config);
    }

    seed_history(home, &dir, session_id); // first launch only
    normalize_history(&dir); // every launch: keep ↑ walking newest-first
    Ok(env_for(&dir))
}

/// Delete the homes of agents that no longer exist.
///
/// Called once at startup with every live agent id. Homes are cheap (symlinks plus one
/// small history file), but an app that never cleans up leaves a directory per agent the
/// user has ever closed.
pub fn prune(live_agent_ids: &[String]) -> Result<(), String> {
    prune_in(&home_dir()?, live_agent_ids)
}

/// `prune`, against an explicit home directory (see `prepare_in`).
fn prune_in(home: &Path, live_agent_ids: &[String]) -> Result<(), String> {
    let root = root(home);
    if !root.is_dir() {
        return Ok(());
    }
    let live: HashSet<String> = live_agent_ids.iter().filter_map(|id| segment(id).ok()).collect();
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if live.contains(&name) {
            continue;
        }
        // `remove_dir_all` deletes symlinks rather than following them, so the shared
        // `~/.claude` entries they point at are never touched.
        let _ = fs::remove_dir_all(entry.path());
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// A scratch home per test. Nothing here touches the process environment (other tests
    /// read `$HOME`), so these run in parallel like any other test — that is the whole
    /// reason `prepare_in`/`prune_in` take the home as an argument.
    fn fake_home(label: &str) -> PathBuf {
        let home = std::env::temp_dir().join(format!("codesu-claude-home-{label}"));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(home.join(".claude").join("projects")).unwrap();
        fs::write(home.join(".claude").join("settings.json"), "{}").unwrap();
        fs::write(home.join(".claude.json"), "{\"projects\":{}}").unwrap();
        home
    }

    /// The config dir `prepare_in` handed back, as a path.
    fn dir_of(env: &HashMap<String, String>) -> PathBuf {
        PathBuf::from(&env["CLAUDE_CONFIG_DIR"])
    }

    #[test]
    fn shared_entries_are_linked_and_history_is_private() {
        let home = fake_home("link");
        fs::write(
            home.join(".claude").join("history.jsonl"),
            "{\"display\":\"mine\",\"sessionId\":\"s-1\"}\n{\"display\":\"theirs\",\"sessionId\":\"s-2\"}\n",
        )
        .unwrap();

        let env = prepare_in(&home, "agent-1-2", Some("s-1")).unwrap();
        let dir = dir_of(&env);
        assert_eq!(env["CLAUDE_SECURESTORAGE_CONFIG_DIR"], "");

        // Shared state resolves to the one real copy...
        assert_eq!(
            fs::read_link(dir.join("projects")).unwrap(),
            home.join(".claude").join("projects")
        );
        assert_eq!(
            fs::read_link(dir.join(".config.json")).unwrap(),
            home.join(".claude.json")
        );
        // ...while history is this agent's own file, holding only its own prompts.
        assert!(fs::symlink_metadata(dir.join("history.jsonl")).unwrap().is_file());
        let seeded = fs::read_to_string(dir.join("history.jsonl")).unwrap();
        assert!(seeded.contains("mine"), "own prompts carry over: {seeded:?}");
        assert!(!seeded.contains("theirs"), "other sessions must not: {seeded:?}");
    }

    /// The bug, as a test: what one agent types must not show up for another.
    #[test]
    fn two_agents_get_two_history_files() {
        let home = fake_home("split");
        let a = dir_of(&prepare_in(&home, "agent-a", Some("s-a")).unwrap());
        let b = dir_of(&prepare_in(&home, "agent-b", Some("s-b")).unwrap());
        assert_ne!(a, b);
        fs::write(a.join("history.jsonl"), "typed in a\n").unwrap();
        assert_eq!(fs::read_to_string(b.join("history.jsonl")).unwrap(), "");
        // And neither of them writes into the shared file any more.
        assert!(!home.join(".claude").join("history.jsonl").exists());
    }

    /// A second launch must not wipe the history the first one accumulated.
    #[test]
    fn refresh_keeps_existing_history() {
        let home = fake_home("refresh");
        let dir = dir_of(&prepare_in(&home, "agent-x", Some("s-x")).unwrap());
        fs::write(dir.join("history.jsonl"), "kept\n").unwrap();
        prepare_in(&home, "agent-x", Some("s-x")).unwrap();
        assert_eq!(fs::read_to_string(dir.join("history.jsonl")).unwrap(), "kept\n");
    }

    /// An entry added to `~/.claude` after the home was built gets linked in on next launch.
    #[test]
    fn refresh_links_newly_shared_entries() {
        let home = fake_home("newentry");
        let dir = dir_of(&prepare_in(&home, "agent-n", None).unwrap());
        assert!(!dir.join("skills").exists());
        fs::create_dir_all(home.join(".claude").join("skills")).unwrap();
        prepare_in(&home, "agent-n", None).unwrap();
        assert_eq!(
            fs::read_link(dir.join("skills")).unwrap(),
            home.join(".claude").join("skills")
        );
    }

    /// A file Claude Code wrote over a link is the agent's own — refresh leaves it.
    #[test]
    fn a_real_file_is_never_clobbered() {
        let home = fake_home("real");
        let dir = dir_of(&prepare_in(&home, "agent-y", None).unwrap());
        fs::remove_file(dir.join("settings.json")).unwrap();
        fs::write(dir.join("settings.json"), "{\"own\":true}").unwrap();
        prepare_in(&home, "agent-y", None).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("settings.json")).unwrap(),
            "{\"own\":true}"
        );
    }

    #[test]
    fn prune_removes_only_dead_agents_and_spares_the_shared_home() {
        let home = fake_home("prune");
        prepare_in(&home, "agent-live", None).unwrap();
        let dead = dir_of(&prepare_in(&home, "agent-dead", None).unwrap());
        prune_in(&home, &["agent-live".to_string()]).unwrap();
        assert!(!dead.exists());
        assert!(root(&home).join("agent-live").is_dir());
        // The symlinked originals survived being on the other end of a deleted link.
        assert!(home.join(".claude").join("projects").is_dir());
        assert!(home.join(".claude").join("settings.json").is_file());
    }

    #[test]
    fn ids_cannot_escape_the_root() {
        let home = fake_home("escape");
        let dir = dir_of(&prepare_in(&home, "../../etc", None).unwrap());
        assert_eq!(dir.parent().unwrap(), root(&home));
        assert!(segment("..").is_err());
        assert!(segment("").is_err());
    }

    /// The seed is taken from a file that is NOT globally chronological (concurrent
    /// sessions interleave their flush batches), so it must be sorted, not copied.
    #[test]
    fn seeded_history_comes_out_chronological() {
        let home = fake_home("order-seed");
        let e = |ts: i64, text: &str, sid: &str| {
            format!("{{\"display\":\"{text}\",\"timestamp\":\"{ts}\",\"sessionId\":\"{sid}\"}}")
        };
        // Interleaved exactly the way two live agents write one shared file.
        let shared = [
            e(300, "mine-third", "s-1"),
            e(100, "mine-first", "s-1"),
            e(250, "theirs", "s-2"),
            e(200, "mine-second", "s-1"),
            e(100, "mine-first", "s-1"), // duplicate key: same prompt, same ms
        ]
        .join("\n");
        fs::write(home.join(".claude").join("history.jsonl"), shared + "\n").unwrap();

        let dir = dir_of(&prepare_in(&home, "agent-o", Some("s-1")).unwrap());
        let seeded = fs::read_to_string(dir.join("history.jsonl")).unwrap();
        let order: Vec<&str> = seeded
            .lines()
            .map(|l| l.split("\"display\":\"").nth(1).unwrap().split('"').next().unwrap())
            .collect();
        assert_eq!(order, ["mine-first", "mine-second", "mine-third"]);
    }

    /// The file the ↑ list is read from must be repaired if an exiting process appended
    /// older prompts after a newer one — a slept agent flushing on its way out.
    #[test]
    fn a_late_flush_is_reordered_on_the_next_launch() {
        let home = fake_home("order-heal");
        let dir = dir_of(&prepare_in(&home, "agent-h", None).unwrap());
        fs::write(
            dir.join("history.jsonl"),
            "{\"display\":\"newer\",\"timestamp\":\"900\",\"sessionId\":\"s\"}\n\
             {\"display\":\"older\",\"timestamp\":\"100\",\"sessionId\":\"s\"}\n",
        )
        .unwrap();

        prepare_in(&home, "agent-h", None).unwrap();

        let healed = fs::read_to_string(dir.join("history.jsonl")).unwrap();
        let first = healed.lines().next().unwrap();
        assert!(first.contains("older"), "oldest must sit first: {healed:?}");
        assert!(healed.lines().nth(1).unwrap().contains("newer"));
    }

    /// An already-ordered file is left byte-for-byte alone — no needless rewrites.
    #[test]
    fn an_ordered_history_is_not_rewritten() {
        let home = fake_home("order-noop");
        let dir = dir_of(&prepare_in(&home, "agent-k", None).unwrap());
        let content = "{\"display\":\"a\",\"timestamp\":\"100\",\"sessionId\":\"s\"}\n\
                       {\"display\":\"b\",\"timestamp\":\"200\",\"sessionId\":\"s\"}\n";
        fs::write(dir.join("history.jsonl"), content).unwrap();
        let before = fs::metadata(dir.join("history.jsonl")).unwrap().modified().unwrap();
        prepare_in(&home, "agent-k", None).unwrap();
        assert_eq!(fs::read_to_string(dir.join("history.jsonl")).unwrap(), content);
        assert_eq!(
            fs::metadata(dir.join("history.jsonl")).unwrap().modified().unwrap(),
            before
        );
    }

    /// A live session is mid-append (it holds the proper-lockfile lock): leave the file
    /// to it rather than racing the write. The next launch repairs the order.
    #[test]
    fn a_locked_history_is_left_untouched() {
        let home = fake_home("order-lock");
        let dir = dir_of(&prepare_in(&home, "agent-l", None).unwrap());
        let jumbled = "{\"display\":\"newer\",\"timestamp\":\"900\",\"sessionId\":\"s\"}\n\
                       {\"display\":\"older\",\"timestamp\":\"100\",\"sessionId\":\"s\"}\n";
        fs::write(dir.join("history.jsonl"), jumbled).unwrap();
        fs::create_dir_all(dir.join("history.jsonl.lock")).unwrap();
        prepare_in(&home, "agent-l", None).unwrap();
        assert_eq!(fs::read_to_string(dir.join("history.jsonl")).unwrap(), jumbled);

        // Lock released -> repaired.
        fs::remove_dir_all(dir.join("history.jsonl.lock")).unwrap();
        prepare_in(&home, "agent-l", None).unwrap();
        assert!(fs::read_to_string(dir.join("history.jsonl")).unwrap().starts_with("{\"display\":\"older"));
    }

    /// The repair leaves no scratch file behind for Claude Code to trip over.
    #[test]
    fn repairing_leaves_no_temp_file() {
        let home = fake_home("order-tmp");
        let dir = dir_of(&prepare_in(&home, "agent-t", None).unwrap());
        fs::write(
            dir.join("history.jsonl"),
            "{\"display\":\"newer\",\"timestamp\":\"900\",\"sessionId\":\"s\"}\n\
             {\"display\":\"older\",\"timestamp\":\"100\",\"sessionId\":\"s\"}\n",
        )
        .unwrap();
        prepare_in(&home, "agent-t", None).unwrap();
        assert!(!dir.join("history.jsonl.tmp").exists());
        assert!(fs::read_to_string(dir.join("history.jsonl")).unwrap().starts_with("{\"display\":\"older"));
    }

    /// Unreadable lines are Claude Code's to ignore, not ours to delete — but they must
    /// not sit where a real entry belongs.
    #[test]
    fn unparseable_lines_survive_at_the_end() {
        let (out, changed) = ordered_history(
            "not json\n{\"display\":\"b\",\"timestamp\":\"200\",\"sessionId\":\"s\"}\n\
             {\"display\":\"a\",\"timestamp\":\"100\",\"sessionId\":\"s\"}\n",
        );
        assert!(changed);
        let lines: Vec<&str> = out.lines().collect();
        assert!(lines[0].contains("\"a\""), "{out:?}");
        assert!(lines[1].contains("\"b\""), "{out:?}");
        assert_eq!(lines[2], "not json");
    }

    /// No `~/.claude` means nothing to share: better to run with the default config dir
    /// than to hand the agent an empty home with none of the user's settings in it.
    #[test]
    fn a_missing_shared_home_is_an_error() {
        let home = std::env::temp_dir().join("codesu-claude-home-absent");
        let _ = fs::remove_dir_all(&home);
        assert!(prepare_in(&home, "agent-z", None).is_err());
    }
}


