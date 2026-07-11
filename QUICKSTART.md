# ⚡ Codesu Quick Start

Get up and running with Codesu in 5 minutes.

---

> **Prerequisite:** the **Claude Code CLI** (`claude`) must be installed and on your
> `PATH` — Codesu launches it for you. Get it from the
> [Claude Code docs](https://docs.anthropic.com/en/docs/claude-code).

## Installation

### macOS (recommended: download)
1. Download `Codesu_x.y.z_universal.dmg`.
2. Open it and drag **Codesu** into **Applications**.
3. First launch: right-click **Codesu → Open → Open** (current builds are unsigned).

The app is universal — Apple Silicon and Intel, macOS 10.15+. Full steps and the
Gatekeeper note are in **[INSTALL.md](./INSTALL.md)** and the
[README](./README.md#download--install-macos).

### Build from source (any platform)
```bash
git clone https://github.com/kmlcnclk/codesu.git
cd codesu
pnpm install
pnpm tauri build            # bundle for the current architecture

# Universal macOS build (Apple Silicon + Intel) needs the rustup targets:
#   rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm tauri build --target universal-apple-darwin
```

---

## Your First Agent

### 1. Create a workspace, then an agent
- First add a **workspace** (a project folder) with the **+** in the sidebar.
- Then add a Claude agent with **Cmd + T** (or the new-agent button).

### 2. Choose the agent kind
- **Claude**: launches the Claude Code CLI (recommended)
- **Shell**: a plain login shell
- **Command**: any custom program you specify

### 3. Start Using It
The agent opens in its own terminal pane. Type your prompt and work as you would
in a terminal.

```bash
# Example: ask Claude to review code
Help me review this function for bugs...

# Or run shell commands
ls -la
git status
```

---

## Keyboard Shortcuts (Essential)

| Shortcut | Action |
|----------|--------|
| **Cmd + 1…9** | Switch between agent tabs |
| **Cmd + T** | New Claude agent |
| **Cmd + A** | Agents view |
| **Cmd + Y** | Tasks (kanban) |
| **Cmd + N** | Notes |
| **Cmd + R** | Daily Report |
| **Cmd + H** | History |
| **Cmd + S** | Settings |
| **Cmd + Shift + T** | Toggle Terminal |

👉 Every shortcut is rebindable in **Settings → Shortcuts**.

---

## Managing Tasks

### Create a Task
1. Click the **Tasks** tab (or press **Cmd + Y**)
2. Add a task in the **Backlog** column
3. Give your task a title and description
4. (Optional) Attach files by dragging them

### Assign an Agent
1. Click on a task
2. Click **"Link Agent"**
3. Select the agent to work on this task

### Track Progress
- Drag tasks across columns: Backlog → In Progress → Testing → Done
- Watch the **Activity Report** for daily summaries

---

## Terminal Tips

### Running Commands
```bash
# Run Python scripts
python my_script.py

# Execute git commands
git commit -m "Fix bug"

# Install packages
pip install numpy

# Or just talk to Claude in a Claude agent's pane
# (type your prompt directly — the pane is running `claude`)
Write a function to parse this JSON and add tests
```

### Keys inside the terminal
These are handled by the shell/CLI running in the pane (standard terminal keys),
not Codesu shortcuts:
- **Ctrl + C** — interrupt the current process
- **Ctrl + L** — clear the screen
- **Tab** — auto-complete

---

## Saving Your Work

Codesu **automatically saves everything**:
- ✅ Agent sessions
- ✅ Task board state
- ✅ Completed tasks
- ✅ Notes and ideas
- ✅ 120 days of activity history

No manual save needed!

---

## Organizing Multiple Projects

### Using Workspaces
1. Create one **workspace per project folder** (each gets its own accent color).
2. Add agents inside the workspace they belong to — they run in that folder.
3. For parallel work on isolated branches, create a **git worktree** from the
   workspace (`<repo>/.worktrees/<branch>`).

### Using the Task Board
1. Create a **task** for each project
2. Link agents to tasks
3. Switch between projects by clicking tasks

### Best Practices
- Use **one agent per major task**
- Keep agent names **short and descriptive**
- Link agents to tasks for context

---

## Practical Examples

### Example 1: Code Review
```
1. Create Agent: "Code Reviewer"
2. Open file in editor
3. Ask Claude: "Review this code for security issues"
4. Attach code file to task
5. Claude suggests improvements
6. Mark task Done when review complete
```

### Example 2: Documentation
```
1. Create Agent: "Doc Writer"
2. Ask Claude: "Write API documentation for our package"
3. Claude generates docs
4. Copy/paste results to your project
5. Mark task Done
```

### Example 3: Multi-Agent Task
```
1. Create Agent: "Backend Dev"
2. Create Agent: "Frontend Dev"
3. Create task: "Build User Profile Feature"
4. Link both agents to task
5. Agents work on their parts simultaneously
6. Move task to Done when both finish
```

---

## Settings & Customization

Open **Settings** (**Cmd + S**). It has two areas:

### Default projects
Preset folders that are offered when you create a new workspace.

### Keyboard shortcuts
- Rebind any shortcut, scoped per view
- Reset to defaults anytime

Other preferences: **mute** state-change sounds with the toggle in the title bar,
and drag to resize the sidebar / panes (sizes are remembered).

---

## Viewing History

### Daily Activity Report
1. Click the **Report** tab (or press **Cmd + R**)
2. See what you accomplished today
3. Review agents and tasks you worked on or completed

### Full History
1. Click **History** tab (or press **Cmd + H**)
2. Browse past sessions
3. See agent snapshots
4. Search for specific commands

---

## Tips & Tricks

### 💡 Pro Tips

1. **Name agents by function**: `code-reviewer`, `docs-writer`, `bug-finder`
2. **Use keyboard shortcuts**: Saves tons of time
3. **Link tasks to agents**: Keeps context clear
4. **Check activity daily**: See what you accomplished
5. **Archive old tasks**: Keep board clean
6. **Use notes page**: Write ideas, convert to tasks later

### 🐛 If Something Goes Wrong

1. **Agent frozen?** Click into its terminal and press **Ctrl + C** to interrupt
2. **Terminal slow?** Clear it with **Ctrl + L**
3. **App opened empty / data missing?** Your data is on disk — see
   [Your data & backups](./README.md#your-data--backups) to restore from `state.json.bak`
4. **Need help?** Check [FEATURES.md](./FEATURES.md) or [README.md](./README.md)

---

## Next Steps

- 📖 Read [FEATURES.md](./FEATURES.md) for detailed feature breakdown
- 🔧 Check out [README.md](./README.md) for tech stack details
- 🤝 [Contribute](./CONTRIBUTING.md) to make Codesu better
- 💬 Join our community (link coming)

---

## Common Workflows

### Daily Development
```
1. Open Codesu
2. Switch to relevant agent (1, 2, 3...)
3. Review task in Task Board
4. Work with Claude on current task
5. Mark task progress
6. Check Activity at end of day
```

### Code Review Session
```
1. Create "Code Review" agent
2. Link to review task
3. Attach code files
4. Ask Claude for detailed review
5. Take action items
6. Create follow-up tasks
7. Mark review complete
```

### Documentation Sprint
```
1. Create "Doc Writer" agent
2. Create "Editor" agent
3. Writer: Generate initial docs
4. Editor: Polish and review
5. Both working in parallel
6. Merge results
7. Commit to repo
```

---

## Performance Tips

- **Keep agent count low** (5-10 is optimal)
- **Close old agents** when not needed
- **Archive completed tasks** regularly
- **Clear terminal output** periodically with **Ctrl/Cmd + L**

---

## Getting Help

- **Bug reports**: [GitHub Issues](https://github.com/kmlcnclk/codesu/issues)
- **Feature requests**: [Discussions](https://github.com/kmlcnclk/codesu/discussions)
- **Documentation**: [README.md](./README.md) & [FEATURES.md](./FEATURES.md)
- **Contributing**: [CONTRIBUTING.md](./CONTRIBUTING.md)

---

**Ready to orchestrate your agents?** 🚀

Start by creating your first agent and exploring the interface. Codesu learns with you!

*Have fun, and happy coding!*
