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
- **Cmd + S to save**, with an unsaved-changes dot on the tab
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
- **Script discovery** — `package.json` scripts (run with the package manager the
  lockfile implies), `Makefile` targets, Cargo, Gradle, Go, Python and the repo's shell
  scripts, including sub-projects up to two levels deep
- **Run panel** — a real shell per workspace, so scripts run with your environment,
  accept input, and keep their scrollback; **Stop** sends `Ctrl-C`
- **Ad-hoc commands**: type anything into the run bar
- The panel is collapsible and resizable, and keeps running while you are in another view

---

## Task & Project Management

### Kanban Board
- **Four-Column Board**:
  - **Backlog**: New tasks not started
  - **In Progress**: Currently being worked on
  - **Testing**: Tasks in QA/review
  - **Done**: Completed tasks (auto-archive)
- *(Ideas are captured separately on the **Notes** page and can be forked into tasks.)*
- **Drag & Drop**: Move tasks between columns
- **Task Details**: Attach files, add descriptions, link agents
- **Spawn an agent from a task**: the task's title, details, and file paths become
  the agent's opening prompt

### Agent-Task Linking
- **Dedicated Agents**: Assign agents to specific tasks
- **Multi-Agent Tasks**: Coordinate multiple agents on complex tasks
- **Task History**: See which agents worked on which tasks
- **Task Comments**: Attach notes and Claude responses to tasks

### File Management
- **Attachments**: Add files to tasks (code, docs, images)
- **Image Preview**: View images directly in the app
- **File Linking**: Reference files across multiple tasks
- **Workspace Files**: Organize by project

---

## Activity & History

### Daily Activity Report
- **Automatic Tracking**: Every action is logged
- **Daily Summaries**: See what you accomplished each day
- **Timeline View**: Hourly breakdown of work activity
- **Task Metrics**: Track productivity by task type

### Session History
- **History page**: Review finished agents and restore them
- **Task archive**: Browse completed/archived tasks
- **Day-by-day journal**: When you worked on or completed each agent and task
- **120-Day Retention**: The activity journal is pruned to a rolling 120-day window

### Search & Filter
- **Task Search**: Quickly locate tasks by name or description
- **Archive browsing**: Completed tasks stay searchable in History

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

### Within Tasks / Notes / History
- **Cmd + 1 / 2 / 3**: Switch between that page's sub-views (board / list / archive)

*Keys typed inside a terminal pane (e.g. `Ctrl+C`, `Ctrl+L`) are handled by the
shell or CLI running there, not by Codesu.*

---

## Git Integration

### Worktree Support
- **Create worktrees on the fly**: `<repo>/.worktrees/<branch>`, so parallel agents
  work on isolated branches without stepping on each other
- **List & remove**: Manage a repo's worktrees straight from the app
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
- **Network**: **Codesu itself makes no network calls** — only the `claude` CLI and
  any git commands you run reach the network. Agent state is read from terminal
  output, never polled from an API.

---

*Codesu is constantly evolving. Check back for new features and improvements!*
