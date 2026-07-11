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

/// Sanitize a branch name into a directory-safe segment.
fn sanitize(branch: &str) -> String {
    branch.replace(['/', ' ', ':'], "-")
}

/// Create a worktree under `<repo>/.worktrees/<branch>` on a new branch off `base_ref`.
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

    let mut path = PathBuf::from(repo);
    path.push(".worktrees");
    path.push(sanitize(branch));
    let path_str = path.to_string_lossy().to_string();

    git(
        repo,
        &["worktree", "add", "--track", "-b", branch, &path_str, &base],
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
    git(repo, &["worktree", "remove", "--force", worktree_path])?;
    if let Some(branch) = delete_branch.filter(|b| !b.is_empty()) {
        // Branch isn't auto-deleted with the worktree; ignore failure (may be checked out elsewhere).
        let _ = git(repo, &["branch", "-D", &branch]);
    }
    let _ = git(repo, &["worktree", "prune"]);
    Ok(())
}
