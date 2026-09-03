//! Filesystem access for the built-in code editor.
//!
//! Every command takes the workspace `root` alongside the target `path` and refuses
//! anything that does not resolve INSIDE that root. The webview can reach these
//! commands, so a bare `path` would make `read_text_file("~/.ssh/id_rsa")` a one-line
//! call away — the same reasoning as `allow_asset` in `lib.rs`. Containment is checked
//! on the CANONICAL path, so a symlink pointing out of the workspace is rejected on
//! what it actually opens rather than on how it is spelled.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;

/// Largest file the editor will open. Past this the UI shows "too large" rather than
/// handing a multi-megabyte string to CodeMirror (and to the IPC bridge).
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// How much of a file to sniff for NUL bytes when deciding "is this binary".
const BINARY_SNIFF_BYTES: usize = 8192;

/// Directory names never worth walking in a source tree. They are still LISTED (so the
/// tree shows them) but marked `heavy`, and the UI collapses them by default.
const HEAVY_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".git",
    ".svelte-kit",
    ".next",
    "vendor",
    "__pycache__",
    ".venv",
    ".gradle",
    ".idea",
];

#[derive(Serialize, Clone, Debug)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// A dotfile / dot-directory — hidden behind the tree's "show hidden" toggle.
    pub hidden: bool,
    /// A build/dependency directory (see `HEAVY_DIRS`).
    pub heavy: bool,
    pub size: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct FileContent {
    pub path: String,
    pub content: String,
    /// Set when the file was refused: "too-large" | "binary". `content` is then empty.
    pub refused: Option<String>,
    pub size: u64,
    /// Modification time (ms since epoch), used to detect an outside edit before a save.
    pub modified_ms: u64,
}

/// Canonicalize `root` once, so every containment check compares like with like.
fn canonical_root(root: &str) -> Result<PathBuf, String> {
    let root = Path::new(root.trim());
    if !root.is_absolute() {
        return Err(format!("workspace root must be absolute: {}", root.display()));
    }
    std::fs::canonicalize(root).map_err(|e| format!("cannot resolve workspace {}: {e}", root.display()))
}

/// Reject a path containing `..` before it ever touches the filesystem.
///
/// Canonicalization alone would catch an escape, but only for a path that EXISTS —
/// `write_text_file` creates its target, so a brand-new `a/../../../etc/x` would have
/// nothing to canonicalize. Screening the components covers both cases.
fn reject_traversal(path: &Path) -> Result<(), String> {
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("path may not contain `..`: {}", path.display()));
    }
    Ok(())
}

/// Resolve `path` and assert it sits inside `root`. Used for reads, where the target
/// must already exist.
pub fn resolve_inside(root: &str, path: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = canonical_root(root)?;
    let raw = Path::new(path.trim());
    reject_traversal(raw)?;
    let target =
        std::fs::canonicalize(raw).map_err(|e| format!("cannot resolve {}: {e}", raw.display()))?;
    if !target.starts_with(&root) {
        return Err(format!("path is outside the workspace: {}", raw.display()));
    }
    Ok((root, target))
}

/// Like `resolve_inside`, but for a path that may not exist yet: the containment check
/// is made against the canonical PARENT directory (which must exist).
fn resolve_inside_for_write(root: &str, path: &str) -> Result<PathBuf, String> {
    let root = canonical_root(root)?;
    let raw = Path::new(path.trim());
    reject_traversal(raw)?;
    if !raw.is_absolute() {
        return Err(format!("path must be absolute: {}", raw.display()));
    }
    let parent = raw
        .parent()
        .ok_or_else(|| format!("path has no parent directory: {}", raw.display()))?;
    let parent = std::fs::canonicalize(parent)
        .map_err(|e| format!("cannot resolve {}: {e}", parent.display()))?;
    if !parent.starts_with(&root) {
        return Err(format!("path is outside the workspace: {}", raw.display()));
    }
    // An EXISTING target must itself resolve inside the root — a symlink in a contained
    // directory can still point anywhere.
    if raw.exists() {
        let target = std::fs::canonicalize(raw)
            .map_err(|e| format!("cannot resolve {}: {e}", raw.display()))?;
        if !target.starts_with(&root) {
            return Err(format!("path is outside the workspace: {}", raw.display()));
        }
        if target.is_dir() {
            return Err(format!("is a directory: {}", raw.display()));
        }
    }
    let name = raw
        .file_name()
        .ok_or_else(|| format!("path has no file name: {}", raw.display()))?;
    Ok(parent.join(name))
}

fn modified_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// One directory level of `path` (never recursive — the tree loads lazily, so a repo
/// with a huge `node_modules` costs nothing until it is expanded).
///
/// Directories sort before files, each alphabetically (case-insensitive), which is the
/// ordering every file tree the user already knows uses.
pub fn list_dir(root: &str, path: &str) -> Result<Vec<DirEntry>, String> {
    let (_, dir) = resolve_inside(root, path)?;
    if !dir.is_dir() {
        return Err(format!("not a directory: {}", dir.display()));
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue, // an unreadable entry must not fail the whole listing
        };
        let name = entry.file_name().to_string_lossy().to_string();
        // `file_type` does not follow symlinks; a link to a directory should still show
        // as one, so fall back to a following stat when the entry is a link.
        let meta = entry.metadata().ok();
        let is_dir = match meta.as_ref() {
            Some(m) if m.is_symlink() => entry.path().is_dir(),
            Some(m) => m.is_dir(),
            None => entry.path().is_dir(),
        };
        out.push(DirEntry {
            hidden: name.starts_with('.'),
            heavy: is_dir && HEAVY_DIRS.contains(&name.as_str()),
            path: entry.path().to_string_lossy().to_string(),
            size: meta.as_ref().filter(|_| !is_dir).map(|m| m.len()).unwrap_or(0),
            name,
            is_dir,
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// Read a text file for the editor.
///
/// Refusals (`too-large`, `binary`) come back as an Ok value with `refused` set, not an
/// Err: "this file isn't editable here" is a normal thing for the editor to display,
/// while an Err is reserved for "the read actually failed".
pub fn read_text_file(root: &str, path: &str) -> Result<FileContent, String> {
    let (_, file) = resolve_inside(root, path)?;
    let meta = std::fs::metadata(&file).map_err(|e| format!("cannot stat {}: {e}", file.display()))?;
    if !meta.is_file() {
        return Err(format!("not a regular file: {}", file.display()));
    }
    let path_str = file.to_string_lossy().to_string();
    let size = meta.len();
    let modified = modified_ms(&meta);
    if size > MAX_FILE_BYTES {
        return Ok(FileContent {
            path: path_str,
            content: String::new(),
            refused: Some("too-large".into()),
            size,
            modified_ms: modified,
        });
    }
    let bytes = std::fs::read(&file).map_err(|e| format!("cannot read {}: {e}", file.display()))?;
    if bytes.iter().take(BINARY_SNIFF_BYTES).any(|b| *b == 0) {
        return Ok(FileContent {
            path: path_str,
            content: String::new(),
            refused: Some("binary".into()),
            size,
            modified_ms: modified,
        });
    }
    // Lossy on purpose: a file with a stray invalid byte is still worth showing, and
    // the editor refuses to SAVE a file it could not decode exactly (see `write`).
    Ok(FileContent {
        path: path_str,
        content: String::from_utf8_lossy(&bytes).to_string(),
        refused: None,
        size,
        modified_ms: modified,
    })
}

/// Overwrite a file with `content`, returning its new mtime.
///
/// `expect_modified_ms` guards against clobbering an edit made outside the app (by an
/// agent, git, or another editor) since the buffer was loaded: pass the mtime the UI
/// last saw and the write is refused if the file has moved on. `None` forces the write.
pub fn write_text_file(
    root: &str,
    path: &str,
    content: &str,
    expect_modified_ms: Option<u64>,
) -> Result<u64, String> {
    let file = resolve_inside_for_write(root, path)?;
    if let Some(expected) = expect_modified_ms {
        if let Ok(meta) = std::fs::metadata(&file) {
            let actual = modified_ms(&meta);
            // Only a NEWER file is a conflict; an equal or (clock-skewed) older stamp is
            // the file we loaded. Zero means "mtime unavailable" — never block on it.
            if expected != 0 && actual != 0 && actual > expected {
                return Err("changed-on-disk".into());
            }
        }
    }
    std::fs::write(&file, content).map_err(|e| format!("cannot write {}: {e}", file.display()))?;
    let meta = std::fs::metadata(&file).map_err(|e| format!("cannot stat {}: {e}", file.display()))?;
    Ok(modified_ms(&meta))
}
