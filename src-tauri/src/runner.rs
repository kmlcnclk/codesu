//! Discovery of the commands a workspace can run.
//!
//! The point is to answer "what would I click Run on in an IDE?" without asking the user
//! to type a command: package.json scripts, Makefile targets, Cargo/Gradle/Go/Python
//! entry points and the shell scripts sitting in the repo. Nothing here EXECUTES
//! anything — a chosen script is handed back to the UI, which runs it in a normal PTY
//! (the same machinery the terminal and agents use), so output, input and killing all
//! behave exactly as they already do.

use std::path::Path;

use serde::Serialize;

/// A runnable command offered by the Run panel.
#[derive(Serialize, Clone, Debug)]
pub struct Script {
    /// Stable id (`<source>:<name>`), used as the PTY session key.
    pub id: String,
    pub name: String,
    /// The shell line to run, relative to `cwd`.
    pub command: String,
    /// Where it came from: "npm" | "make" | "cargo" | "gradle" | "go" | "python" | "shell".
    pub source: String,
    /// Absolute directory to run it in (a sub-project's own folder, not always the root).
    pub cwd: String,
    /// The file the entry was discovered in, shown as a subtitle.
    pub file: String,
}

/// Directories never descended into when looking for sub-projects or shell scripts.
const SKIP_DIRS: &[&str] = &[
    "node_modules", "target", "dist", "build", ".git", ".svelte-kit", ".next", "vendor",
    "__pycache__", ".venv", "venv", ".gradle", ".idea", ".worktrees", "coverage",
];

/// How deep to look for nested projects (a monorepo's `packages/*`, `src-tauri`, …).
const MAX_DEPTH: usize = 2;

fn skip(name: &str) -> bool {
    name.starts_with('.') && name != ".config" || SKIP_DIRS.contains(&name)
}

/// The package manager a JS project uses, decided by its lockfile so the Run panel
/// doesn't offer `npm run dev` in a pnpm workspace (which would build a second, divergent
/// `node_modules`). Falls back to npm when there is no lockfile.
fn js_runner(dir: &Path, root: &Path) -> &'static str {
    for d in [dir, root] {
        if d.join("pnpm-lock.yaml").exists() {
            return "pnpm";
        }
        if d.join("yarn.lock").exists() {
            return "yarn";
        }
        if d.join("bun.lockb").exists() || d.join("bun.lock").exists() {
            return "bun";
        }
        if d.join("package-lock.json").exists() {
            return "npm";
        }
    }
    "npm"
}

/// Path of `dir` relative to `root`, for display ("" at the root itself).
fn rel(root: &Path, dir: &Path) -> String {
    dir.strip_prefix(root)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Prefix a discovered name with its sub-directory, so two `dev` scripts in a monorepo
/// stay distinguishable.
fn scoped(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix} › {name}")
    }
}

fn push(out: &mut Vec<Script>, source: &str, name: String, command: String, cwd: &Path, file: String) {
    out.push(Script {
        id: format!("{source}:{name}:{}", cwd.to_string_lossy()),
        name,
        command,
        source: source.to_string(),
        cwd: cwd.to_string_lossy().to_string(),
        file,
    });
}

/// `package.json` → one entry per `scripts` key.
fn from_package_json(out: &mut Vec<Script>, root: &Path, dir: &Path) {
    let file = dir.join("package.json");
    let Ok(text) = std::fs::read_to_string(&file) else { return };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else { return };
    let Some(scripts) = json.get("scripts").and_then(|s| s.as_object()) else { return };
    let pm = js_runner(dir, root);
    let prefix = rel(root, dir);
    for name in scripts.keys() {
        push(
            out,
            "npm",
            scoped(&prefix, name),
            format!("{pm} run {name}"),
            dir,
            rel(root, &file),
        );
    }
}

/// `Makefile` → one entry per target that looks like a plain `name:` rule.
///
/// Deliberately a shallow scan rather than `make -qp`: pattern rules, `.PHONY`, variables
/// and anything indented are skipped, which leaves the hand-written targets a person
/// would actually run.
fn from_makefile(out: &mut Vec<Script>, root: &Path, dir: &Path) {
    for candidate in ["Makefile", "makefile", "GNUmakefile"] {
        let file = dir.join(candidate);
        let Ok(text) = std::fs::read_to_string(&file) else { continue };
        let prefix = rel(root, dir);
        for line in text.lines() {
            if line.starts_with([' ', '\t', '#', '.']) {
                continue;
            }
            let Some((target, rest)) = line.split_once(':') else { continue };
            // `=` after the colon is an assignment (`X := 1`), not a rule.
            if rest.starts_with('=') {
                continue;
            }
            let target = target.trim();
            if target.is_empty()
                || target.contains(['%', '$', ' ', '\t'])
                || !target
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_./".contains(c))
            {
                continue;
            }
            push(
                out,
                "make",
                scoped(&prefix, target),
                format!("make {target}"),
                dir,
                rel(root, &file),
            );
        }
        return; // only the first Makefile flavour that exists
    }
}

/// `Cargo.toml` → the three commands a Rust crate is always driven with.
fn from_cargo(out: &mut Vec<Script>, root: &Path, dir: &Path) {
    let file = dir.join("Cargo.toml");
    if !file.exists() {
        return;
    }
    let prefix = rel(root, dir);
    for (name, command) in [
        ("run", "cargo run"),
        ("build", "cargo build"),
        ("test", "cargo test"),
        ("check", "cargo check"),
    ] {
        push(out, "cargo", scoped(&prefix, name), command.into(), dir, rel(root, &file));
    }
}

/// A Gradle project → the wrapper's standard lifecycle tasks.
fn from_gradle(out: &mut Vec<Script>, root: &Path, dir: &Path) {
    let wrapper = dir.join("gradlew");
    let has_build = dir.join("build.gradle").exists() || dir.join("build.gradle.kts").exists();
    if !has_build {
        return;
    }
    let launcher = if wrapper.exists() { "./gradlew" } else { "gradle" };
    let prefix = rel(root, dir);
    let file = if wrapper.exists() { rel(root, &wrapper) } else { "build.gradle".into() };
    for (name, task) in [("run", "run"), ("build", "build"), ("test", "test"), ("tasks", "tasks")] {
        push(
            out,
            "gradle",
            scoped(&prefix, name),
            format!("{launcher} {task}"),
            dir,
            file.clone(),
        );
    }
}

/// `go.mod` → run / build / test.
fn from_go(out: &mut Vec<Script>, root: &Path, dir: &Path) {
    let file = dir.join("go.mod");
    if !file.exists() {
        return;
    }
    let prefix = rel(root, dir);
    for (name, command) in [("run", "go run ."), ("build", "go build ./..."), ("test", "go test ./...")] {
        push(out, "go", scoped(&prefix, name), command.into(), dir, rel(root, &file));
    }
}

/// A Python project → pytest, plus `python -m <package>` when pyproject names one.
fn from_python(out: &mut Vec<Script>, root: &Path, dir: &Path) {
    let file = dir.join("pyproject.toml");
    if !file.exists() && !dir.join("requirements.txt").exists() {
        return;
    }
    let prefix = rel(root, dir);
    let shown = if file.exists() { rel(root, &file) } else { "requirements.txt".into() };
    push(out, "python", scoped(&prefix, "test"), "pytest".into(), dir, shown.clone());
    if dir.join("main.py").exists() {
        push(out, "python", scoped(&prefix, "main.py"), "python main.py".into(), dir, shown);
    }
}

/// Executable-looking `*.sh` files in the directory itself and in `scripts/`.
fn from_shell(out: &mut Vec<Script>, root: &Path, dir: &Path) {
    for sub in ["", "scripts", "bin"] {
        let d = if sub.is_empty() { dir.to_path_buf() } else { dir.join(sub) };
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".sh") || !entry.path().is_file() {
                continue;
            }
            let prefix = rel(root, dir);
            let script = entry.path();
            push(
                out,
                "shell",
                scoped(&prefix, &name),
                format!("sh {}", shell_quote(&rel(root, &script))),
                root,
                rel(root, &script),
            );
        }
    }
}

/// Single-quote a path for the shell line the PTY types.
///
/// The command is typed into a real shell, so a path holding a space, `$` or `;` would
/// otherwise be re-split (or executed). Only discovered paths pass through here — never
/// user input — but a repo is allowed to contain a file called `a b;rm -rf c.sh`.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Everything runnable in one directory.
fn scan_dir(out: &mut Vec<Script>, root: &Path, dir: &Path) {
    from_package_json(out, root, dir);
    from_makefile(out, root, dir);
    from_cargo(out, root, dir);
    from_gradle(out, root, dir);
    from_go(out, root, dir);
    from_python(out, root, dir);
}

/// Discover every runnable command under `root`, up to {@link MAX_DEPTH} levels deep.
///
/// Shell scripts are only collected at the root (a deep sweep of a monorepo turns up
/// hundreds of vendored helpers that nobody runs by hand).
pub fn discover(root: &str) -> Result<Vec<Script>, String> {
    let root = Path::new(root.trim());
    if !root.is_dir() {
        return Err(format!("not a directory: {}", root.display()));
    }
    let mut out = Vec::new();
    scan_dir(&mut out, root, root);
    from_shell(&mut out, root, root);

    // Breadth-first into sub-projects.
    let mut level = vec![root.to_path_buf()];
    for _ in 0..MAX_DEPTH {
        let mut next = Vec::new();
        for dir in &level {
            let Ok(entries) = std::fs::read_dir(dir) else { continue };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if skip(&name) || !entry.path().is_dir() {
                    continue;
                }
                // `read_dir` gives no ordering guarantee; symlinked dirs could also loop
                // back on themselves, so only real directories are descended into.
                if entry.file_type().map(|t| t.is_symlink()).unwrap_or(true) {
                    continue;
                }
                let child = entry.path();
                if child != root {
                    scan_dir(&mut out, root, &child);
                }
                next.push(child);
            }
        }
        level = next;
    }

    out.sort_by(|a, b| a.source.cmp(&b.source).then_with(|| a.name.cmp(&b.name)));
    out.dedup_by(|a, b| a.id == b.id);
    Ok(out)
}
