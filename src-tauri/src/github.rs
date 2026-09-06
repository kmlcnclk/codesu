//! Pull requests for a workspace, via the GitHub CLI.
//!
//! A workspace is a branch, and a branch's real review lives on GitHub — so the job here
//! is only to find the PRs and hand back their URLs. Nothing is fetched over HTTP
//! directly: `gh` already holds the user's credentials, understands enterprise hosts and
//! SSO, and refreshes its own tokens. Shelling out to it means Codesu never sees, stores
//! or has to rotate a token of its own.
//!
//! Commands are invoked with an explicit arg vector (never a shell string) and always
//! with `-C <repo>`-equivalent cwd, so a branch name can't inject.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    /// "OPEN", "MERGED" or "CLOSED", as GitHub reports it.
    pub state: String,
    pub is_draft: bool,
    /// The branch the PR is FROM — this is what ties a PR to a workspace.
    pub head_ref: String,
    pub author: String,
    pub updated_at: String,
    /// "APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED", or absent.
    pub review_decision: Option<String>,
    /// True when this PR's head branch is the workspace's own branch.
    pub is_current: bool,
}

/// The fields we ask `gh` for. Kept in one place so the struct and the query can't drift.
const PR_FIELDS: &str = "number,title,url,state,isDraft,headRefName,author,updatedAt,reviewDecision";

/// Directories a Homebrew/MacPorts/manual install of `gh` lands in, checked when the
/// inherited PATH does not have it.
const FALLBACK_BINS: &[&str] = &[
    "/opt/homebrew/bin",   // Homebrew on Apple silicon
    "/usr/local/bin",      // Homebrew on Intel, and most manual installs
    "/opt/local/bin",      // MacPorts
    "/home/linuxbrew/.linuxbrew/bin",
];

/// True if `path` is a file we can execute.
fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return std::fs::metadata(path)
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false);
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// Find `gh` in `path_var` (a PATH-shaped, colon-separated list).
fn find_in_path(path_var: &str) -> Option<PathBuf> {
    path_var
        .split(':')
        .filter(|d| !d.is_empty())
        .map(|d| Path::new(d).join("gh"))
        .find(|p| is_executable(p))
}

/// Locate the `gh` binary, once per process.
///
/// A GUI app launched from Finder or the Dock inherits a bare `/usr/bin:/bin` PATH, not
/// the one from the user's shell profile — so `Command::new("gh")` fails on a machine
/// where `gh` is plainly installed, which looks like a Codesu bug rather than a PATH one.
/// Three attempts, cheapest first: the inherited PATH, then the login shell's PATH (the
/// same trick the PTY code leans on), then the handful of directories package managers
/// actually use.
fn gh_bin() -> Option<&'static PathBuf> {
    static BIN: OnceLock<Option<PathBuf>> = OnceLock::new();
    BIN.get_or_init(|| {
        if let Some(found) = std::env::var("PATH").ok().and_then(|p| find_in_path(&p)) {
            return Some(found);
        }
        // `-l` runs the profile, which is where PATH is set up. Failure here is normal
        // (no shell, a profile that hangs is capped by the shell itself) and just falls
        // through to the fixed list below.
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        if let Ok(out) = Command::new(&shell).args(["-lc", "command -v gh"]).output() {
            if out.status.success() {
                let line = String::from_utf8_lossy(&out.stdout).trim().to_string();
                let candidate = PathBuf::from(&line);
                if !line.is_empty() && is_executable(&candidate) {
                    return Some(candidate);
                }
            }
        }
        FALLBACK_BINS
            .iter()
            .map(|d| Path::new(d).join("gh"))
            .find(|p| is_executable(p))
    })
    .as_ref()
}

/// Run `gh` inside `repo`, returning stdout or a useful error.
///
/// `gh` failing is the common case, not the exception — it may be missing, unauthenticated
/// or pointed at a repo with no GitHub remote — so the messages here are written for the
/// user rather than for a log.
fn gh(repo: &str, args: &[&str]) -> Result<String, String> {
    let bin = gh_bin()
        .ok_or("GitHub CLI (gh) not found — install it from https://cli.github.com")?;
    let output = Command::new(bin)
        .current_dir(repo)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run gh: {e}"))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }
    let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
    // gh's own wording for these two is long and CI-flavoured; say it plainly instead.
    if err.contains("not logged into") || err.contains("gh auth login") {
        return Err("Not signed in to GitHub — run `gh auth login` in a terminal.".into());
    }
    if err.contains("none of the git remotes configured for this repository") {
        return Err("This repository has no GitHub remote.".into());
    }
    Err(if err.is_empty() { "gh failed".into() } else { err })
}

/// One PR as `gh --json` returns it. Separate from [`PullRequest`] because the wire shape
/// is GitHub's to change and the app's is ours.
#[derive(serde::Deserialize)]
struct GhPr {
    number: u64,
    title: String,
    url: String,
    state: String,
    #[serde(rename = "isDraft")]
    is_draft: bool,
    #[serde(rename = "headRefName")]
    head_ref_name: String,
    author: Option<GhAuthor>,
    #[serde(rename = "updatedAt")]
    updated_at: String,
    #[serde(rename = "reviewDecision")]
    review_decision: Option<String>,
}

#[derive(serde::Deserialize)]
struct GhAuthor {
    login: Option<String>,
}

fn parse(json: &str, branch: Option<&str>) -> Result<Vec<PullRequest>, String> {
    let raw: Vec<GhPr> = serde_json::from_str(json).map_err(|e| format!("unreadable gh output: {e}"))?;
    Ok(raw
        .into_iter()
        .map(|p| PullRequest {
            is_current: branch.is_some_and(|b| b == p.head_ref_name),
            number: p.number,
            title: p.title,
            url: p.url,
            state: p.state,
            is_draft: p.is_draft,
            head_ref: p.head_ref_name,
            author: p.author.and_then(|a| a.login).unwrap_or_default(),
            updated_at: p.updated_at,
            // gh sends "" (not null) when no review has happened; an empty decision is
            // no decision, and the UI must not render a blank badge for it.
            review_decision: p.review_decision.filter(|d| !d.is_empty()),
        })
        .collect())
}

/// How many PRs one `--state all` sweep asks for. A response of exactly this many is
/// assumed truncated (see below), so it trades a slightly bigger page for the ability to
/// answer both questions in one round trip.
const SWEEP_LIMIT: usize = 60;

/// Pull requests worth showing for a workspace.
///
/// ONE `gh` invocation in the normal case, not two. Each spawn costs ~0.2s of process
/// start plus a network round trip, and this sits between switching workspace and the
/// titlebar telling you anything — so asking once for the recent PRs in every state, and
/// splitting them here, is worth more than the tidiness of two precise queries.
///
/// That sweep answers both questions at once: the workspace's OWN branch in any state (a
/// merged or closed PR is exactly what you want when checking what happened to a branch)
/// and the repo's open PRs for the rest of the list.
///
/// The one case it cannot answer alone is a repo with more than `SWEEP_LIMIT` recent PRs,
/// where an older open PR may have fallen off the page. A full page is the signal for
/// that, and only then is a second, open-only query made.
pub fn list_pull_requests(repo: &str, branch: Option<String>) -> Result<Vec<PullRequest>, String> {
    if !Path::new(repo).is_dir() {
        return Err(format!("not a directory: {repo}"));
    }
    let branch = branch.filter(|b| !b.trim().is_empty());
    let limit = SWEEP_LIMIT.to_string();

    let out = gh(
        repo,
        &["pr", "list", "--state", "all", "--limit", &limit, "--json", PR_FIELDS],
    )?;
    let sweep = parse(&out, branch.as_deref())?;
    let truncated = sweep.len() >= SWEEP_LIMIT;

    // Everything open, plus this branch's own PRs whatever state they are in. A closed PR
    // on someone else's branch is noise and is dropped here rather than in the UI.
    let mut prs: Vec<PullRequest> = sweep
        .into_iter()
        .filter(|p| p.state == "OPEN" || p.is_current)
        .collect();
    // The branch's own PRs lead, so the chip's PR is the first row of the menu.
    prs.sort_by_key(|p| !p.is_current);

    if truncated {
        let out = gh(
            repo,
            &["pr", "list", "--state", "open", "--limit", "100", "--json", PR_FIELDS],
        )?;
        for pr in parse(&out, branch.as_deref())? {
            if !prs.iter().any(|p| p.number == pr.number) {
                prs.push(pr);
            }
        }
    }
    Ok(prs)
}

/// The repository's GitHub URL, for "open the repo" when there are no PRs to show.
pub fn repo_url(repo: &str) -> Result<String, String> {
    if !Path::new(repo).is_dir() {
        return Err(format!("not a directory: {repo}"));
    }
    let out = gh(repo, &["repo", "view", "--json", "url", "--jq", ".url"])?;
    let url = out.trim().to_string();
    if url.is_empty() {
        return Err("could not resolve the repository URL".into());
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_pr_list_and_flags_the_workspaces_own_branch() {
        let json = r#"[
          {"number":42,"title":"Add project rail","url":"https://github.com/o/r/pull/42",
           "state":"OPEN","isDraft":false,"headRefName":"feat/rail",
           "author":{"login":"kmlcnclk"},"updatedAt":"2026-09-06T12:00:00Z",
           "reviewDecision":"APPROVED"},
          {"number":41,"title":"Other work","url":"https://github.com/o/r/pull/41",
           "state":"OPEN","isDraft":true,"headRefName":"chore/deps",
           "author":{"login":"someone"},"updatedAt":"2026-09-05T12:00:00Z",
           "reviewDecision":""}
        ]"#;
        let prs = parse(json, Some("feat/rail")).unwrap();
        assert_eq!(prs.len(), 2);
        assert!(prs[0].is_current, "the workspace's own branch must be flagged");
        assert_eq!(prs[0].review_decision.as_deref(), Some("APPROVED"));
        assert!(!prs[1].is_current);
        assert!(prs[1].is_draft);
        // gh reports "no decision yet" as an empty string, which must read as absent.
        assert_eq!(prs[1].review_decision, None);
        assert_eq!(prs[1].author, "someone");
    }

    #[test]
    fn a_pr_with_no_author_does_not_break_parsing() {
        // Ghost accounts come back as a null author; the list must survive one.
        let json = r#"[{"number":7,"title":"Old","url":"u","state":"MERGED","isDraft":false,
          "headRefName":"x","author":null,"updatedAt":"t","reviewDecision":null}]"#;
        let prs = parse(json, None).unwrap();
        assert_eq!(prs[0].author, "");
        assert!(!prs[0].is_current, "no branch given means nothing is current");
    }

    #[test]
    fn the_sweep_keeps_open_prs_and_this_branchs_own_but_drops_other_peoples_closed_ones() {
        let json = r#"[
          {"number":50,"title":"Someone else, closed","url":"u","state":"CLOSED","isDraft":false,
           "headRefName":"theirs","author":null,"updatedAt":"t","reviewDecision":""},
          {"number":49,"title":"Open elsewhere","url":"u","state":"OPEN","isDraft":false,
           "headRefName":"other","author":null,"updatedAt":"t","reviewDecision":""},
          {"number":48,"title":"Mine, merged","url":"u","state":"MERGED","isDraft":false,
           "headRefName":"mine","author":null,"updatedAt":"t","reviewDecision":""}
        ]"#;
        let sweep = parse(json, Some("mine")).unwrap();
        let mut kept: Vec<_> = sweep
            .into_iter()
            .filter(|p| p.state == "OPEN" || p.is_current)
            .collect();
        kept.sort_by_key(|p| !p.is_current);

        let numbers: Vec<u64> = kept.iter().map(|p| p.number).collect();
        // #50 is someone else's closed PR and is noise; #48 is this branch's history and
        // leads, because it is what the chip points at.
        assert_eq!(numbers, vec![48, 49]);
    }

    #[test]
    fn gh_is_found_on_a_path_that_has_it_and_not_on_one_that_does_not() {
        let dir = std::env::temp_dir().join(format!("codesu-gh-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("gh");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();

        // Present but not executable is not a usable gh.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert!(find_in_path(dir.to_str().unwrap()).is_none());
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        assert_eq!(find_in_path(dir.to_str().unwrap()).as_deref(), Some(bin.as_path()));
        // Empty segments and missing dirs must not panic or match.
        let joined = format!(":{}:/nope/nowhere", dir.display());
        assert_eq!(find_in_path(&joined).as_deref(), Some(bin.as_path()));
        assert!(find_in_path("/nope/nowhere").is_none());
        assert!(find_in_path("").is_none());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unreadable_output_is_an_error_not_a_panic() {
        assert!(parse("not json", None).is_err());
    }
}
