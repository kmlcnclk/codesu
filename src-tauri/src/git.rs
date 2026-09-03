//! Git worktree orchestration.
//!
//! Each agent-task can run in its own worktree + branch so parallel agents never
//! clobber each other. Commands are invoked with an explicit arg vector (never a
//! shell string) so branch/path values can't inject.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct Worktree {
    pub path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub locked: bool,
    pub is_main: bool,
}

/// Run a git command in `repo` and return stdout, or a trimmed stderr on failure.
fn git(repo: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Verify `repo` is inside a git working tree.
fn ensure_repo(repo: &str) -> Result<(), String> {
    if !Path::new(repo).is_dir() {
        return Err(format!("not a directory: {repo}"));
    }
    git(repo, &["rev-parse", "--is-inside-work-tree"])?;
    Ok(())
}

/// Check if a path is a git repository.
pub fn is_git_repo(path: &str) -> bool {
    if !Path::new(path).is_dir() {
        return false;
    }
    git(path, &["rev-parse", "--is-inside-work-tree"]).is_ok()
}

/// Sanitize a branch or repo name into a directory-safe segment.
fn sanitize(name: &str) -> String {
    name.replace(['/', ' ', ':'], "-")
}

/// Resolve the user's home directory (`$HOME`, or `%USERPROFILE%` on Windows).
fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "could not resolve home directory".into())
}

/// Central root for all codesu worktrees: `~/.codesu/worktrees`.
///
/// Worktrees live here — outside every repo — the way Conductor (`~/conductor/workspaces`)
/// and herdr (`~/.herdr/worktrees`) do, so they never pollute the source repo.
fn codesu_worktrees_root() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".codesu").join("worktrees"))
}

/// The last path segment of `repo`, used to group worktrees by repository.
fn repo_name(repo: &str) -> String {
    Path::new(repo)
        .file_name()
        .map(|n| sanitize(&n.to_string_lossy()))
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "repo".into())
}

/// Create a worktree under `~/.codesu/worktrees/<repo-name>/<branch>` on a new branch off `base_ref`.
pub fn create_worktree(
    repo: &str,
    branch: &str,
    base_ref: Option<String>,
) -> Result<Worktree, String> {
    ensure_repo(repo)?;
    if branch.trim().is_empty() {
        return Err("branch name is required".into());
    }
    let base = base_ref.filter(|b| !b.is_empty()).unwrap_or_else(|| "HEAD".into());

    let mut path = codesu_worktrees_root()?;
    path.push(repo_name(repo));
    path.push(sanitize(branch));

    // Ensure the parent (`~/.codesu/worktrees/<repo-name>`) exists; `git worktree add`
    // creates the leaf dir itself but not the intermediate ones.
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create worktree directory {}: {e}", parent.display()))?;
    }
    let path_str = path.to_string_lossy().to_string();

    // `--` before the positionals: without it a path or base ref that happens to start
    // with a dash (`--lock`, `-f`) is parsed as an option to `worktree add` instead of as
    // a value. `-b <branch>` is already safe — parse-options takes the following argv as
    // the option's value verbatim.
    git(
        repo,
        &["worktree", "add", "--track", "-b", branch, "--", &path_str, &base],
    )?;

    // Return the freshly-created entry.
    list_worktrees(repo)?
        .into_iter()
        .find(|w| w.path == path_str || w.branch.as_deref() == Some(branch))
        .ok_or_else(|| "worktree created but not found in listing".into())
}

/// List all worktrees for `repo` (parsed from `--porcelain`).
pub fn list_worktrees(repo: &str) -> Result<Vec<Worktree>, String> {
    ensure_repo(repo)?;
    let out = git(repo, &["worktree", "list", "--porcelain"])?;

    let mut worktrees = Vec::new();
    let mut cur: Option<Worktree> = None;
    let mut first = true;

    for line in out.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            if let Some(w) = cur.take() {
                worktrees.push(w);
            }
            cur = Some(Worktree {
                path: p.to_string(),
                branch: None,
                head: None,
                locked: false,
                is_main: first,
            });
            first = false;
        } else if let Some(w) = cur.as_mut() {
            if let Some(h) = line.strip_prefix("HEAD ") {
                w.head = Some(h.to_string());
            } else if let Some(b) = line.strip_prefix("branch ") {
                w.branch = Some(b.trim_start_matches("refs/heads/").to_string());
            } else if line == "locked" || line.starts_with("locked ") {
                w.locked = true;
            }
        }
    }
    if let Some(w) = cur.take() {
        worktrees.push(w);
    }
    Ok(worktrees)
}

/// Remove a worktree and, optionally, delete its branch. Never touches the main worktree.
pub fn remove_worktree(
    repo: &str,
    worktree_path: &str,
    delete_branch: Option<String>,
) -> Result<(), String> {
    ensure_repo(repo)?;
    // See `create_worktree`: `--` keeps a dash-leading path or branch name a positional.
    git(repo, &["worktree", "remove", "--force", "--", worktree_path])?;
    if let Some(branch) = delete_branch.filter(|b| !b.is_empty()) {
        // Branch isn't auto-deleted with the worktree; ignore failure (may be checked out elsewhere).
        let _ = git(repo, &["branch", "-D", "--", &branch]);
    }
    let _ = git(repo, &["worktree", "prune"]);
    Ok(())
}

// ---------- Review: status & diffs ----------

/// One path reported by `git status --porcelain=v1`.
///
/// `index` / `worktree` are the two raw status codes git prints (' ', 'M', 'A', 'D',
/// 'R', '?', …). Keeping them verbatim lets the UI show exactly what git would, rather
/// than collapsing "staged modification + unstaged modification" into one word.
#[derive(Serialize, Clone, Debug)]
pub struct FileChange {
    pub path: String,
    /// Absolute path on disk (worktree root + `path`). Empty for a deleted file.
    pub abs_path: String,
    pub index: String,
    pub worktree: String,
    pub staged: bool,
    pub untracked: bool,
    /// Original path of a rename, when git reported one.
    pub orig_path: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct RepoStatus {
    pub branch: Option<String>,
    /// Commits ahead of / behind the upstream, when there is one.
    pub ahead: u32,
    pub behind: u32,
    pub changes: Vec<FileChange>,
}

/// Absolute root of the working tree containing `repo`.
fn worktree_root(repo: &str) -> Result<String, String> {
    Ok(git(repo, &["rev-parse", "--show-toplevel"])?.trim().to_string())
}

/// Parse `git status --porcelain=v1 -z --branch` into a {@link RepoStatus}.
///
/// `-z` (NUL-separated, never quoted) is what makes a path with a space, a newline or a
/// non-ASCII byte survive intact — the default output would escape and quote it, and the
/// UI would then ask git to diff a path that does not exist. A rename record is two
/// NUL-terminated fields in a row (new path, then old), so the iterator has to be able
/// to pull an extra entry mid-loop.
fn parse_status(root: &str, out: &str) -> RepoStatus {
    let mut status = RepoStatus {
        branch: None,
        ahead: 0,
        behind: 0,
        changes: Vec::new(),
    };
    let mut it = out.split('\0').peekable();
    while let Some(rec) = it.next() {
        if rec.is_empty() {
            continue;
        }
        // `## main...origin/main [ahead 1, behind 2]`
        if let Some(head) = rec.strip_prefix("## ") {
            let name = head.split(" [").next().unwrap_or(head);
            let name = name.split("...").next().unwrap_or(name);
            if !name.starts_with("HEAD (no branch)") {
                status.branch = Some(name.trim().to_string());
            }
            if let Some(track) = head.split_once(" [").map(|(_, t)| t.trim_end_matches(']')) {
                for part in track.split(", ") {
                    if let Some(n) = part.strip_prefix("ahead ") {
                        status.ahead = n.trim().parse().unwrap_or(0);
                    } else if let Some(n) = part.strip_prefix("behind ") {
                        status.behind = n.trim().parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        if rec.len() < 4 {
            continue;
        }
        let mut chars = rec.chars();
        let index = chars.next().unwrap_or(' ');
        let worktree = chars.next().unwrap_or(' ');
        let path = rec[3..].to_string();
        // A rename/copy record is followed by its ORIGINAL path as the next NUL field.
        let orig_path = if index == 'R' || index == 'C' || worktree == 'R' || worktree == 'C' {
            it.next().map(|s| s.to_string()).filter(|s| !s.is_empty())
        } else {
            None
        };
        let untracked = index == '?' && worktree == '?';
        let deleted = index == 'D' || worktree == 'D';
        status.changes.push(FileChange {
            abs_path: if deleted {
                String::new()
            } else {
                Path::new(root).join(&path).to_string_lossy().to_string()
            },
            path,
            index: index.to_string(),
            worktree: worktree.to_string(),
            staged: index != ' ' && index != '?',
            untracked,
            orig_path,
        });
    }
    status.changes.sort_by(|a, b| a.path.cmp(&b.path));
    status
}

/// Working-tree status of `repo` — the file list the review panel is built from.
pub fn status(repo: &str) -> Result<RepoStatus, String> {
    ensure_repo(repo)?;
    let root = worktree_root(repo)?;
    let out = git(repo, &["status", "--porcelain=v1", "-z", "--branch"])?;
    Ok(parse_status(&root, &out))
}

/// Unified diff for one path.
///
/// `staged` picks the index-vs-HEAD diff instead of worktree-vs-index. An UNTRACKED file
/// has no git-side counterpart at all, so it is diffed against `/dev/null` with
/// `--no-index` (which exits 1 whenever there IS a difference — the normal case — so its
/// non-zero status is not treated as failure).
pub fn diff_file(repo: &str, path: &str, staged: bool, untracked: bool) -> Result<String, String> {
    ensure_repo(repo)?;
    if untracked {
        let root = worktree_root(repo)?;
        let abs = Path::new(&root).join(path);
        let out = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["diff", "--no-index", "--no-color", "--", "/dev/null"])
            .arg(&abs)
            .output()
            .map_err(|e| format!("failed to run git: {e}"))?;
        // `--no-index` exits 1 for "files differ", which is exactly what we asked for.
        return Ok(String::from_utf8_lossy(&out.stdout).to_string());
    }
    let mut args = vec!["diff", "--no-color"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(path);
    git(repo, &args)
}

/// Diff of everything not yet committed (staged + unstaged), for a whole-branch read.
pub fn diff_all(repo: &str, staged: bool) -> Result<String, String> {
    ensure_repo(repo)?;
    let mut args = vec!["diff", "--no-color"];
    if staged {
        args.push("--cached");
    }
    git(repo, &args)
}

/// Stage (`git add`) or unstage (`git restore --staged`) one path.
pub fn stage_file(repo: &str, path: &str, staged: bool) -> Result<(), String> {
    ensure_repo(repo)?;
    if staged {
        git(repo, &["add", "--", path])?;
    } else {
        git(repo, &["restore", "--staged", "--", path])?;
    }
    Ok(())
}
