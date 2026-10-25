# 🎯 Codesu Features

A detailed breakdown of what Codesu can do for you.

---

## Agent Management

### Create & Manage Agents
- **Three agent kinds**: **Claude** (launches the Claude Code CLI), **Shell** (a
  plain login shell), and **Command** (any custom program you specify)
- **Workspaces**: Organize agents by project folder, each with an accent color
- **Agent States**: Automatically derived — 🔵 working, 🔴 blocked, 🟢 done, ⚪ idle, ⚫ exited
- **Audio Feedback**: Optional chime when an agent finishes or gets blocked

### Agent Control
- **Keyboard Navigation**: `Cmd+1…9` to switch between agent tabs instantly
- **Global Shortcuts**: Quick access to agent creation and every view (rebindable)
- **Persistent Sessions**: Claude agents resume exactly where they left off (via `claude --resume`)
- **Reopen last closed agent**: `Cmd+Shift+Z` brings back the agent you just closed

---

## Chat View (Claude sessions)

Every Claude agent's pane can be a **chat** instead of a terminal (Settings → Claude
session view; a pane can switch either way from its strip). Claude Code keeps running in
the background as the same session, so "Open in terminal" and `claude --resume` always
work.

- **Transcript**: your messages, Claude's replies (Markdown, code, tables), and every
  tool call as a row that opens to show its output. Three layouts: Transcript (rows
  inline), Split (an activity rail with the files changed this session), Simple (one
  line per step).
- **When Claude needs you**: a card for each tool permission (Allow once / Allow for
  session / Deny, `Y` `A` `N`), multiple-choice question (number keys, "Other…"), and
  plan approval; an amber bar above the composer while something is open; the agent's
  roster state goes blocked, with the chime.
- **Subagents**: a card per agent Claude spawns (name, prompt, live step, tokens, tool
  count, result). *Enter* opens the agent's own transcript with a composer whose
  messages are handed to that agent through the session; the strip counts running
  agents and lists them.
- **Follow-ups**: while a turn runs, Enter queues a message (edit / delete / Send now in
  the Queued panel) or steers immediately, per Settings; `⌘⏎` does the other.
- **Attachments**: drop, paste or pick files; chips with a hover preview, kept on the
  sent message.
- **Prompt navigator**: a tick per message you sent on the transcript's edge, with a
  list to jump back; a "jump to latest" button when scrolled up.
- **Context & usage**: the strip's meter opens a popover with the context window used
  and your Claude usage (session and weekly, with reset times).
- **Run rail**: the repo's scripts and the `*Runner.kt` classes this session wrote or
  changed. A launch dialog picks dev or prod, dry run, the injected variables (kept in
  Codesu's data folder, never in the repo) and shows the exact command; every run opens
  in an output tab and, when it ends, its exit code and output tail go to the session
  (automatically while the session runs and the setting is Always; otherwise with one
  click on the run's "Send to session").
- **Resumed sessions** replay their earlier conversation from Claude's own transcript.

---

## Terminal Emulation

### High-Performance Terminal
- **xterm.js v6.0**: Industry-standard terminal emulation
- **WebGL Rendering**: Smooth, responsive output even with heavy workloads
- **Resize Support**: Terminal panes adjust dynamically
- **Keyboard Support**: Full keyboard input including special keys and modifiers
- **Output Coalescing**: Optimized rendering for high-throughput sessions

### Shell Features
- **Custom Working Directories**: Each agent runs in its workspace's folder
- **Login shell**: Shell agents launch your default login shell (from `$SHELL`)
- **Graceful shutdown**: Agents get SIGTERM then SIGKILL after a grace period, so
  Claude flushes and persists its session on exit
- **Interactive Prompts**: Automatic detection of blocking prompts from Claude

---

## Code View

The Code view (**Cmd + E**) is the "I don't want to leave the app" half of the workflow:
read what the agent wrote, fix it by hand, and run it — without opening a separate IDE.

### Built-in editor
- **File tree** of the active workspace, loaded one level at a time (a huge
  `node_modules` costs nothing until you expand it) with a "show hidden" toggle
- **CodeMirror 6 editor** with syntax highlighting for JS/TS/JSX/TSX, JSON, CSS, HTML,
  Svelte, Vue, Markdown, Rust, Python, Java/Kotlin and YAML — plus line numbers, code
  folding, bracket matching and `Cmd + F` search
- **Tabs** per open file, remembered per workspace across restarts (paths only — every
  buffer is re-read from disk, so you never look at a stale copy)
- **Cmd + S to save** while the editor has focus (elsewhere it opens Settings), with an
  unsaved-changes dot on the tab
- **Agent-aware**: a file an agent rewrote in the background is re-read when you focus
  its tab, and a save is refused (offering *Reload* or *Overwrite*) if the file moved on
  underneath an edit of yours
- **Sandboxed**: every read and write is resolved against the workspace root and refused
  if it lands outside it, symlinks included

### Review
- **Changes panel** — `git status` for the workspace, grouped by path with A/M/D/R/U
  badges, the current branch, and ahead/behind counts
- **Diff viewer** with real old/new line numbers, per-file and "all changes at once"
- **Stage / unstage** a file straight from the list
- **Auto-refresh** every few seconds while the view is open, so an agent's commits and
  edits show up on their own
- **Jump to edit**: open the file being reviewed in the editor in one click

### Run
- **Run panel** — a real shell per workspace, so commands run with your environment,
  accept input, and keep their scrollback; **Stop** sends `Ctrl-C`
- **Ad-hoc commands**: type anything into the run bar; **Run again** repeats the last one
- **Run this test**: the gutter arrow next to a test (JVM, Cargo, Go, pytest, vitest/jest)
  types the right command for that one test into the panel
- The panel is collapsible and resizable, and keeps running while you are in another view

---

## Task & Project Management

### Agent Board (Tasks page, **Cmd + Y**)
Every live agent is a card on a four-column board, so one screen answers "what is
everyone doing?" across all projects:
- **Backlog**: agents that have not started working yet
- **In Progress**: agents at work (or waiting for you)
- **Testing**: agents whose work is being checked
- **Done**: finished agents — they leave the tab strip and can be restored from History
- **Drag & Drop**: move a card between columns to change the agent's lane; an agent
  created from a note moves its note's task along with it
- **Click a card** to jump to that agent's terminal
- Cards show the agent's project / workspace, the note it was spawned from, and when it
  was last used

### Notes → agents
- **Spawn an agent from a note**: *Create agent* on a note opens a fresh worktree
  workspace and starts a Claude agent with the note (or just the highlighted text) as
  its opening prompt
- **Linked agents**: a note lists every agent it spawned, and the agent's card shows
  the note — jump either way in one click
- **Attachments**: drop files or paste images onto an agent's pane; they are shared
  with the agent and can be previewed in the app

---

## Activity & History

### Daily Activity Report
- **Automatic Tracking**: every Claude turn and every finished agent is journaled
- **Daily Summaries**: completed / worked-on / workspaces touched, for any day
- **Entries link back**: click a row to open that agent
- **Copy for standup**: the day's report as text, ready to paste

### Session History
- **History page**: finished agents, archived projects and archived workspaces, each
  with a *Restore*
- **Day-by-day journal**: When you worked on or completed each agent and task
- **120-Day Retention**: The activity journal is pruned to a rolling 120-day window

### Search & Filter
- **Notes search**: full-text search across notes (and the archive tab)
- **Sidebar filter**: type-to-filter projects and workspaces in the rail
- **Code search**: files, symbols and text in the active workspace (**Cmd + P** in Code)

---

## Notes & Ideas

### Persistent Notes
- **Markdown Support**: Write notes in markdown format
- **Formatting**: Headers, lists, code blocks, links
- **Auto-Save**: Changes saved automatically
- **Search**: Full-text search across all notes

### Idea → Task Workflow
- **Capture Ideas**: Quick idea entry from anywhere
- **Fork to Task**: Convert ideas into actionable tasks
- **Batch Processing**: Create multiple tasks from related ideas
- **Idea History**: View all past ideas and their status

### Slack → Notes
- **React to Save**: React to any Slack message with 📥 (`:inbox_tray:`, configurable — Slack's "Save for later" has no API) and it becomes a note within a minute
- **Context Kept**: Each note records who said it, where, and links back to the message ("Open in Slack")
- **Setup**: Settings → Slack — create an app from the provided manifest and paste its user token (stored in the macOS Keychain)

---

## Keyboard Shortcuts

Defaults (macOS). Every shortcut is rebindable in **Settings → Shortcuts**.

### View Navigation
- **Cmd + A**: Agents
- **Cmd + E**: Code
- **Cmd + Y**: Tasks
- **Cmd + N**: Notes
- **Cmd + R**: Daily Report
- **Cmd + H**: History
- **Cmd + S**: Settings
- **Cmd + Shift + T**: Toggle Terminal

### Agents View
- **Cmd + T**: New Claude agent
- **Cmd + 1…9**: Switch to agent tab 1–9
- **Cmd + Delete**: Close current agent
- **Cmd + Shift + Z**: Reopen last closed agent

### Within Notes
- **Cmd + 1 / 2**: Switch between the notes list and the archive

*Keys typed inside a terminal pane (e.g. `Ctrl+C`, `Ctrl+L`) are handled by the
shell or CLI running there, not by Codesu.*

---

## Git Integration

### Worktree Support
- **Create worktrees on the fly**: `~/.codesu/worktrees/<repo>/<branch>`, so parallel
  agents work on isolated branches without stepping on each other
- **Archive a workspace** to hide it (the worktree stays on disk for `git worktree`);
  *Restore* it from History
- **Branch Isolation**: Each worktree is its own directory on its own branch
- **Git Commands**: Run any git command through agent terminals as usual
- **Review in-app**: the Code view's Changes panel shows `git status` and diffs for the
  active workspace, with staging — see [Code View](#code-view)

---

## Data Persistence

### Automatic Storage
Everything is serialized to a **single JSON file** (`state.json`), saved
automatically as you work:
- **Workspaces & agents** (metadata, session ids, working directory)
- **Tasks** and their status, plus **notes / ideas**
- **Activity journal** (rolling 120 days)
- **Layout & shortcuts** (sidebar/pane sizes, rebindings, per-view state)

Terminals themselves are runtime-only — they respawn when a tab is opened.

### Storage Location
- **macOS**: `~/Library/Application Support/codesu/state.json`
- **Windows**: `%APPDATA%\codesu\state.json`
- **Linux**: `~/.local/share/codesu/state.json`

### Durability
- **Atomic writes** (temp → fsync → rename) so a crash can't corrupt `state.json`
- **Rotating backup** kept as `state.json.bak`; auto-recovery if the live file is unreadable
- **Survives app upgrades and reinstalls** (data lives outside the app bundle)
- **Automatic migration** from the old `com.kmlcnclk.codesu/` folder

See the README's [Your data & backups](./README.md#your-data--backups) for details.

---

## Customization

### Appearance & Layout
- **Dark theme** built in
- **Workspace accent colors** assigned automatically as you create workspaces
- **Resizable sidebar, workspace/agent split, and notes pane** — sizes are persisted

### Behavior
- **Mute toggle** for state-change sounds
- **Automatic saving** — no manual save, no interval to configure

### Settings page
- **Default projects**: preset folders offered when creating workspaces
- **Keyboard shortcuts**: fully rebindable, scoped per view; reset to defaults anytime

---

## System Integration

Codesu is built with **Tauri 2**, so it's a small native desktop app rather than a
bundled browser.

- **Primary target: macOS** — universal build (Apple Silicon + Intel), native
  window with a custom title bar, `Cmd`-key shortcuts, and "open in VS Code /
  IntelliJ".
- **Data directories** follow each OS's convention (Application Support on macOS,
  `%APPDATA%` on Windows, XDG data dir on Linux).
- **Windows / Linux**: buildable from source via Tauri, but not currently packaged
  or tested as first-class distributables.

> Note: agent attention uses an **in-app chime + sidebar re-sort**, not OS-level
> notifications or a system-tray icon.

---

## Future Roadmap

### Planned Features
- [ ] Real-time team collaboration (share agents/tasks)
- [ ] AI-powered task suggestions
- [ ] Automated workflow templates
- [ ] Integration with external tools (GitHub, Linear, Jira)
- [ ] Custom agent templates
- [ ] Advanced analytics & insights
- [ ] Web-based dashboard
- [ ] Mobile companion app

---

## Performance Characteristics

- **Memory**: modest baseline; grows with the number of open terminal sessions
- **CPU**: minimal when idle; scales with terminal output (coalesced into ~8ms / 64KB batches)
- **Disk**: small install (~20MB app) plus your `state.json`
- **Network**: Codesu reaches the network only through tools you already trust — the
  `claude` CLI, git, the `gh` CLI (pull-request chip) and, once you connect Slack,
  `curl` polling Slack for your reactions once a minute. Agent state is read from
  terminal output, never polled from an API.

---

*Codesu is constantly evolving. Check back for new features and improvements!*
