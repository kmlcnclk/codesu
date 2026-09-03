//! "Run this test" — turning a test in a source file into the command an IDE would run.
//!
//! The UI finds the tests (it already holds the buffer's text; see `src/lib/code/tests.ts`)
//! and asks this module what to type for one of them. Deciding that here is what makes the
//! gutter arrow work in a repo nobody configured: the build tool, its wrapper script, the
//! sub-project a file belongs to and the package manager are all read off the disk.
//!
//! Like `runner`, nothing here EXECUTES anything — the resolved `Script` goes back to the
//! Run panel and is typed into its normal PTY, so output, input and Ctrl-C behave exactly
//! as they already do.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::runner::{js_runner, shell_quote, Script};

/// One test the UI found in a file, as the gutter reports it.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TestTarget {
    /// "class" (the whole class / describe block / module) or "method" (one test).
    pub kind: String,
    /// Fully-qualified class for the JVM, the enclosing class/module/describe elsewhere.
    pub class_name: Option<String>,
    /// The test function's own name, when a single test was clicked.
    pub method: Option<String>,
    /// What to call this run in the UI.
    pub name: String,
}

impl TestTarget {
    /// The name a filter-based runner (cargo, go, vitest) should match on.
    fn filter(&self) -> String {
        self.method
            .clone()
            .or_else(|| self.class_name.clone())
            .unwrap_or_else(|| self.name.clone())
    }
}

/// The nearest directory at or above `start` (never past `root`) holding one of `names`.
fn find_up(start: &Path, root: &Path, names: &[&str]) -> Option<PathBuf> {
    let mut dir = Some(start);
    while let Some(d) = dir {
        if names.iter().any(|n| d.join(n).exists()) {
            return Some(d.to_path_buf());
        }
        if d == root {
            break;
        }
        dir = d.parent();
    }
    None
}

/// `path` relative to `base`, in forward slashes ("" when they are the same directory).
fn rel(base: &Path, path: &Path) -> String {
    path.strip_prefix(base)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().to_string())
}

fn script(name: String, command: String, cwd: &Path, file: String) -> Script {
    Script {
        id: format!("test:{name}:{}", cwd.to_string_lossy()),
        name,
        command,
        source: "test".into(),
        cwd: cwd.to_string_lossy().to_string(),
        file,
    }
}

/// Gradle (or Maven) — the JVM's two build tools, picked by whichever file is nearer.
///
/// The Gradle task is scoped to the sub-project the test file lives in
/// (`:apps:squalo-function:test`) rather than the root `test`, because running every
/// module's tests to reach one method is the difference between seconds and minutes.
/// A project's Gradle path is its directory path under the build root, which is how
/// `settings.gradle` includes are conventionally written.
fn jvm(root: &Path, dir: &Path, file: &Path, t: &TestTarget) -> Result<Script, String> {
    let class = t
        .class_name
        .clone()
        .ok_or("cannot run a JVM test without its class name")?;
    let pattern = match &t.method {
        Some(m) if t.kind == "method" => format!("{class}.{m}"),
        _ => class.clone(),
    };

    let gradle_dirs = ["build.gradle.kts", "build.gradle"];
    if let Some(module) = find_up(dir, root, &gradle_dirs) {
        // The build root is where the wrapper lives; fall back to the module itself for a
        // stand-alone project checked out on its own.
        let base = find_up(&module, root, &["gradlew"])
            .or_else(|| find_up(&module, root, &["settings.gradle.kts", "settings.gradle"]))
            .unwrap_or_else(|| module.clone());
        let launcher = if base.join("gradlew").exists() { "./gradlew" } else { "gradle" };
        let project = rel(&base, &module);
        let task = if project.is_empty() {
            "test".to_string()
        } else {
            format!(":{}:test", project.replace('/', ":"))
        };
        return Ok(script(
            t.name.clone(),
            format!("{launcher} {task} --tests {}", shell_quote(&pattern)),
            &base,
            rel(root, file),
        ));
    }

    if let Some(base) = find_up(dir, root, &["pom.xml"]) {
        // Surefire's `-Dtest` takes `Class#method` on the SIMPLE class name.
        let simple = class.rsplit('.').next().unwrap_or(&class).to_string();
        let selector = match &t.method {
            Some(m) if t.kind == "method" => format!("{simple}#{m}"),
            _ => simple,
        };
        return Ok(script(
            t.name.clone(),
            format!("mvn test -Dtest={}", shell_quote(&selector)),
            &base,
            rel(root, file),
        ));
    }

    Err("no Gradle or Maven build found for this file".into())
}

/// Cargo — `cargo test <name>` filters by substring, which is what the gutter wants for
/// both a single `#[test]` fn and a whole `mod tests`.
fn rust_test(root: &Path, dir: &Path, file: &Path, t: &TestTarget) -> Result<Script, String> {
    let base = find_up(dir, root, &["Cargo.toml"]).unwrap_or_else(|| root.to_path_buf());
    let filter = t.filter();
    Ok(script(
        t.name.clone(),
        format!("cargo test {} -- --nocapture", shell_quote(&filter)),
        &base,
        rel(root, file),
    ))
}

/// pytest, addressed by node id (`path::Class::method`) so one test runs on its own.
fn python(root: &Path, dir: &Path, file: &Path, t: &TestTarget) -> Result<Script, String> {
    let markers = ["pyproject.toml", "setup.py", "setup.cfg", "tox.ini", "pytest.ini"];
    let base = find_up(dir, root, &markers).unwrap_or_else(|| root.to_path_buf());
    let mut node = rel(&base, file);
    if let Some(c) = &t.class_name {
        node.push_str("::");
        node.push_str(c);
    }
    if t.kind == "method" {
        if let Some(m) = &t.method {
            node.push_str("::");
            node.push_str(m);
        }
    }
    Ok(script(
        t.name.clone(),
        format!("pytest {} -v", shell_quote(&node)),
        &base,
        rel(root, file),
    ))
}

/// `go test` on the file's own package, anchored so `-run TestFoo` can't also match
/// `TestFooBar`.
fn go(root: &Path, dir: &Path, file: &Path, t: &TestTarget) -> Result<Script, String> {
    let base = find_up(dir, root, &["go.mod"]).unwrap_or_else(|| root.to_path_buf());
    let pkg = rel(&base, dir);
    let pkg = if pkg.is_empty() { ".".to_string() } else { format!("./{pkg}") };
    Ok(script(
        t.name.clone(),
        format!("go test {} -run {} -v", shell_quote(&pkg), shell_quote(&format!("^{}$", t.filter()))),
        &base,
        rel(root, file),
    ))
}

/// The `exec`-equivalent for each package manager, so a locally-installed vitest/jest
/// binary is the one that runs.
fn js_exec(pm: &str) -> &'static str {
    match pm {
        "pnpm" => "pnpm exec",
        "yarn" => "yarn",
        "bun" => "bun x",
        _ => "npx",
    }
}

/// Vitest / Jest / Mocha, discovered from the nearest package.json's dependencies.
///
/// `-t` (`--grep` for mocha) matches the test's title, which is exactly what the gutter
/// has: the string passed to `it(…)` or `describe(…)`.
fn js(root: &Path, dir: &Path, file: &Path, t: &TestTarget) -> Result<Script, String> {
    let base = find_up(dir, root, &["package.json"]).unwrap_or_else(|| root.to_path_buf());
    let pm = js_runner(&base, root);
    let path = shell_quote(&rel(&base, file));
    let title = shell_quote(&t.filter());

    let manifest = std::fs::read_to_string(base.join("package.json")).unwrap_or_default();
    let json = serde_json::from_str::<serde_json::Value>(&manifest).unwrap_or(serde_json::Value::Null);
    let has_dep = |name: &str| {
        ["dependencies", "devDependencies"].iter().any(|section| {
            json.get(section)
                .and_then(|d| d.get(name))
                .is_some()
        })
    };

    let command = if has_dep("vitest") {
        format!("{} vitest run {path} -t {title}", js_exec(pm))
    } else if has_dep("jest") {
        format!("{} jest {path} -t {title}", js_exec(pm))
    } else if has_dep("mocha") {
        format!("{} mocha {path} --grep {title}", js_exec(pm))
    } else if json.get("scripts").and_then(|s| s.get("test")).is_some() {
        // No known framework, but the project says how to test itself — pass the file and
        // title through and let its own script decide what to do with them.
        format!("{pm} run test -- {path} -t {title}")
    } else {
        return Err("no test runner (vitest, jest, mocha) found in package.json".into());
    };
    Ok(script(t.name.clone(), command, &base, rel(root, file)))
}

/// The command that runs `target`, which lives in `file` inside workspace `root`.
pub fn resolve(root: &str, file: &str, target: &TestTarget) -> Result<Script, String> {
    let (root, file) = crate::fsx::resolve_inside(root, file)?;
    let dir = file
        .parent()
        .ok_or_else(|| format!("file has no parent directory: {}", file.display()))?;
    let ext = file
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "kt" | "kts" | "java" | "groovy" | "scala" => jvm(&root, dir, &file, target),
        "rs" => rust_test(&root, dir, &file, target),
        "py" => python(&root, dir, &file, target),
        "go" => go(&root, dir, &file, target),
        "js" | "jsx" | "mjs" | "cjs" | "ts" | "tsx" | "mts" | "cts" => js(&root, dir, &file, target),
        _ => Err(format!("no test runner known for .{ext} files")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    // Same scratch-directory idiom as `store`'s tests: no external crate, uniqueness from
    // a process-local counter.
    static COUNTER: AtomicU32 = AtomicU32::new(0);

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir()
                .join(format!("codesu-testing-{}-{n}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
        /// Canonical, because macOS's temp dir is a symlink and `resolve` compares
        /// canonical paths.
        fn path(&self) -> PathBuf {
            fs::canonicalize(&self.0).unwrap()
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn touch(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    fn target(kind: &str, class: Option<&str>, method: Option<&str>, name: &str) -> TestTarget {
        TestTarget {
            kind: kind.into(),
            class_name: class.map(str::to_string),
            method: method.map(str::to_string),
            name: name.into(),
        }
    }

    /// A Gradle monorepo: the task must be scoped to the module the file lives in, run
    /// from the wrapper's directory, and filter down to the single method.
    #[test]
    fn gradle_scopes_the_task_to_the_module() {
        let tmp = TempDir::new();
        let root = tmp.path();
        touch(&root.join("gradlew"), "");
        touch(&root.join("settings.gradle.kts"), "");
        touch(&root.join("apps/squalo-function/build.gradle.kts"), "");
        let file = root.join("apps/squalo-function/src/test/kotlin/com/hiccup/squalo/Runner.kt");
        touch(&file, "package com.hiccup.squalo\n");

        let script = resolve(
            root.to_str().unwrap(),
            file.to_str().unwrap(),
            &target("method", Some("com.hiccup.squalo.Runner"), Some("testSync"), "testSync"),
        )
        .unwrap();

        assert_eq!(
            script.command,
            "./gradlew :apps:squalo-function:test --tests 'com.hiccup.squalo.Runner.testSync'"
        );
        assert_eq!(script.cwd, root.to_string_lossy());
    }

    /// Clicking the CLASS arrow runs every test in it — no `.method` on the filter.
    #[test]
    fn gradle_class_target_has_no_method_filter() {
        let tmp = TempDir::new();
        let root = tmp.path();
        touch(&root.join("gradlew"), "");
        touch(&root.join("build.gradle.kts"), "");
        let file = root.join("src/test/kotlin/RunnerTest.kt");
        touch(&file, "");

        let script = resolve(
            root.to_str().unwrap(),
            file.to_str().unwrap(),
            &target("class", Some("com.x.RunnerTest"), None, "RunnerTest"),
        )
        .unwrap();

        assert_eq!(script.command, "./gradlew test --tests 'com.x.RunnerTest'");
    }

    /// Maven, when there is no Gradle build: surefire wants `Class#method`, simple name.
    #[test]
    fn maven_uses_the_simple_class_name() {
        let tmp = TempDir::new();
        let root = tmp.path();
        touch(&root.join("pom.xml"), "");
        let file = root.join("src/test/java/com/x/RunnerTest.java");
        touch(&file, "");

        let script = resolve(
            root.to_str().unwrap(),
            file.to_str().unwrap(),
            &target("method", Some("com.x.RunnerTest"), Some("works"), "works"),
        )
        .unwrap();

        assert_eq!(script.command, "mvn test -Dtest='RunnerTest#works'");
    }

    /// pytest addresses a single test by node id, relative to the project it belongs to.
    #[test]
    fn pytest_builds_a_node_id() {
        let tmp = TempDir::new();
        let root = tmp.path();
        touch(&root.join("pyproject.toml"), "");
        let file = root.join("tests/test_resolver.py");
        touch(&file, "");

        let script = resolve(
            root.to_str().unwrap(),
            file.to_str().unwrap(),
            &target("method", Some("TestResolver"), Some("test_finds"), "test_finds"),
        )
        .unwrap();

        assert_eq!(
            script.command,
            "pytest 'tests/test_resolver.py::TestResolver::test_finds' -v"
        );
    }

    /// The JS runner comes from package.json's dependencies, the launcher from the lockfile.
    #[test]
    fn vitest_is_run_through_the_projects_package_manager() {
        let tmp = TempDir::new();
        let root = tmp.path();
        touch(&root.join("pnpm-lock.yaml"), "");
        touch(
            &root.join("package.json"),
            r#"{"devDependencies":{"vitest":"^2"}}"#,
        );
        let file = root.join("src/api.test.ts");
        touch(&file, "");

        let script = resolve(
            root.to_str().unwrap(),
            file.to_str().unwrap(),
            &target("method", Some("relPath"), Some("strips the root"), "strips the root"),
        )
        .unwrap();

        assert_eq!(
            script.command,
            "pnpm exec vitest run 'src/api.test.ts' -t 'strips the root'"
        );
    }

    /// `go test` runs the file's own package, with the name anchored.
    #[test]
    fn go_anchors_the_run_pattern() {
        let tmp = TempDir::new();
        let root = tmp.path();
        touch(&root.join("go.mod"), "");
        let file = root.join("internal/resolve/resolve_test.go");
        touch(&file, "");

        let script = resolve(
            root.to_str().unwrap(),
            file.to_str().unwrap(),
            &target("method", None, Some("TestResolve"), "TestResolve"),
        )
        .unwrap();

        assert_eq!(
            script.command,
            "go test './internal/resolve' -run '^TestResolve$' -v"
        );
    }

    /// A language with no runner is refused, not guessed at.
    #[test]
    fn unknown_language_is_refused() {
        let tmp = TempDir::new();
        let root = tmp.path();
        let file = root.join("notes.txt");
        touch(&file, "");

        let err = resolve(
            root.to_str().unwrap(),
            file.to_str().unwrap(),
            &target("method", None, Some("x"), "x"),
        )
        .unwrap_err();

        assert!(err.contains("no test runner known"), "{err}");
    }

    /// A path outside the workspace is rejected before any build tool is looked for
    /// (`fsx::resolve_inside` is what enforces it — this asserts it is still wired up).
    #[test]
    fn a_file_outside_the_workspace_is_rejected() {
        let tmp = TempDir::new();
        let root = tmp.path().join("inside");
        fs::create_dir_all(&root).unwrap();
        let outside = tmp.path().join("outside/Test.kt");
        touch(&outside, "");

        let err = resolve(
            root.to_str().unwrap(),
            outside.to_str().unwrap(),
            &target("method", Some("Test"), Some("x"), "x"),
        )
        .unwrap_err();

        assert!(err.contains("outside the workspace"), "{err}");
    }
}
