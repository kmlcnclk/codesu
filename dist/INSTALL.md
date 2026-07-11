# Installing Codesu (macOS)

Codesu is a desktop app for running and managing many Claude Code agents at once.

> **Requirement:** you need the **Claude Code CLI** installed and on your `PATH`
> (the `claude` command). Codesu launches it for you — it doesn't replace it.
> Install it from <https://docs.anthropic.com/en/docs/claude-code>.

---

## Install in 3 steps

1. **Download** `Codesu_x.y.z_universal.dmg` and double-click it.
2. **Drag `Codesu`** into the **Applications** folder (the window shows an arrow).
3. **Open it** — see the note below the first time.

The app is **universal**: it runs natively on both Apple Silicon (M1–M4) and Intel Macs.

---

## ⚠️ First launch: "Codesu can't be opened" / "unidentified developer"

Codesu is **not yet signed with an Apple Developer certificate**, so macOS
Gatekeeper blocks it on the first open. This is expected and safe — you just tell
macOS to trust it **once**. Pick either option:

### Option A — Right-click to open (easiest)
1. Open your **Applications** folder.
2. **Right-click** (or Control-click) **Codesu** → **Open**.
3. In the dialog, click **Open** again.

That's it — macOS remembers your choice, and every launch after this is a normal
double-click.

### Option B — One command (if macOS says "damaged")
Some macOS versions show *"Codesu is damaged and can't be opened"* instead of an
Open button. That's just the download quarantine flag — clear it with:

```bash
xattr -dr com.apple.quarantine /Applications/Codesu.app
```

Then open Codesu normally.

> Prefer not to touch the Terminal? Double-click the included
> **`Open Codesu (first time).command`** helper — it runs the command above for you.

---

## Your data is safe across upgrades

Codesu stores everything (workspaces, agents, tasks, notes, history) in:

```
~/Library/Application Support/codesu/
```

This folder is **separate from the app**, so upgrading (replacing the app) or even
deleting and reinstalling Codesu never touches your data. A backup copy is kept
alongside it as `state.json.bak`, and data from older builds is migrated
automatically.

---

## Uninstalling

Drag **Codesu** from Applications to the Trash. To also remove your saved data,
delete `~/Library/Application Support/codesu/`.
