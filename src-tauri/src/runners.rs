//! The Run rail's "Runners" tab: one-shot runner classes a session wrote or changed, and
//! the per-project environment they are launched with.
//!
//! A runner here is what the Hiccup backend calls one: a JUnit class named `*Runner`
//! under `src/test/kotlin`, whose `@Test` functions are the entry points (`dryRun`,
//! `apply`, `applyOnProd`…). Each entry point is launched through Gradle's test filter —
//! `./gradlew :apps:<module>:test --tests "<fqcn>.<fn>"` — which is exactly how the
//! repo's own docs say to run them. Nothing here executes anything: the composed command
//! goes back to the UI, which runs it in a PTY like any other script.
//!
//! Environment profiles (the variables injected per target, and extra variables
//! remembered per runner) live OUTSIDE the repo, in Codesu's own data folder, so the
//! user's checkout is never dirtied by a file the app wrote.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Runner {
    /// Simple class name, e.g. `RetryPoolEmptyPurchaseOrderJobsRunner`.
    pub class: String,
    /// Fully qualified, for the Gradle test filter.
    pub fqcn: String,
    /// Gradle project path, e.g. `:apps:parkpalet-function` ("" for the root project).
    pub module: String,
    /// The module's short name shown under the class.
    pub module_name: String,
    /// Path of the source file relative to the workspace root.
    pub file: String,
    /// `@Test` function names, in file order.
    pub entries: Vec<String>,
}

const SKIP_DIRS: &[&str] = &["build", "node_modules", ".git", "target", ".gradle", ".idea", "out"];

fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 12 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let path = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        // Symlinks are not followed: a link to `/` or a loop would walk far outside
        // the workspace (`file_type` reports the link itself, `is_dir` its target).
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) || name.starts_with('.') {
                continue;
            }
            walk(&path, depth + 1, out);
        } else if name.ends_with("Runner.kt") {
            out.push(path);
        }
    }
}

/// Nearest ancestor of `start` (not past `root`) holding a Gradle build file.
fn gradle_module(start: &Path, root: &Path) -> Option<PathBuf> {
    let mut dir = Some(start);
    while let Some(d) = dir {
        if d.join("build.gradle.kts").exists() || d.join("build.gradle").exists() {
            return Some(d.to_path_buf());
        }
        if d == root {
            break;
        }
        dir = d.parent();
    }
    None
}

/// Parse one Kotlin runner file: package, class name, and `@Test` functions.
fn parse(src: &str) -> Option<(String, String, Vec<String>)> {
    let mut package = String::new();
    let mut class = None;
    let mut entries = Vec::new();
    let mut pending_test = false;
    for raw in src.lines() {
        let line = raw.trim();
        if let Some(rest) = line.strip_prefix("package ") {
            package = rest.trim_end_matches(';').trim().to_string();
            continue;
        }
        if class.is_none() {
            // `class X`, also behind modifiers: `internal class X`, `open class X`.
            if let Some(idx) = line.find("class ") {
                let before = &line[..idx];
                let is_decl = before.is_empty()
                    || before.split_whitespace().all(|w| matches!(w, "internal" | "open" | "abstract" | "private" | "public" | "data" | "sealed" | "final"));
                if is_decl {
                    let name: String = line[idx + 6..].chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
                    if name.ends_with("Runner") {
                        class = Some(name);
                    }
                }
            }
            continue;
        }
        // `@Test` exactly (not `@TestInstance`), possibly with the function on the same line.
        let is_test = line == "@Test" || line.starts_with("@Test(") || line.starts_with("@Test ");
        if is_test {
            pending_test = true;
            if !line.contains("fun ") {
                continue;
            }
        }
        if pending_test {
            // Other annotations, and comments, may sit between @Test and the function
            // (but `@Test fun x()` on one line is the function itself).
            if (line.starts_with('@') && !line.contains("fun ")) || line.starts_with("//") || line.starts_with("/*") || line.starts_with('*') {
                continue;
            }
            if let Some(idx) = line.find("fun ") {
                let after = &line[idx + 4..];
                let name = if let Some(stripped) = after.strip_prefix('`') {
                    stripped.split('`').next().unwrap_or("").to_string()
                } else {
                    after.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect()
                };
                if !name.is_empty() {
                    entries.push(name);
                }
                pending_test = false;
            } else if !line.is_empty() {
                pending_test = false;
            }
        }
    }
    let class = class?;
    let fqcn = if package.is_empty() { class.clone() } else { format!("{package}.{class}") };
    Some((class, fqcn, entries))
}

/// Every runner class under `root`, sorted by module then class name.
pub fn discover(root: &str) -> Result<Vec<Runner>, String> {
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(format!("not a folder: {root}"));
    }
    let mut files = Vec::new();
    walk(root_path, 0, &mut files);
    let mut out = Vec::new();
    for file in files {
        let Ok(src) = fs::read_to_string(&file) else { continue };
        let Some((class, fqcn, entries)) = parse(&src) else { continue };
        if entries.is_empty() {
            continue;
        }
        let dir = file.parent().unwrap_or(root_path);
        let module_dir = gradle_module(dir, root_path).unwrap_or_else(|| root_path.to_path_buf());
        let rel_module = module_dir
            .strip_prefix(root_path)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        let module = if rel_module.is_empty() {
            String::new()
        } else {
            format!(":{}", rel_module.replace('/', ":"))
        };
        let module_name = module_dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        out.push(Runner {
            class,
            fqcn,
            module,
            module_name,
            file: file
                .strip_prefix(root_path)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default(),
            entries,
        });
    }
    out.sort_by(|a, b| a.module.cmp(&b.module).then(a.class.cmp(&b.class)));
    Ok(out)
}

/// The Gradle line that runs one entry point. Variables are passed through the PTY's
/// environment by the caller, so they never end up in a shell string.
pub fn command(r: &Runner, entry: &str) -> String {
    let launcher = "./gradlew";
    let task = if r.module.is_empty() { "test".to_string() } else { format!("{}:test", r.module) };
    // Everything that came from the filesystem or a file is quoted: the module path is
    // built from directory names and the entry from source, and both are typed into a
    // shell. Gradle's filter matches on `Class.method`; a backticked Kotlin name keeps
    // its spaces.
    format!(
        "{launcher} {} --tests {} --rerun-tasks",
        crate::runner::shell_quote(&task),
        crate::runner::shell_quote(&format!("{}.{}", r.fqcn, entry))
    )
}

// ---------- environment profiles ----------

/// `{ "targets": { "dev": {K: V}, "prod": {K: V} }, "runners": { "<fqcn.entry>": {K: V} } }`
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct EnvProfile {
    #[serde(default)]
    pub targets: BTreeMap<String, BTreeMap<String, String>>,
    #[serde(default)]
    pub runners: BTreeMap<String, BTreeMap<String, String>>,
}

fn profile_path(app: &AppHandle, project: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .data_dir()
        .map_err(|e| format!("no data dir: {e}"))?
        .join("codesu")
        .join("env");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // The project is identified by its path; the file name is a readable slug of it.
    let slug: String = project
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("project")
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let mut hasher: u64 = 1469598103934665603;
    for b in project.as_bytes() {
        hasher ^= *b as u64;
        hasher = hasher.wrapping_mul(1099511628211);
    }
    Ok(dir.join(format!("{slug}-{:08x}.json", hasher as u32)))
}

pub fn load_profile(app: &AppHandle, project: &str) -> Result<EnvProfile, String> {
    let path = profile_path(app, project)?;
    if !path.exists() {
        let mut p = EnvProfile::default();
        // Sensible defaults for a Micronaut backend: tests must never hit prod by
        // accident, so dev gets the test environment and prod is explicit.
        p.targets.insert("dev".into(), BTreeMap::from([("MICRONAUT_ENVIRONMENTS".into(), "dev,test".into())]));
        p.targets.insert("prod".into(), BTreeMap::from([("MICRONAUT_ENVIRONMENTS".into(), "prod".into())]));
        return Ok(p);
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str::<EnvProfile>(&text).map_err(|e| format!("env profile is not valid JSON: {e}"))
}

pub fn save_profile(app: &AppHandle, project: &str, profile: &EnvProfile) -> Result<(), String> {
    let path = profile_path(app, project)?;
    let text = serde_json::to_string_pretty(profile).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| e.to_string())
}

/// Convenience for the UI: the profile as plain JSON.
pub fn profile_json(app: &AppHandle, project: &str) -> Result<Value, String> {
    serde_json::to_value(load_profile(app, project)?).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_test_functions_including_backticked_names() {
        let src = r#"
package com.hiccup.parkpalet

@Disabled("manual")
@MicronautTest
class RetryPoolEmptyPurchaseOrderJobsRunner {
    @Inject lateinit var repo: Repo

    @Test
    fun dryRun() = runTest { }

    @Test
    @Tag("prod")
    fun `apply on prod`() = runTest { }

    fun helper() {}
}
"#;
        let (class, fqcn, entries) = parse(src).unwrap();
        assert_eq!(class, "RetryPoolEmptyPurchaseOrderJobsRunner");
        assert_eq!(fqcn, "com.hiccup.parkpalet.RetryPoolEmptyPurchaseOrderJobsRunner");
        assert_eq!(entries, vec!["dryRun", "apply on prod"]);
    }

    #[test]
    fn non_runner_classes_are_ignored() {
        assert!(parse("package a\nclass Foo {\n @Test fun x() {}\n}").is_none());
    }

    #[test]
    fn command_targets_the_module_test_task() {
        let r = Runner {
            class: "X".into(),
            fqcn: "com.a.X".into(),
            module: ":apps:fn".into(),
            module_name: "fn".into(),
            file: "apps/fn/src/test/kotlin/X.kt".into(),
            entries: vec!["dryRun".into()],
        };
        assert_eq!(command(&r, "dryRun"), "./gradlew ':apps:fn:test' --tests 'com.a.X.dryRun' --rerun-tasks");
    }

    #[test]
    fn test_on_the_same_line_modifiers_and_lookalike_annotations() {
        let src = r#"
package p
@TestInstance(Lifecycle.PER_CLASS)
internal class SameLineRunner {
    @Test fun dryRun() = runTest { }
    @Test
    // fun fact: comments between the annotation and the function are allowed
    fun apply() {}
    @Testcontainers
    fun notATest() {}
}
"#;
        let (class, _, entries) = parse(src).unwrap();
        assert_eq!(class, "SameLineRunner");
        assert_eq!(entries, vec!["dryRun", "apply"]);
    }
}
