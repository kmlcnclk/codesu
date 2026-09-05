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
    read_text_at(file)
}

/// Read one file by absolute path, with NO workspace containment check.
///
/// Attachments are the reason this exists: a user drags in a README from another
/// checkout entirely, and `resolve_inside` would (correctly) refuse it — the editor's
/// root scoping is about the file TREE, and an attachment is not part of one. The
/// caller is responsible for having a legitimate reason to name this path; the size
/// and binary guards below are shared with the scoped reader either way.
pub fn read_attachment(path: &str) -> Result<FileContent, String> {
    let raw = Path::new(path.trim());
    reject_traversal(raw)?;
    if !raw.is_absolute() {
        return Err(format!("path must be absolute: {}", raw.display()));
    }
    let file = std::fs::canonicalize(raw)
        .map_err(|e| format!("cannot resolve {}: {e}", raw.display()))?;
    read_text_at(file)
}

/// The shared body of both readers: refuse anything too large or binary, and decode
/// the rest lossily so a stray invalid byte still shows.
fn read_text_at(file: PathBuf) -> Result<FileContent, String> {
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


// ---------- clipboard attachments ----------

/// Largest pasted attachment accepted, decoded. Claude reads these off disk, so the
/// cap is about not silently filling the temp dir with a stray 100MB paste.
const MAX_PASTE_BYTES: usize = 20 * 1024 * 1024;

/// Where pasted attachments land. Outside any workspace on purpose: a paste is not a
/// project file, and writing one into the repo would show up in the agent's own
/// `git status`.
fn paste_dir() -> PathBuf {
    std::env::temp_dir().join("codesu-pastes")
}

/// Write a clipboard image to a temp file and return its absolute path.
///
/// A pasted image has no path, and an agent needs one, so the bytes have to land on
/// disk before they can be attached.
///
/// The bytes arrive base64-encoded because the alternative — a JSON array of numbers —
/// inflates a 2MB screenshot into a ~7MB IPC message. `ext` is sanitised rather than
/// trusted: it reaches a filename, and it comes from a MIME type the webview handed us.
pub fn save_pasted_file(data_b64: &str, ext: &str) -> Result<String, String> {
    use base64::Engine as _;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.trim())
        .map_err(|e| format!("cannot decode paste: {e}"))?;
    if bytes.is_empty() {
        return Err("empty paste".into());
    }
    if bytes.len() > MAX_PASTE_BYTES {
        return Err(format!(
            "paste is {:.1}MB — the limit is {}MB",
            bytes.len() as f64 / (1024.0 * 1024.0),
            MAX_PASTE_BYTES / (1024 * 1024)
        ));
    }

    let ext: String = ext
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect::<String>()
        .to_ascii_lowercase();
    let ext = if ext.is_empty() { "png".to_string() } else { ext };

    let dir = paste_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;

    // Timestamp + counter: a name a person can recognise in the prompt.
    //
    // Claimed with create_new (O_EXCL), NOT exists()-then-write: two panes pasting in
    // the same millisecond both pass an existence check, and the second write then
    // silently replaces the first one's image.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    for n in 0..1000 {
        let file = if n == 0 {
            dir.join(format!("paste-{stamp}.{ext}"))
        } else {
            dir.join(format!("paste-{stamp}-{}.{ext}", n + 1))
        };
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&file) {
            Ok(mut handle) => {
                use std::io::Write as _;
                handle
                    .write_all(&bytes)
                    .map_err(|e| format!("cannot write {}: {e}", file.display()))?;
                return Ok(file.to_string_lossy().into_owned());
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("cannot create {}: {e}", file.display())),
        }
    }
    Err("could not find a free name for the paste".into())
}

#[cfg(test)]
mod paste_tests {
    use super::*;
    use base64::Engine as _;

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn writes_the_decoded_bytes_and_returns_the_path() {
        let png = [0x89u8, b'P', b'N', b'G', 1, 2, 3];
        let path = save_pasted_file(&b64(&png), "png").expect("should save");
        assert!(path.ends_with(".png"), "kept the extension: {path}");
        assert_eq!(std::fs::read(&path).unwrap(), png, "bytes round-trip");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sanitises_the_extension_it_is_handed() {
        // A MIME subtype like "svg+xml", or anything path-ish, must not reach the name.
        let path = save_pasted_file(&b64(b"x"), "../../etc/pas swd").expect("should save");
        let name = Path::new(&path).file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with("paste-"), "name is ours: {name}");
        assert!(name.ends_with(".etcpassw"), "alnum-only, capped at 8: {name}");
        assert_eq!(name.matches('.').count(), 1, "no extra path parts: {name}");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn falls_back_to_png_when_the_extension_is_unusable() {
        let path = save_pasted_file(&b64(b"x"), "///").expect("should save");
        assert!(path.ends_with(".png"), "{path}");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn rejects_empty_and_undecodable_pastes() {
        assert!(save_pasted_file("", "png").is_err(), "empty");
        assert!(save_pasted_file("!!!not base64!!!", "png").is_err(), "garbage");
    }

    #[test]
    fn two_pastes_in_the_same_millisecond_do_not_collide() {
        let a = save_pasted_file(&b64(b"a"), "png").unwrap();
        let b = save_pasted_file(&b64(b"b"), "png").unwrap();
        assert_ne!(a, b, "distinct paths");
        assert_eq!(std::fs::read(&a).unwrap(), b"a");
        assert_eq!(std::fs::read(&b).unwrap(), b"b");
        let _ = std::fs::remove_file(a);
        let _ = std::fs::remove_file(b);
    }
}
