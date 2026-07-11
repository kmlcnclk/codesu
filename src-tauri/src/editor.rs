//! Open a workspace folder in an external editor (VS Code / IntelliJ IDEA).
//!
//! On macOS we prefer `open -a "<App Name>"` (works whether or not the editor's
//! CLI launcher is on PATH — GUI apps rarely inherit the user's shell PATH),
//! falling back to the CLI launcher. On other platforms we use the CLI launcher.

use std::path::Path;
use std::process::Command;

/// CLI launcher for each supported editor.
fn cli_command(editor: &str) -> Result<&'static str, String> {
    match editor {
        "vscode" => Ok("code"),
        "intellij" => Ok("idea"),
        other => Err(format!("unknown editor: {other}")),
    }
}

/// macOS application bundle names to try (first that launches wins).
#[cfg(target_os = "macos")]
fn app_candidates(editor: &str) -> Result<&'static [&'static str], String> {
    match editor {
        "vscode" => Ok(&["Visual Studio Code", "VSCodium", "Code"]),
        "intellij" => Ok(&[
            "IntelliJ IDEA",
            "IntelliJ IDEA Ultimate",
            "IntelliJ IDEA CE",
        ]),
        other => Err(format!("unknown editor: {other}")),
    }
}

/// Run the CLI launcher (`code <path>` / `idea <path>`).
fn open_cli(path: &str, editor: &str) -> Result<(), String> {
    let cmd = cli_command(editor)?;
    let status = Command::new(cmd)
        .arg(path)
        .status()
        .map_err(|e| format!("failed to run `{cmd}`: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("`{cmd}` exited with {status}"))
    }
}

/// Open `path` in `editor` ("vscode" | "intellij").
pub fn open_in_editor(path: &str, editor: &str) -> Result<(), String> {
    if !Path::new(path).is_dir() {
        return Err(format!("not a directory: {path}"));
    }

    #[cfg(target_os = "macos")]
    {
        let mut last_err = String::new();
        for app in app_candidates(editor)? {
            match Command::new("open").arg("-a").arg(app).arg(path).status() {
                Ok(s) if s.success() => return Ok(()),
                Ok(s) => last_err = format!("`open -a \"{app}\"` exited with {s}"),
                Err(e) => last_err = format!("failed to launch `open`: {e}"),
            }
        }
        // No matching app bundle — fall back to the CLI launcher if it's installed.
        open_cli(path, editor).map_err(|cli_err| {
            format!("could not open editor ({last_err}); CLI fallback: {cli_err}")
        })
    }

    #[cfg(not(target_os = "macos"))]
    {
        open_cli(path, editor)
    }
}
