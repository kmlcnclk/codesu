//! Workspace search: files by name, symbols by declaration, and plain text.
//!
//! Three questions an IDE has to answer instantly — "where is that file", "where is that
//! function", "where does this string appear" — over a monorepo with thousands of files.
//! What makes that possible here is an INDEX: one walk of the tree collects every file
//! path and every declaration line, and queries then run against memory. Without it,
//! every keystroke would re-walk the disk.
//!
//! The index is deliberately shallow. Symbols are found by reading declaration lines, not
//! by parsing — see `symbols_in`. Text search stays live (a grep, not an index), because
//! indexing file CONTENT would cost orders of magnitude more memory for a question that
//! is asked far less often.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

/// One search result.
#[derive(Serialize, Clone, Debug)]
pub struct Hit {
    /// "file" | "symbol" | "text" — which question this answers.
    pub kind: String,
    /// Absolute path, for opening it.
    pub path: String,
    /// Path relative to the workspace, for display.
    pub rel: String,
    /// File name, symbol name, or the matched line's text.
    pub name: String,
    /// Symbol keyword ("fun", "class"), or the containing directory for a file hit.
    pub detail: String,
    /// 1-based line to jump to; 0 for a file hit.
    pub line: u32,
    /// Match quality — the UI shows hits in the order given, best first.
    pub score: i32,
}

/// Directories never descended into. Build output and dependency trees hold far more
/// files than the source does, and a hit inside one is never what was being looked for.
const SKIP_DIRS: &[&str] = &[
    "node_modules", "target", "dist", "build", "out", ".git", ".svelte-kit", ".next",
    "vendor", "__pycache__", ".venv", "venv", ".gradle", ".idea", ".worktrees", "coverage",
    ".turbo", ".cache", "Pods", ".terraform",
];

/// Ceiling on the walk, so a workspace pointed at a home directory can't hang the app.
const MAX_FILES: usize = 120_000;
/// Files above this are not read for symbols or text (generated bundles, data dumps).
const MAX_READ_BYTES: u64 = 1024 * 1024;
/// How long an index is trusted before the next query rebuilds it.
const INDEX_TTL: Duration = Duration::from_secs(20);
/// Hits collected before a text search gives up — enough to rank meaningfully.
const MAX_TEXT_HITS: usize = 300;

#[derive(Clone, Debug)]
struct Symbol {
    name: String,
    keyword: &'static str,
    file: usize,
    line: u32,
}

struct Index {
    /// (absolute, relative) for every file in the workspace.
    files: Vec<(PathBuf, String)>,
    symbols: Vec<Symbol>,
    built: Instant,
}

fn cache() -> &'static Mutex<HashMap<PathBuf, Index>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Index>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn skip_dir(name: &str) -> bool {
    SKIP_DIRS.contains(&name) || (name.starts_with('.') && name != ".github")
}

/// Every file under `root`, breadth-first, pruning `SKIP_DIRS` before descending.
fn walk(root: &Path) -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Ok(kind) = entry.file_type() else { continue };
            // Symlinks are skipped rather than followed: a link back up the tree would
            // walk forever, and a link out of the workspace would index someone else's
            // files under this workspace's name.
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                if !skip_dir(&name) {
                    stack.push(entry.path());
                }
                continue;
            }
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let rel = path
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| name.clone());
            out.push((path, rel));
            if out.len() >= MAX_FILES {
                return out;
            }
        }
    }
    out
}

/// The declaration keywords worth indexing for a file extension.
///
/// One flat list per language family, matched as the FIRST meaningful token on a line.
/// That is what makes this cheap enough to run over a whole monorepo, and it is also why
/// a declaration split across lines, or one buried mid-expression, is missed — the
/// trade is deliberate (see the module docs).
fn keywords(ext: &str) -> Option<&'static [&'static str]> {
    Some(match ext {
        "kt" | "kts" | "java" | "scala" | "groovy" => {
            &["fun", "class", "object", "interface", "enum", "def", "trait", "record", "val"]
        }
        "rs" => &["fn", "struct", "enum", "trait", "impl", "type", "macro_rules!", "mod"],
        "py" => &["def", "class"],
        "go" => &["func", "type"],
        "js" | "jsx" | "mjs" | "cjs" | "ts" | "tsx" | "mts" | "cts" | "svelte" | "vue" => {
            &["function", "class", "interface", "type", "enum", "const", "let", "var"]
        }
        "c" | "h" | "cpp" | "hpp" | "cc" | "cs" | "php" | "swift" | "rb" | "dart" => {
            &["class", "struct", "enum", "func", "function", "def", "interface", "protocol"]
        }
        _ => return None,
    })
}

/// Strip whatever follows a declared name on its line: `foo(` , `Bar<T>` , `baz: Int`.
fn clean_name(token: &str) -> &str {
    let end = token
        .find(|c: char| !(c.is_alphanumeric() || c == '_' || c == '$'))
        .unwrap_or(token.len());
    &token[..end]
}

/// The declarations in one file.
fn symbols_in(text: &str, words: &'static [&'static str], file: usize, out: &mut Vec<Symbol>) {
    for (i, raw) in text.lines().enumerate() {
        let line = raw.trim_start();
        if line.is_empty() || line.starts_with("//") || line.starts_with('*') || line.starts_with('#')
        {
            // `#` would drop Python decorators too, but a decorator is never a
            // declaration itself — the `def` under it is the one indexed.
            continue;
        }
        // Walk the line's leading tokens: modifiers (`pub`, `export`, `suspend`, …) come
        // before the keyword, so the keyword is looked for in the first few words rather
        // than only in the first.
        let mut tokens = line.split_whitespace();
        for _ in 0..6 {
            let Some(token) = tokens.next() else { break };
            if let Some(&keyword) = words.iter().find(|w| **w == token) {
                let Some(next) = tokens.next() else { break };
                // Go methods: `func (r *Repo) Save(` — the receiver is not the name.
                let next = if keyword == "func" && next.starts_with('(') {
                    match tokens.find(|t| !t.ends_with(')')) {
                        Some(t) => t,
                        None => break,
                    }
                } else {
                    next
                };
                let name = clean_name(next);
                if !name.is_empty() && name.chars().next().is_some_and(|c| c.is_alphabetic() || c == '_')
                {
                    out.push(Symbol { name: name.to_string(), keyword, file, line: i as u32 + 1 });
                }
                break;
            }
        }
    }
}

/// Whether `bytes` looks like a text file (same NUL sniff the editor uses).
fn is_text(bytes: &[u8]) -> bool {
    !bytes.iter().take(8192).any(|b| *b == 0)
}

fn build_index(root: &Path) -> Index {
    let files = walk(root);
    let mut symbols = Vec::new();
    for (i, (path, _)) in files.iter().enumerate() {
        let Some(ext) = path.extension().and_then(|e| e.to_str()) else { continue };
        let Some(words) = keywords(&ext.to_ascii_lowercase()) else { continue };
        if std::fs::metadata(path).map(|m| m.len() > MAX_READ_BYTES).unwrap_or(true) {
            continue;
        }
        let Ok(bytes) = std::fs::read(path) else { continue };
        if !is_text(&bytes) {
            continue;
        }
        symbols_in(&String::from_utf8_lossy(&bytes), words, i, &mut symbols);
    }
    Index { files, symbols, built: Instant::now() }
}

/**
 * Fuzzy subsequence score, or None when `query` is not a subsequence of `haystack`.
 *
 * Both are expected lowercase. The shape of the scoring is what makes a picker feel
 * right: a run of adjacent characters beats scattered ones, a match at the start of a
 * word (or after a separator) beats one mid-word, and a shorter haystack wins ties — so
 * typing "runp" puts `RunPanel.svelte` above `src/lib/runner/panel-helpers.ts`.
 */
fn fuzzy(query: &str, haystack: &str) -> Option<i32> {
    if query.is_empty() {
        return Some(0);
    }
    let hay: Vec<char> = haystack.chars().collect();
    let mut score = 0i32;
    let mut last = usize::MAX;
    for qc in query.chars() {
        let start = if last == usize::MAX { 0 } else { last + 1 };
        let found = hay[start..].iter().position(|c| *c == qc)? + start;
        if last != usize::MAX && found == last + 1 {
            score += 12; // consecutive
        }
        let boundary = found == 0
            || matches!(hay[found - 1], '/' | '_' | '-' | '.' | ' ' | ':');
        if boundary {
            score += 10;
        }
        score -= (found.saturating_sub(if last == usize::MAX { 0 } else { last + 1 }) as i32).min(6);
        last = found;
    }
    // Prefer tight matches: a query filling most of the haystack ranks above one lost in
    // a long path.
    score += (40 - (hay.len() as i32 - query.chars().count() as i32).min(40)).max(0) / 2;
    Some(score)
}

/// Case-insensitive `find`, ASCII-folded — enough for source code and far cheaper than
/// allocating a lowercase copy of every line.
fn find_ci(haystack: &str, needle_lower: &str) -> Option<usize> {
    let h = haystack.as_bytes();
    let n = needle_lower.as_bytes();
    if n.is_empty() || h.len() < n.len() {
        return None;
    }
    (0..=h.len() - n.len()).find(|&i| {
        (0..n.len()).all(|j| h[i + j].to_ascii_lowercase() == n[j])
    })
}

fn base_name(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

fn dir_of(rel: &str) -> &str {
    match rel.rfind('/') {
        Some(i) => &rel[..i],
        None => "",
    }
}

/// Search `root` for `query`. `kind` is "file", "symbol" or "text".
pub fn search(root: &str, query: &str, kind: &str, limit: usize) -> Result<Vec<Hit>, String> {
    let root = Path::new(root.trim());
    if !root.is_dir() {
        return Err(format!("not a directory: {}", root.display()));
    }
    let root = std::fs::canonicalize(root).map_err(|e| format!("cannot resolve workspace: {e}"))?;
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let needle = query.to_lowercase();
    let limit = limit.clamp(1, 200);

    let mut guard = cache().lock().map_err(|_| "search index is poisoned".to_string())?;
    let stale = guard.get(&root).is_none_or(|i| i.built.elapsed() > INDEX_TTL);
    if stale {
        // Built while holding the lock: two queries racing in would otherwise walk the
        // same tree twice, and the walk is the expensive part.
        let index = build_index(&root);
        guard.insert(root.clone(), index);
    }
    let index = guard.get(&root).expect("just inserted");

    let mut hits: Vec<Hit> = Vec::new();
    match kind {
        "file" => {
            for (path, rel) in &index.files {
                let name = base_name(rel);
                // Score the file NAME and the whole path separately and keep the better:
                // "api.ts" should win on its name, "code/api" on its path.
                let by_name = fuzzy(&needle, &name.to_lowercase()).map(|s| s + 30);
                let by_path = fuzzy(&needle, &rel.to_lowercase());
                let Some(score) = by_name.into_iter().chain(by_path).max() else { continue };
                hits.push(Hit {
                    kind: "file".into(),
                    path: path.to_string_lossy().to_string(),
                    rel: rel.clone(),
                    name: name.to_string(),
                    detail: dir_of(rel).to_string(),
                    line: 0,
                    score,
                });
            }
        }
        "symbol" => {
            for symbol in &index.symbols {
                let Some(score) = fuzzy(&needle, &symbol.name.to_lowercase()) else { continue };
                let (path, rel) = &index.files[symbol.file];
                hits.push(Hit {
                    kind: "symbol".into(),
                    path: path.to_string_lossy().to_string(),
                    rel: rel.clone(),
                    name: symbol.name.clone(),
                    detail: symbol.keyword.to_string(),
                    line: symbol.line,
                    score,
                });
            }
        }
        "text" => {
            for (path, rel) in &index.files {
                if hits.len() >= MAX_TEXT_HITS {
                    break;
                }
                if std::fs::metadata(path).map(|m| m.len() > MAX_READ_BYTES).unwrap_or(true) {
                    continue;
                }
                let Ok(bytes) = std::fs::read(path) else { continue };
                if !is_text(&bytes) {
                    continue;
                }
                for (i, line) in String::from_utf8_lossy(&bytes).lines().enumerate() {
                    let Some(at) = find_ci(line, &needle) else { continue };
                    hits.push(Hit {
                        kind: "text".into(),
                        path: path.to_string_lossy().to_string(),
                        rel: rel.clone(),
                        // Long lines are trimmed around the match so the result row shows
                        // the hit rather than the start of a minified file.
                        name: snippet(line, at),
                        detail: format!("{}:{}", base_name(rel), i + 1),
                        line: i as u32 + 1,
                        // Earlier in the line and shorter lines rank higher — a match in
                        // `val x = foo()` is more likely the one wanted than one inside a
                        // 300-character log message.
                        score: 100 - (at as i32).min(60) - (line.len() as i32 / 40).min(30),
                    });
                    if hits.len() >= MAX_TEXT_HITS {
                        break;
                    }
                }
            }
        }
        other => return Err(format!("unknown search kind: {other}")),
    }

    hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.rel.cmp(&b.rel)).then(a.line.cmp(&b.line)));
    hits.truncate(limit);
    Ok(hits)
}

/// A window of `line` around the match at `at`, with an ellipsis when cut.
fn snippet(line: &str, at: usize) -> String {
    const WIDTH: usize = 160;
    let trimmed = line.trim_start();
    let lost = line.len() - trimmed.len();
    let at = at.saturating_sub(lost);
    if trimmed.len() <= WIDTH {
        return trimmed.to_string();
    }
    let start = at.saturating_sub(40);
    // Char boundaries: slicing UTF-8 by byte offset would panic mid-codepoint.
    let start = (0..=start).rev().find(|i| trimmed.is_char_boundary(*i)).unwrap_or(0);
    let end = (start + WIDTH).min(trimmed.len());
    let end = (start..=end).rev().find(|i| trimmed.is_char_boundary(*i)).unwrap_or(trimmed.len());
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.push_str(&trimmed[start..end]);
    if end < trimmed.len() {
        out.push('…');
    }
    out
}

/// Build the index for `root` if it is missing or stale, so the first keystroke in the
/// palette answers from memory.
///
/// Walking a monorepo and reading every declaration takes a noticeable moment — paying it
/// when the Code view opens, rather than when the user is waiting on a search, is the
/// difference between an instant picker and a laggy one.
pub fn warm(root: &str) {
    let Ok(path) = std::fs::canonicalize(Path::new(root.trim())) else { return };
    if !path.is_dir() {
        return;
    }
    let fresh = cache()
        .lock()
        .map(|g| g.get(&path).is_some_and(|i| i.built.elapsed() <= INDEX_TTL))
        .unwrap_or(false);
    if fresh {
        return;
    }
    let index = build_index(&path);
    if let Ok(mut guard) = cache().lock() {
        guard.insert(path, index);
    }
}

/// Drop a workspace's index, so the next query re-walks the tree.
///
/// The TTL already covers ordinary edits; this is for the explicit "refresh" the file
/// tree offers, where the user is telling us the tree changed and expects to see it.
pub fn invalidate(root: &str) {
    let Ok(path) = std::fs::canonicalize(Path::new(root.trim())) else { return };
    if let Ok(mut guard) = cache().lock() {
        guard.remove(&path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The repository this crate lives in — a real tree to index, without inventing one.
    fn repo() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
    }

    #[test]
    fn ranks_the_name_match_above_the_path_match() {
        let by_name = fuzzy("runp", "runpanel.svelte").unwrap();
        let scattered = fuzzy("runp", "src/lib/runner/panel-helpers.ts").unwrap();
        assert!(by_name > scattered, "{by_name} !> {scattered}");
    }

    #[test]
    fn a_non_subsequence_does_not_match() {
        assert!(fuzzy("zzz", "runpanel.svelte").is_none());
    }

    #[test]
    fn word_starts_beat_mid_word_hits() {
        // "tg" as the initials of two path segments, vs. buried inside one word.
        let initials = fuzzy("tg", "test/gutter.ts").unwrap();
        let buried = fuzzy("tg", "lightgrey.ts").unwrap();
        assert!(initials > buried, "{initials} !> {buried}");
    }

    #[test]
    fn finds_a_file_by_a_fragment_of_its_name() {
        let hits = search(repo().to_str().unwrap(), "tstgutter", "file", 20).unwrap();
        assert!(
            hits.iter().any(|h| h.rel.ends_with("code/testGutter.ts")),
            "got {:?}",
            hits.iter().map(|h| &h.rel).collect::<Vec<_>>()
        );
    }

    #[test]
    fn build_output_is_not_indexed() {
        let hits = search(repo().to_str().unwrap(), "js", "file", 200).unwrap();
        assert!(
            !hits.iter().any(|h| h.rel.contains("node_modules") || h.rel.starts_with("build/")),
            "a skipped directory leaked into the index"
        );
    }

    #[test]
    fn finds_a_rust_declaration_by_name() {
        let hits = search(repo().to_str().unwrap(), "invalidate", "symbol", 30).unwrap();
        let hit = hits
            .iter()
            .find(|h| h.name == "invalidate" && h.rel.ends_with("search.rs"))
            .unwrap_or_else(|| panic!("got {:?}", hits.iter().map(|h| &h.name).collect::<Vec<_>>()));
        assert_eq!(hit.detail, "fn");
        assert!(hit.line > 0);
    }

    #[test]
    fn text_search_reports_the_matching_line() {
        let hits = search(repo().to_str().unwrap(), "unknown search kind", "text", 10).unwrap();
        let hit = hits.iter().find(|h| h.rel.ends_with("search.rs")).expect("no hit in search.rs");
        assert!(hit.name.contains("unknown search kind"), "{}", hit.name);
        assert!(hit.line > 0);
    }

    /// The scanners that decide what a declaration looks like, on one line each.
    #[test]
    fn declaration_shapes_per_language() {
        let cases: &[(&str, &str, &str, &str)] = &[
            ("kt", "    private suspend fun syncProducts() {", "syncProducts", "fun"),
            ("kt", "class SqualoRunner {", "SqualoRunner", "class"),
            ("rs", "pub async fn resolve(root: &str) -> Result<()> {", "resolve", "fn"),
            ("py", "    def test_finds(self):", "test_finds", "def"),
            ("go", "func (r *Repo) Save(x int) error {", "Save", "func"),
            ("go", "func Resolve(t *testing.T) {", "Resolve", "func"),
            ("ts", "export const resolveTestCommand = async () => {", "resolveTestCommand", "const"),
            ("ts", "export interface TestTarget {", "TestTarget", "interface"),
        ];
        for (ext, line, name, keyword) in cases {
            let mut out = Vec::new();
            symbols_in(line, keywords(ext).unwrap(), 0, &mut out);
            assert_eq!(out.len(), 1, "{line}");
            assert_eq!(out[0].name, *name, "{line}");
            assert_eq!(out[0].keyword, *keyword, "{line}");
        }
    }

    #[test]
    fn comments_are_not_declarations() {
        for line in ["// fun notAFunction() {", " * fun alsoNot() {", "# def neither():"] {
            let mut out = Vec::new();
            symbols_in(line, keywords("kt").unwrap(), 0, &mut out);
            assert!(out.is_empty(), "{line}");
        }
    }

    #[test]
    fn a_long_line_is_trimmed_around_the_match() {
        let line = format!("{}NEEDLE{}", "a".repeat(300), "b".repeat(300));
        let s = snippet(&line, 300);
        assert!(s.contains("NEEDLE"), "{s}");
        assert!(s.starts_with('…') && s.ends_with('…'), "{s}");
        assert!(s.chars().count() < 200, "{}", s.chars().count());
    }

    #[test]
    fn multibyte_lines_do_not_panic() {
        let line = format!("{}NEEDLE{}", "ü".repeat(200), "ş".repeat(200));
        let at = line.find("NEEDLE").unwrap();
        assert!(snippet(&line, at).contains("NEEDLE"));
    }

    #[test]
    fn case_insensitive_find() {
        assert_eq!(find_ci("Hello World", "hello"), Some(0));
        assert_eq!(find_ci("Hello World", "world"), Some(6));
        assert_eq!(find_ci("Hello", "xyz"), None);
    }
}

