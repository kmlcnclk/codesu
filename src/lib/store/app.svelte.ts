import { invoke } from "@tauri-apps/api/core";
import { SvelteSet } from "svelte/reactivity";
import { playDone, playBlocked } from "$lib/sound";
import {
  readScreenSignal,
  stepTurn,
  freshTurnMemo,
  type ScreenSignal,
  type TurnMemo,
} from "$lib/terminal/claudeScreen";
import {
  type LayoutNode,
  type Dir,
  leaf as makeLeaf,
  collectLeafIds,
  findLeafPath,
  splitLeaf,
  removeLeaf,
  flipParent,
  resizeAt,
} from "$lib/terminal/layout";

export type AgentKind = "claude" | "shell" | "custom";
export type RunStatus = "idle" | "running" | "exited";
export type TaskStatus = "idea" | "backlog" | "in-progress" | "testing" | "done";

export interface Shortcut {
  id: string;
  name: string;
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  context:
    | "global"
    | "agents"
    | "code"
    | "tasks"
    | "notes"
    | "report"
    | "history"
    | "settings"
    | "terminal";
  action: string;
}

/**
 * Live, automatically-derived activity of an agent (distinct from the manual
 * kanban `task`). Drives the sidebar badges, loader animation, sounds, and sort.
 *   working — actively producing output
 *   blocked — quiet, and Claude is waiting on the user (permission / question)
 *   done    — just finished a turn; output to review (until acknowledged)
 *   idle    — quiet and nothing pending (ready to continue)
 *   exited  — the underlying process has ended
 */
export type AgentState = "working" | "blocked" | "done" | "idle" | "exited";

/**
 * Priority ordering of agent states for the sidebar roster (see {@link AppStore.rosterOf}):
 * blocked → done → working → idle → exited. Within a group, most-recently-changed on
 * top (via `stateChangedAt`). This ordering is a hard rule and is preserved across app
 * restarts because `state`/`stateChangedAt` are persisted.
 */
export const STATE_RANK: Record<AgentState, number> = {
  blocked: 0,
  done: 1,
  working: 2,
  idle: 3,
  exited: 4,
};

/**
 * Per-state label and colour. Kept in step with the hue palette in `src/app.css` (this is
 * plain TS, so it can't read a custom property): `working` is the blue hue, `blocked` the
 * danger red, `done` the ok green, and the two quiet states stay grey so the three that
 * want your attention are the only ones with colour.
 */
export const STATE_META: Record<AgentState, { label: string; color: string }> = {
  working: { label: "Working", color: "#6ea8fe" },
  blocked: { label: "Blocked", color: "#f9757a" },
  done: { label: "Done", color: "#4fd07a" },
  idle: { label: "Idle", color: "#8d97a9" },
  exited: { label: "Exited", color: "#5a5d63" },
};

/** How often the activity monitor re-reads every live agent's screen. */
const MONITOR_TICK_MS = 250;
/**
 * How long a launched, off-screen agent may sit unused before its PTY is reclaimed
 * to free system resources. The Claude session is NOT lost — it's resumed via
 * `claude --resume` the next time the agent is opened. See {@link AppState.reapIdleAgents}.
 */
const IDLE_SLEEP_MS = 60 * 60 * 1000; // 1 hour
/** How often the idle-reaper looks for agents to put to sleep. */
const REAP_TICK_MS = 60 * 1000; // 1 minute
/**
 * The live state a dormant agent is allowed to come back as. A restored agent has NO
 * process — nothing can be mid-turn — so `working` (which would pulse "Working…" for
 * an agent that isn't even running) and `exited` (its PTY is simply gone, and the pane
 * offers Resume) both land on `idle`. `blocked` and `done` still mean "this one needs
 * you", so they survive and keep their place at the top of the roster.
 */
function restoredState(saved: unknown): AgentState {
  return saved === "blocked" || saved === "done" ? saved : "idle";
}

export interface TaskMeta {
  label: string;
  color: string;
}

export const TASK_STATUSES: TaskStatus[] = ["backlog", "in-progress", "testing", "done"];

export const TASK_META: Record<TaskStatus, TaskMeta> = {
  idea: { label: "Idea", color: "#8b98a9" },
  backlog: { label: "Backlog", color: "#8b98a9" },
  "in-progress": { label: "In Progress", color: "#6e8bff" },
  testing: { label: "Testing", color: "#c07af7" },
  done: { label: "Done", color: "#3fb950" },
};

/** A file attached to a task (referenced by absolute path on disk). */
export interface TaskAttachment {
  id: string;
  name: string;
  path: string;
  /** true for image types → rendered as an inline thumbnail. */
  isImage: boolean;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "heic"]);

/** Build a {@link TaskAttachment} from an absolute file path. */
export function makeAttachment(path: string): TaskAttachment {
  const name = basename(path);
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return { id: uid("att"), name, path, isImage: IMAGE_EXTS.has(ext) };
}

/**
 * A task or idea. Ideas have status "idea" and live on the Notes page;
 * other statuses live on the Tasks kanban. An idea can fork multiple
 * sibling tasks via forkTask(); each sibling has parentId pointing back.
 */
export interface TaskItem {
  id: string;
  title: string;
  details: string; // was Task.details / Note.body — same field serves both
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  order: number;
  /** Files attached for reference (also handed to the agent). */
  attachments: TaskAttachment[];
  /** Archived items leave the board/notes list. Auto-archived when all forked children complete. */
  archived: boolean;
  workspaceId: string | null;
  agentIds: string[]; // every agent spawned-to-work or attached-as-context, oldest→newest
  parentId: string | null; // if set, this task was forked from an idea/task with this id
}

/**
 * One entry in the day-by-day activity journal — "I worked with / finished this
 * agent-or-task on this day". Name & workspace are SNAPSHOTTED so the entry keeps
 * making sense even after the agent/task is closed or deleted.
 */
export interface ActivityEntry {
  id: string;
  day: string; // local calendar day, "YYYY-MM-DD"
  at: number; // epoch ms of the most recent occurrence that day
  entity: "agent" | "task";
  refId: string; // agent or task id (may no longer exist)
  name: string;
  action: "worked" | "completed";
  workspaceId: string | null;
  workspaceName: string | null;
}

export const ACTIVITY_ACTION_META: Record<
  ActivityEntry["action"],
  { label: string; color: string }
> = {
  worked: { label: "Worked", color: "#6e8bff" },
  completed: { label: "Completed", color: "#3fb950" },
};

/** Local calendar-day key for grouping (avoids UTC off-by-one at midnight). */
export function dayKey(ts: number = Date.now()): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Drop journal entries older than this so the log can't grow without bound. */
const ACTIVITY_RETENTION_DAYS = 120;

/** Accent palette assigned to workspaces by creation order. */
const WORKSPACE_COLORS = [
  "#6e8bff",
  "#f0883e",
  "#3fb950",
  "#c07af7",
  "#f778ba",
  "#e3b341",
  "#39c5cf",
  "#ff7b72",
];

export interface Agent {
  id: string;
  workspaceId: string;
  /**
   * The tab this agent belongs to. Agents sharing a `groupId` are panes of ONE
   * tab and are shown together in a split layout (see {@link AppState.layoutOf}).
   * A brand-new agent gets its own singleton group (groupId === its own id); ⌘D
   * spawns a new agent INTO the focused pane's group.
   */
  groupId: string;
  name: string;
  kind: AgentKind;
  /** Program auto-run in the shell (null => plain shell). */
  run: string | null;
  /** Working dir (null => workspace path). */
  cwd: string | null;
  lane: TaskStatus; // agent's own kanban lane when not dedicated to a task (default "backlog")
  taskId: string | null; // which item (if any) this agent is currently dedicated to
  /** Position among the workspace's TABS (Agents view). See {@link AppState.tabsOf}. */
  order: number;
  /**
   * Position of this agent's card within its lane on the Tasks board — the kanban's
   * OWN ordering key, deliberately separate from {@link order}. The board used to
   * rewrite `order` on every drag, which silently reshuffled the user's tabs in the
   * Agents view. Undefined until the card is first dragged; those agents fall back to
   * `order` so an untouched board keeps exactly its previous arrangement.
   */
  laneOrder?: number;
  /** Stable Claude Code session id (uuid) so the conversation can be resumed. */
  sessionId: string | null;
  /** Whether this Claude session has been launched at least once (=> resume, not create). */
  sessionStarted: boolean;
  /**
   * The directory the Claude session was FIRST created in, captured on first launch.
   * `claude --resume <id>` is project/cwd-scoped — it only finds a session when run
   * from the same directory it was created in — so the agent must always be launched
   * here, even if its workspace path later changes (e.g. a worktree is relocated).
   * Binding to this is what stops a resume from silently starting an EMPTY session.
   * Null until the first launch, and for non-Claude agents.
   */
  sessionCwd: string | null;
  /** When the agent was created (epoch ms) — surfaced on the History page. */
  createdAt: number;
  /**
   * When the agent was last used/updated (epoch ms) — bumped on selection, on user
   * input turns, and when a turn finishes. Drives the sidebar roster's recency sort.
   */
  lastUsedAt: number;
  /**
   * A prompt seeded into Claude on the very first launch (used by the Tasks page so a
   * new agent starts working the task immediately). Cleared once the session starts.
   */
  initialPrompt: string | null;
  /** Archived alongside its workspace — hidden from the active UI, restored on unarchive. */
  archived: boolean;
  // runtime-only (not persisted)
  status: RunStatus;
  exitCode: number | null;
  /** Auto-derived activity — drives sidebar badges, loader, sounds, and sort. */
  state: AgentState;
  /** Epoch ms of the last {@link state} change — drives the recency sort within each
   * status group (most-recently done/working/idle floats to the top of its group). */
  stateChangedAt: number;
  /** True once the user has looked at this agent's finished work (clears "done"). */
  acknowledged: boolean;
}

/**
 * A closed agent kept whole so it can be put back (⌘⇧Z — see
 * {@link AppState.reopenLastAgent}). Closing is destructive and permanent, and is
 * reachable from several one-click places with no confirmation, so the WHOLE record
 * is snapshotted: keeping only the id (as this used to) could never work, because
 * {@link AppState.removeAgent} hard-deletes the agent the id pointed at.
 */
export interface ClosedAgent {
  /** The agent exactly as it was closed. Re-inserted verbatim, minus runtime fields. */
  agent: Agent;
  /** Its tab's split tree at the moment of the close, so a reopened pane lands back in
   * the arrangement it left. Null when the tab had no stored layout (a lone pane). */
  layout: LayoutNode | null;
}

export interface Workspace {
  id: string;
  name: string;
  path: string;
  color: string;
  order: number;
  archived: boolean;
  /** For git worktrees: the parent repo + branch (enables removal). */
  repo: string | null;
  branch: string | null;
  isWorktree: boolean;
}

const KIND_LABELS: Record<AgentKind, string> = {
  claude: "Claude",
  shell: "Shell",
  custom: "Command",
};

export function runCommandFor(kind: AgentKind, custom: string): string | null {
  if (kind === "claude") return "claude";
  if (kind === "custom") return custom.trim() || null;
  return null;
}

/**
 * A globally unique id, prefixed so it stays readable in state files and logs.
 *
 * The suffix is a UUID rather than a counter: the old `counter`-plus-
 * `performance.now()` scheme could COLLIDE ACROSS RESTARTS, because the counter was
 * re-seeded from the current item count (so every deletion freed a slot) and
 * `performance.now()` restarts near zero on each launch — an `agent-4-8123` minted
 * ~8.1s into one session could be minted again in a later one, and a duplicate id
 * corrupts every keyed list and `find(x => x.id === …)` lookup. Nothing parses the
 * suffix (only the prefix is ever read, and only by humans), so this is a free fix.
 */
function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/**
 * The next `order` slot for a new (or restored) item: one past the highest existing
 * order. Using max+1 rather than the item count keeps orders unique even after items
 * are removed without re-sequencing — the collision that used to scramble the tab and
 * workspace ordering across app restarts.
 */
function nextOrder(items: { order: number }[]): number {
  return items.reduce((max, it) => Math.max(max, it.order), -1) + 1;
}

/**
 * Re-sequence `order` to a dense, unique 0..n-1 range that preserves the items'
 * current sorted arrangement. Heals legacy state whose orders had duplicates or gaps.
 */
function normalizeOrder<T extends { order: number }>(items: T[], tieBreak: (a: T, b: T) => number): void {
  items
    .slice()
    .sort((a, b) => a.order - b.order || tieBreak(a, b))
    .forEach((it, i) => (it.order = i));
}

/** First non-empty line of a block of text (used to title an untitled note). */
function firstLine(s: string): string {
  return s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}
/** Everything after the first non-empty line. */
function stripFirstLine(s: string): string {
  const lines = s.split("\n");
  const i = lines.findIndex((l) => l.trim());
  return i === -1 ? "" : lines.slice(i + 1).join("\n").trim();
}

/**
 * Quote a string so it can be safely typed into the shell as one argument.
 *
 * Uses ANSI-C quoting ($'...') rather than plain single quotes so the command
 * stays on a SINGLE physical line: the prompt is typed-ahead into the PTY, and a
 * real embedded newline would trip the shell's line editor (submit early / show
 * a continuation prompt). Encoding newlines as `\n` keeps the command one line
 * while the shell still expands them to real newlines for the launched program.
 *
 * Leading/trailing whitespace and blank lines are trimmed; internal newlines are
 * preserved, so a multi-line prompt reaches the agent formatted as the user typed
 * it (minus the surrounding blank lines). Requires a bash/zsh-compatible login
 * shell, which is the macOS default ($SHELL, falling back to /bin/bash).
 */
export function shellQuote(s: string): string {
  const body = s
    .trim() // strip leading/trailing whitespace and blank lines
    .replace(/\\/g, "\\\\") // escape backslashes first
    .replace(/'/g, "\\'") // escape single quotes for $'...'
    .replace(/\r/g, "") // drop carriage returns
    .replace(/\n/g, "\\n") // real newlines -> \n (keeps command single-line)
    .replace(/\t/g, "\\t");
  return `$'${body}'`;
}

/** Fold a task's title + details (+ any attached file paths) into a seed prompt. */
export function buildTaskPrompt(
  t: Pick<TaskItem, "title" | "details"> & { attachments?: TaskAttachment[] },
): string {
  let out = t.title.trim();
  const details = t.details.trim();
  if (details) out += `\n\n${details}`;
  const files = t.attachments ?? [];
  if (files.length) {
    out += `\n\nAttached files:\n${files.map((a) => `- ${a.path}`).join("\n")}`;
  }
  return out.trim();
}

class AppState {
  workspaces = $state<Workspace[]>([]);
  agents = $state<Agent[]>([]);
  tasks = $state<TaskItem[]>([]);
  /** Day-by-day journal of worked/completed agents & tasks. */
  activityLog = $state<ActivityEntry[]>([]);
  /** Transient: a task the board should scroll to & flash (e.g. opened from a note). */
  focusTaskId = $state<string | null>(null);
  activeWorkspaceId = $state<string | null>(null);
  /** Per-workspace active agent id (the FOCUSED pane — always a leaf of the active tab). */
  activeAgentByWs = $state<Record<string, string | null>>({});
  /** Per-workspace active tab id (a `groupId`). The tab whose split grid is on screen. */
  activeTabByWs = $state<Record<string, string | null>>({});
  /**
   * Split layout per tab, keyed by `groupId`. Absent → the tab is a single full
   * pane (its one agent). Persisted so arrangements survive restarts. See
   * {@link import("$lib/terminal/layout").LayoutNode}.
   */
  tabLayouts = $state<Record<string, LayoutNode>>({});
  /** Default project paths to pre-populate in workspace creation. */
  defaultProjects = $state<string[]>([]);
  /** System terminal scroll position memory. */
  terminalScrollPos = $state(0);
  /** Keyboard shortcuts configuration. */
  shortcuts = $state<Shortcut[]>([]);
  /** Page-specific view states. */
  pageViews = $state<Record<string, string>>({
    tasks: "board", // "board" | "list" | "archive"
    notes: "active", // "active" | "archive"
    history: "default", // single view
    report: "default", // single view
  });
  /** Per-note editor mode (edit vs preview), persisted so it survives reopening. */
  notePreview = $state<Record<string, boolean>>({});
  /** The note the user last had open, restored when re-entering the Notes page. */
  lastNoteId = $state<string | null>(null);
  /** Last closed agent, snapshotted whole for undo/reopen. See {@link ClosedAgent}. */
  lastClosed = $state<ClosedAgent | null>(null);
  /** Width (px) of the left sidebar rail — user-resizable, persisted. */
  sidebarWidth = $state(268);
  /**
   * Workspaces whose agent children are collapsed in the sidebar tree, by id.
   * Absent / false means expanded — a new workspace shows its agents by default.
   * Persisted so the tree looks the same after a restart.
   */
  wsCollapsed = $state<Record<string, boolean>>({});
  /** Width (px) of the Notes page's note-list pane — user-resizable, persisted. */
  notesListWidth = $state(296);

  // ---------- Code view (built-in editor / review / run) ----------
  /**
   * Files open in the Code view's editor, per workspace. Only the PATHS are persisted —
   * the buffers themselves are re-read from disk on reopen, so the app never shows a
   * stale copy of a file an agent has since rewritten.
   */
  codeOpenByWs = $state<Record<string, { paths: string[]; active: string | null }>>({});
  /** Which panel the Code view's left rail shows: the file tree or the git changes. */
  codeSideTab = $state<"files" | "changes">("files");
  /** Width (px) of the Code view's left rail — user-resizable, persisted. */
  codeTreeWidth = $state(260);
  /** Height (px) of the Code view's run panel. Zero means collapsed. */
  codeRunHeight = $state(0);
  /** Show dotfiles in the Code view's file tree. */
  codeShowHidden = $state(false);
  /** Side-by-side (GitHub-style) vs. unified diff in the review pane. */
  codeDiffSplit = $state(false);
  /**
   * Files ticked "Viewed" during review, per workspace: path → the signature the diff
   * had when it was ticked.
   *
   * The signature is what makes the tick trustworthy. An agent rewriting a file you had
   * already reviewed must un-tick it, and storing a plain boolean could not express
   * that — see `diffSignature` in $lib/code/diff.
   */
  codeViewedByWs = $state<Record<string, Record<string, string>>>({});

  /** Has `path` been reviewed at exactly this content? */
  isCodeViewed(wsId: string, path: string, signature: string): boolean {
    return this.codeViewedByWs[wsId]?.[path] === signature;
  }

  setCodeViewed(wsId: string, path: string, signature: string, viewed: boolean) {
    const slot = (this.codeViewedByWs[wsId] ??= {});
    if (viewed) slot[path] = signature;
    else delete slot[path];
    this.persist();
  }

  /**
   * Drop ticks whose file has changed since it was reviewed.
   *
   * Called with the signatures of the diffs actually on screen. `isCodeViewed` already
   * answers "no" for a stale entry, but the entry itself has to go too, or the changed-
   * file list — which has no diff, and so no signature, to compare against — would keep
   * showing the file as reviewed.
   */
  syncCodeViewed(wsId: string, signatures: Map<string, string>) {
    const slot = this.codeViewedByWs[wsId];
    if (!slot) return;
    let changed = false;
    for (const [path, sig] of signatures) {
      if (slot[path] !== undefined && slot[path] !== sig) {
        delete slot[path];
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  /** Has `path` been reviewed at whatever version was last seen? (No diff needed.) */
  hasCodeViewedEntry(wsId: string, path: string): boolean {
    return this.codeViewedByWs[wsId]?.[path] !== undefined;
  }

  /** How many of `paths` are ticked as reviewed. */
  codeViewedCount(wsId: string, paths: string[]): number {
    const slot = this.codeViewedByWs[wsId];
    if (!slot) return 0;
    return paths.reduce((n, p) => n + (slot[p] !== undefined ? 1 : 0), 0);
  }

  /** Clear every tick for a workspace (the "start the review again" button). */
  clearCodeViewed(wsId: string) {
    this.codeViewedByWs[wsId] = {};
    this.persist();
  }

  toggleCodeDiffSplit() {
    this.codeDiffSplit = !this.codeDiffSplit;
    this.persist();
  }

  /** The Code view's open-file record for `wsId`, created on first use. */
  private codeSlot(wsId: string): { paths: string[]; active: string | null } {
    let slot = this.codeOpenByWs[wsId];
    if (!slot) {
      slot = { paths: [], active: null };
      this.codeOpenByWs[wsId] = slot;
    }
    return slot;
  }

  codeOpenPaths(wsId: string): string[] {
    return this.codeOpenByWs[wsId]?.paths ?? [];
  }

  codeActivePath(wsId: string): string | null {
    return this.codeOpenByWs[wsId]?.active ?? null;
  }

  /** Open (or focus, if already open) a file in the Code view's editor. */
  openCodeFile(wsId: string, path: string) {
    const slot = this.codeSlot(wsId);
    if (!slot.paths.includes(path)) slot.paths = [...slot.paths, path];
    slot.active = path;
    this.persist();
  }

  /**
   * Close one editor tab. The neighbour that takes focus is the tab to the LEFT (or the
   * new last one), the same choice every editor makes — closing the file you just
   * finished with should land you back on the one you came from.
   */
  closeCodeFile(wsId: string, path: string) {
    const slot = this.codeSlot(wsId);
    const i = slot.paths.indexOf(path);
    if (i < 0) return;
    slot.paths = slot.paths.filter((p) => p !== path);
    if (slot.active === path) {
      slot.active = slot.paths[Math.min(i, slot.paths.length - 1)] ?? null;
    }
    this.persist();
  }

  setActiveCodeFile(wsId: string, path: string | null) {
    this.codeSlot(wsId).active = path;
    this.persist();
  }

  /** Drop editor tabs for files that no longer exist (checked when the view opens). */
  pruneCodeFiles(wsId: string, missing: string[]) {
    if (!missing.length) return;
    const slot = this.codeSlot(wsId);
    const gone = new Set(missing);
    slot.paths = slot.paths.filter((p) => !gone.has(p));
    if (slot.active && gone.has(slot.active)) slot.active = slot.paths[0] ?? null;
    this.persist();
  }

  /**
   * Agents whose Claude/shell process the user has explicitly opened THIS run.
   * Session-scoped and deliberately NOT persisted: on a fresh launch it starts
   * empty, so restoring the last-active agent shows it but does NOT auto-spawn its
   * PTY / resume Claude.
   *
   * A Claude session is NEVER resumed automatically. A process starts on exactly two
   * explicit actions:
   *   1. CREATING a new agent (addAgent) — there is no prior conversation to resume,
   *      so it launches immediately (and may seed a task prompt);
   *   2. clicking the "Resume" placeholder on an existing agent (launchAgent).
   * Merely SELECTING/focusing an agent — clicking its tab or roster row, switching
   * into its workspace, opening it from another page, reopen, or restore-from-History
   * — does NOT launch it: the pane shows the "Resume" placeholder until clicked. This
   * guarantees a saved conversation is only ever continued by a deliberate click, and
   * stops many agents from launching at once when the app is reopened.
   * @see TerminalPane — gates `start()` on {@link isLaunched}.
   */
  launchedAgentIds = new SvelteSet<string>();

  /**
   * Agents whose PTY we deliberately killed to reclaim resources (idle > 1h and
   * off-screen — see {@link reapIdleAgents}). Their Claude session is untouched and
   * resumes on reopen. Tracked so the `session-exited` event that killing fires is
   * recognised as an intentional sleep, not a real termination (see {@link markExited}).
   * Session-scoped and deliberately NOT persisted.
   */
  private sleepingAgentIds = new Set<string>();

  /**
   * Workspace paths that are NOT directories on disk any more — a folder that was
   * moved or renamed, or a worktree deleted outside the app (e.g. workspaces created
   * before worktrees moved to `~/.codesu/worktrees`).
   *
   * Agents there cannot be launched: the PTY refuses a missing cwd rather than
   * silently starting in `$HOME`, which used to make Claude Code re-ask "do you trust
   * this folder?" for the home directory on every open. Kept as a session-scoped path
   * set (not per workspace id) so duplicate workspaces on one path resolve together.
   * @see checkWorkspacePaths
   */
  missingPaths = new SvelteSet<string>();

  private loaded = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  private getDefaultShortcuts(): Shortcut[] {
    return [
      // Global shortcuts
      { id: "open-agents", name: "Go to Agents", key: "a", ctrl: false, shift: false, alt: false, meta: true, context: "global", action: "navigate-agents" },
      { id: "open-tasks", name: "Go to Tasks", key: "y", ctrl: false, shift: false, alt: false, meta: true, context: "global", action: "navigate-tasks" },
      { id: "open-notes", name: "Go to Notes", key: "n", ctrl: false, shift: false, alt: false, meta: true, context: "global", action: "navigate-notes" },
      { id: "open-report", name: "Go to Report", key: "r", ctrl: false, shift: false, alt: false, meta: true, context: "global", action: "navigate-report" },
      { id: "open-history", name: "Go to History", key: "h", ctrl: false, shift: false, alt: false, meta: true, context: "global", action: "navigate-history" },
      { id: "open-settings", name: "Go to Settings", key: "s", ctrl: false, shift: false, alt: false, meta: true, context: "global", action: "navigate-settings" },
      { id: "open-terminal", name: "Go to Terminal", key: "t", ctrl: false, shift: true, alt: false, meta: true, context: "global", action: "navigate-terminal" },
      { id: "open-code", name: "Go to Code", key: "e", ctrl: false, shift: false, alt: false, meta: true, context: "global", action: "navigate-code" },

      // Agents page only
      { id: "new-claude-agent", name: "New Claude Agent", key: "t", ctrl: false, shift: false, alt: false, meta: true, context: "agents", action: "new-claude-agent" },
      { id: "split-pane-vertical", name: "Split Pane (side by side)", key: "d", ctrl: false, shift: false, alt: false, meta: true, context: "agents", action: "split-pane-vertical" },
      { id: "split-pane-horizontal", name: "Split Pane (stacked)", key: "d", ctrl: false, shift: true, alt: false, meta: true, context: "agents", action: "split-pane-horizontal" },
      { id: "flip-split", name: "Flip Split Direction", key: "e", ctrl: false, shift: true, alt: false, meta: true, context: "agents", action: "flip-split" },
      // "Backspace", not "Delete": the Mac delete key reports `e.key === "Backspace"`,
      // so the advertised ⌘⌫ never matched the old binding (only Fn+Delete did).
      { id: "close-current-agent", name: "Close Current Agent", key: "Backspace", ctrl: false, shift: false, alt: false, meta: true, context: "agents", action: "close-current-agent" },
      { id: "reopen-last-agent", name: "Reopen Last Closed Agent", key: "z", ctrl: false, shift: true, alt: false, meta: true, context: "agents", action: "reopen-last-agent" },
      { id: "select-tab-1", name: "Select Tab 1", key: "1", ctrl: false, shift: false, alt: false, meta: true, context: "agents", action: "select-tab-1" },
      { id: "select-tab-2", name: "Select Tab 2", key: "2", ctrl: false, shift: false, alt: false, meta: true, context: "agents", action: "select-tab-2" },
      { id: "select-tab-3", name: "Select Tab 3", key: "3", ctrl: false, shift: false, alt: false, meta: true, context: "agents", action: "select-tab-3" },
      { id: "select-tab-4", name: "Select Tab 4", key: "4", ctrl: false, shift: false, alt: false, meta: true, context: "agents", action: "select-tab-4" },
      { id: "select-tab-5", name: "Select Tab 5", key: "5", ctrl: false, shift: false, alt: false, meta: true, context: "agents", action: "select-tab-5" },
      { id: "select-tab-6", name: "Select Tab 6", key: "6", ctrl: false, shift: false, alt: false, meta: true, context: "agents", action: "select-tab-6" },
      { id: "select-tab-7", name: "Select Tab 7", key: "7", ctrl: false, shift: false, alt: false, meta: true, context: "agents", action: "select-tab-7" },
      { id: "select-tab-8", name: "Select Tab 8", key: "8", ctrl: false, shift: false, alt: false, meta: true, context: "agents", action: "select-tab-8" },
      { id: "select-tab-9", name: "Select Tab 9", key: "9", ctrl: false, shift: false, alt: false, meta: true, context: "agents", action: "select-tab-9" },

      // Tasks page view shortcuts
      { id: "tasks-view-board", name: "Tasks - Board View", key: "1", ctrl: false, shift: false, alt: false, meta: true, context: "tasks", action: "set-page-view-board" },
      { id: "tasks-view-list", name: "Tasks - List View", key: "2", ctrl: false, shift: false, alt: false, meta: true, context: "tasks", action: "set-page-view-list" },
      { id: "tasks-view-archive", name: "Tasks - Archive View", key: "3", ctrl: false, shift: false, alt: false, meta: true, context: "tasks", action: "set-page-view-archive" },

      // Notes page view shortcuts
      { id: "notes-view-active", name: "Notes - Active", key: "1", ctrl: false, shift: false, alt: false, meta: true, context: "notes", action: "set-page-view-active" },
      { id: "notes-view-archived", name: "Notes - Archive", key: "2", ctrl: false, shift: false, alt: false, meta: true, context: "notes", action: "set-page-view-archived" },

      // History page shortcuts (if needed for consistency)
      { id: "history-view-default", name: "History - All", key: "1", ctrl: false, shift: false, alt: false, meta: true, context: "history", action: "set-page-view-default" },

      // Report page shortcuts (if needed for consistency)
      { id: "report-view-default", name: "Report - View", key: "1", ctrl: false, shift: false, alt: false, meta: true, context: "report", action: "set-page-view-default" },
    ];
  }

  // ---------- derived ----------

  get liveWorkspaces(): Workspace[] {
    // Tie-break on the stable id so colliding `order` values (which past releases
    // could produce) can never reshuffle across reloads — same idiom as boardTasks.
    return this.workspaces
      .filter((w) => !w.archived)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }
  get archivedWorkspaces(): Workspace[] {
    return this.workspaces.filter((w) => w.archived);
  }
  get activeWorkspace(): Workspace | undefined {
    return this.workspaces.find((w) => w.id === this.activeWorkspaceId);
  }

  /**
   * The directory an agent actually runs in: its own `cwd` when set, otherwise its
   * workspace's path. Null when neither is usable — a workspace row that has gone, or
   * a blank path (`addWorkspace` does not reject one, and legacy state files carry
   * them). A blank string is normalised to null on purpose: the PTY reads "no cwd" as
   * `$HOME`, which is right for the system terminal but catastrophic for an agent, so
   * TerminalPane refuses to launch a null instead of passing it down.
   */
  cwdOf(agent: Agent): string | null {
    // A started Claude session is PINNED to the directory it was created in
    // (`sessionCwd`): `claude --resume` is cwd-scoped, so running from anywhere else
    // finds no conversation and creates a fresh EMPTY one. This wins over the (possibly
    // drifted) workspace path so resume always lands in the right project. A brand-new
    // agent (sessionCwd null) uses its explicit cwd or the workspace path, and binds
    // sessionCwd on first launch (see markSessionStarted).
    const dir =
      agent.sessionCwd ?? agent.cwd ?? this.workspaces.find((w) => w.id === agent.workspaceId)?.path;
    return dir && dir.trim() ? dir : null;
  }

  /** True when this path was found to be gone by {@link checkWorkspacePaths}. */
  isPathMissing(path: string | null | undefined): boolean {
    return !!path && this.missingPaths.has(path);
  }

  /** True when the workspace's folder is gone — its agents cannot be launched. */
  isWorkspaceMissing(workspaceId: string): boolean {
    const w = this.workspaces.find((x) => x.id === workspaceId);
    return !!w && this.isPathMissing(w.path);
  }

  /**
   * Re-check every live workspace folder against the filesystem and refresh
   * {@link missingPaths}. Cheap (one stat per distinct path) and safe to re-run — it
   * is called after load and whenever the window regains focus, so a folder deleted
   * or restored outside the app is picked up without a restart.
   */
  async checkWorkspacePaths(): Promise<void> {
    const paths = [...new Set(this.liveWorkspaces.map((w) => w.path).filter(Boolean))];
    const results = await Promise.all(
      paths.map(async (p) => {
        try {
          return [p, await invoke<boolean>("dir_exists", { path: p })] as const;
        } catch {
          return [p, true] as const; // never flag a workspace on an IPC failure
        }
      }),
    );
    for (const [p, exists] of results) {
      if (exists) this.missingPaths.delete(p);
      else this.missingPaths.add(p);
    }
  }

  /** Non-done agents of a workspace, ordered — these become the tabs. */
  tabsOf(workspaceId: string): Agent[] {
    return this.agents
      .filter(
        (a) => a.workspaceId === workspaceId && !a.archived && this.effectiveLane(a) !== "done",
      )
      // Tie-break on createdAt (then id) so agents that share an `order` — which
      // legacy data can — keep a fixed, reload-stable position instead of falling
      // back to array order and appearing to shuffle when the app is reopened.
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  get activeTabs(): Agent[] {
    return this.activeWorkspaceId ? this.tabsOf(this.activeWorkspaceId) : [];
  }
  /**
   * The FOCUSED pane's agent — the target of ⌘D, keyboard focus, and the breadcrumb.
   * Must be a leaf of the active tab; if the stored focus drifted outside it (e.g. the
   * focused pane finished and left the tab), we fall back to the first visible pane.
   */
  get activeAgent(): Agent | undefined {
    const wsId = this.activeWorkspaceId;
    if (!wsId) return undefined;
    const id = this.activeAgentByWs[wsId];
    const a = this.agents.find(
      (x) => x.id === id && !x.archived && this.effectiveLane(x) !== "done",
    );
    const g = this.activeGroupId(wsId);
    if (a && a.groupId === g) return a;
    const vis = this.visibleAgentIds;
    return vis.length ? this.agents.find((x) => x.id === vis[0]) : undefined;
  }
  /**
   * Agents whose terminals stay mounted. We deliberately KEEP kanban-done agents
   * mounted (hidden) so their PTY — and thus the Claude session — is never torn
   * down when they're archived to History; restoring is then instant & lossless.
   * Only an explicit Close (removeAgent) actually kills the process.
   */
  get mountedAgents(): Agent[] {
    const liveWs = new Set(this.liveWorkspaces.map((w) => w.id));
    return this.agents.filter((a) => !a.archived && liveWs.has(a.workspaceId));
  }

  // ---------- tabs & split layout ----------
  //
  // A "tab" is a GROUP of agents sharing a `groupId`, arranged in a split tree
  // (see $lib/terminal/layout). tabsOf() lists the workspace's displayable agents;
  // tabGroups() folds them into tabs. layoutFor() reconciles a tab's stored split
  // tree against its current agents so the render never references a departed pane.

  /** Displayable agents of one tab (group), in a stable order. */
  agentsInGroup(groupId: string): Agent[] {
    return this.agents
      .filter(
        (a) => a.groupId === groupId && !a.archived && this.effectiveLane(a) !== "done",
      )
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  /** One entry per tab (group) in a workspace, ordered like the underlying tabs. */
  tabGroups(workspaceId: string): { groupId: string; agents: Agent[]; order: number }[] {
    const map = new Map<string, Agent[]>();
    for (const a of this.tabsOf(workspaceId)) {
      const list = map.get(a.groupId) ?? [];
      list.push(a);
      map.set(a.groupId, list);
    }
    return [...map.entries()]
      .map(([groupId, agents]) => ({
        groupId,
        agents,
        order: Math.min(...agents.map((a) => a.order)),
      }))
      .sort((x, y) => x.order - y.order);
  }
  get activeTabGroups(): { groupId: string; agents: Agent[]; order: number }[] {
    return this.activeWorkspaceId ? this.tabGroups(this.activeWorkspaceId) : [];
  }

  /**
   * The split tree to render for a tab, reconciled against the group's live agents:
   * leaves for agents that left the tab are pruned, and any group agent missing from
   * the stored tree is appended. Pure — does not persist. Null when the tab is empty.
   */
  layoutFor(groupId: string): LayoutNode | null {
    const agents = this.agentsInGroup(groupId);
    if (agents.length === 0) return null;
    const ids = new Set(agents.map((a) => a.id));
    let tree: LayoutNode | null = this.tabLayouts[groupId] ?? null;
    if (tree) {
      for (const lid of collectLeafIds(tree)) {
        if (!ids.has(lid)) tree = tree ? removeLeaf(tree, lid) : null;
      }
    }
    const present = new Set(tree ? collectLeafIds(tree) : []);
    for (const a of agents) {
      if (present.has(a.id)) continue;
      tree = tree ? splitLeaf(tree, collectLeafIds(tree)[0], a.id, "row") : makeLeaf(a.id);
      present.add(a.id);
    }
    return tree;
  }

  /** The active (on-screen) tab id for a workspace, self-healing if it went stale. */
  activeGroupId(workspaceId: string): string | null {
    const groups = this.tabGroups(workspaceId);
    const stored = this.activeTabByWs[workspaceId];
    if (stored && groups.some((g) => g.groupId === stored)) return stored;
    const focusId = this.activeAgentByWs[workspaceId];
    const focus = focusId ? this.agents.find((a) => a.id === focusId) : null;
    if (focus && groups.some((g) => g.groupId === focus.groupId)) return focus.groupId;
    return groups[0]?.groupId ?? null;
  }
  get activeGroup(): string | null {
    return this.activeWorkspaceId ? this.activeGroupId(this.activeWorkspaceId) : null;
  }

  /** The split tree currently on screen (active tab of the active workspace). */
  get visibleLayout(): LayoutNode | null {
    const g = this.activeGroup;
    return g ? this.layoutFor(g) : null;
  }
  /** Agent ids of every visible pane — the leaves of {@link visibleLayout}. */
  get visibleAgentIds(): string[] {
    const l = this.visibleLayout;
    return l ? collectLeafIds(l) : [];
  }

  /** Switch to a tab (group) and focus one of its panes. */
  setActiveTab(groupId: string) {
    const agents = this.agentsInGroup(groupId);
    if (!agents.length) return;
    const wsId = agents[0].workspaceId;
    const cur = this.activeAgentByWs[wsId];
    const keep = cur && agents.some((a) => a.id === cur);
    const tree = this.layoutFor(groupId);
    const focus = keep ? cur! : (tree ? collectLeafIds(tree)[0] : agents[0].id);
    this.activeTabByWs[wsId] = groupId;
    // setActiveAgent writes the same tab id and persists both maps, so no save here.
    this.setActiveAgent(focus);
  }

  /**
   * Split the focused pane and launch a NEW Claude agent beside it (⌘D → "row",
   * side-by-side; ⌘⇧D → "col", stacked). The new pane becomes the focus. With no
   * focused pane it just opens a fresh tab.
   */
  splitFocused(dir: Dir) {
    const focus = this.activeAgent;
    if (!focus) {
      this.newClaudeInActive();
      return;
    }
    const groupId = focus.groupId;
    // Base on the RECONCILED tree (includes any pane appended since the last save)
    // so the new split lands exactly beside the focused pane.
    const prev: LayoutNode = this.layoutFor(groupId) ?? makeLeaf(focus.id);
    const created = this.addAgent({
      workspaceId: focus.workspaceId,
      kind: "claude",
      run: "claude",
      groupId,
    });
    this.tabLayouts = { ...this.tabLayouts, [groupId]: splitLeaf(prev, focus.id, created.id, dir) };
    this.activeAgentByWs[focus.workspaceId] = created.id;
    this.persist();
  }

  /** Flip the orientation (row⇄col) of the split holding the given pane. */
  flipSplitOf(agentId: string) {
    const a = this.agents.find((x) => x.id === agentId);
    if (!a) return;
    const tree = this.tabLayouts[a.groupId];
    if (!tree) return;
    this.tabLayouts = { ...this.tabLayouts, [a.groupId]: flipParent(tree, agentId) };
    this.persist();
  }

  /** Drag-resize: move `deltaFrac` of a split's axis across gutter `index`. */
  resizePane(groupId: string, path: number[], index: number, deltaFrac: number) {
    const tree = this.tabLayouts[groupId];
    if (!tree) return;
    this.tabLayouts = { ...this.tabLayouts, [groupId]: resizeAt(tree, path, index, deltaFrac) };
    this.persist();
  }
  /**
   * The agent roster for a workspace (the sidebar's bottom section). Ordered STRICTLY
   * by these rules (never break them):
   *   1. blocked (needs your input)  — highest priority
   *   2. done    (finished, to review)
   *   3. working (running now)
   *   4. idle
   *   5. exited
   * and WITHIN each group the agent that entered that state most recently sits on top
   * (recency via `stateChangedAt`, newest first).
   *
   * Both `state` and `stateChangedAt` are persisted and restored on load (see snapshot
   * / load), so closing and reopening the app brings the agents back in this exact
   * order — the last-left positions are remembered. `createdAt` is only a final
   * deterministic tiebreak for the impossible case of identical state + timestamp.
   */
  rosterOf(workspaceId: string): Agent[] {
    return this.agents
      .filter(
        (a) => a.workspaceId === workspaceId && !a.archived && this.effectiveLane(a) !== "done",
      )
      .sort(
        (a, b) =>
          STATE_RANK[a.state] - STATE_RANK[b.state] ||
          (b.stateChangedAt ?? 0) - (a.stateChangedAt ?? 0) ||
          a.createdAt - b.createdAt,
      );
  }
  get activeRoster(): Agent[] {
    return this.activeWorkspaceId ? this.rosterOf(this.activeWorkspaceId) : [];
  }
  /** Count of blocked / done agents across all live workspaces (for the badge). */
  attentionCountOf(workspaceId: string): number {
    return this.agents.filter(
      (a) =>
        a.workspaceId === workspaceId &&
        !a.archived &&
        this.effectiveLane(a) !== "done" &&
        (a.state === "blocked" || a.state === "done"),
    ).length;
  }
  /**
   * Agents shown on the History page, newest-first: those marked Done, plus any
   * archived alongside their workspace (so an archived workspace's agents are still
   * visible and restorable there).
   */
  get historyAgents(): Agent[] {
    return this.agents
      .filter((a) => a.archived || this.effectiveLane(a) === "done")
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }
  countOf(workspaceId: string): number {
    return this.tabsOf(workspaceId).length;
  }

  // ---------- mutations ----------

  addWorkspace(input: {
    name?: string;
    path: string;
    repo?: string | null;
    branch?: string | null;
    isWorktree?: boolean;
  }): Workspace {
    const ws: Workspace = {
      id: uid("ws"),
      name: input.name?.trim() || basename(input.path),
      path: input.path,
      color: WORKSPACE_COLORS[this.workspaces.length % WORKSPACE_COLORS.length],
      order: nextOrder(this.workspaces),
      archived: false,
      repo: input.repo ?? null,
      branch: input.branch ?? null,
      isWorktree: input.isWorktree ?? false,
    };
    this.workspaces.push(ws);
    this.activeWorkspaceId = ws.id;
    this.persist();
    return ws;
  }

  archiveWorkspace(id: string) {
    const ws = this.workspaces.find((w) => w.id === id);
    if (!ws) return;
    ws.archived = true;
    // Archive the workspace's agents along with it — they leave the active UI and
    // their PTYs are torn down (via mountedAgents), then restored on unarchive.
    for (const a of this.agents) {
      if (a.workspaceId !== id) continue;
      a.archived = true;
      // Their panes unmount and TerminalPane kills the PTYs, so these agents are no
      // longer "explicitly opened this run". Leaving the ids behind made
      // unarchiveWorkspace remount panes that still counted as launched, and each one
      // immediately ran `claude --resume` — an auto-resume the user never asked for.
      // A session may only ever be continued by creating an agent or clicking Resume.
      this.launchedAgentIds.delete(a.id);
    }
    if (this.activeWorkspaceId === id) {
      this.activeWorkspaceId = this.liveWorkspaces[0]?.id ?? null;
    }
    this.persist();
  }

  unarchiveWorkspace(id: string) {
    const ws = this.workspaces.find((w) => w.id === id);
    if (!ws) return;
    ws.archived = false;
    // Give it a fresh slot at the end of the live list so its stale `order` can't
    // collide with a workspace that took that slot while it was archived.
    ws.order = nextOrder(this.workspaces.filter((w) => !w.archived && w.id !== id));
    for (const a of this.agents) if (a.workspaceId === id) a.archived = false;
    this.activeWorkspaceId = id;
    // The restored panes remount UNLAUNCHED (archiveWorkspace cleared their ids from
    // launchedAgentIds), so each shows the "Resume" placeholder instead of silently
    // resuming its Claude session.
    this.persist();
  }

  setActiveWorkspace(id: string) {
    this.activeWorkspaceId = id;
    if (!this.activeAgentByWs[id]) {
      this.activeAgentByWs[id] = this.tabsOf(id)[0]?.id ?? null;
    }
    // Keep the on-screen tab in sync with the active agent.
    const activeId = this.activeAgentByWs[id];
    const active = activeId ? this.agents.find((x) => x.id === activeId) : null;
    this.activeTabByWs[id] = active?.groupId ?? this.tabGroups(id)[0]?.groupId ?? null;
    // Switching into a workspace only reveals its active agent — it does NOT resume
    // the Claude session. The pane shows the "Resume" placeholder; the user must
    // click it to spawn the PTY and continue the conversation. A saved session is
    // never auto-continued.
    // The selection above is persisted state; without this save it only reached disk
    // if some later action happened to trigger one, so quitting lost it. persist() is
    // debounced (250ms), so a burst of clicks still costs a single write.
    this.persist();
  }

  reorderWorkspaces(draggedId: string, targetId: string) {
    const list = this.liveWorkspaces;
    const from = list.findIndex((w) => w.id === draggedId);
    const to = list.findIndex((w) => w.id === targetId);
    if (from === -1 || to === -1 || from === to) return;
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    list.forEach((w, i) => (w.order = i));
    this.persist();
  }

  /**
   * Move a workspace to an absolute slot among the other live workspaces (0-based,
   * measured with the dragged item removed). Idempotent — safe to call on every
   * pointer-move frame during a drag.
   */
  moveWorkspaceToIndex(draggedId: string, index: number) {
    const list = this.liveWorkspaces;
    const from = list.findIndex((w) => w.id === draggedId);
    if (from === -1) return;
    const [moved] = list.splice(from, 1);
    const at = Math.max(0, Math.min(index, list.length));
    list.splice(at, 0, moved);
    list.forEach((w, i) => (w.order = i));
    this.persist();
  }

  /**
   * The default name for a new agent: the highest existing "<Kind> N" number in
   * this workspace, plus one. Uses the max (not the count) so closing an agent in
   * the middle never causes a duplicate — e.g. with a lone "Claude 9" left, the
   * next Claude is "Claude 10", not "Claude 2".
   */
  private nextAgentName(workspaceId: string, kind: AgentKind): string {
    const label = KIND_LABELS[kind];
    const re = new RegExp(`^${label}\\s+(\\d+)$`);
    let max = 0;
    for (const a of this.agents) {
      if (a.workspaceId !== workspaceId) continue;
      const m = a.name.trim().match(re);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `${label} ${max + 1}`;
  }

  renameAgent(id: string, name: string) {
    const a = this.agents.find((x) => x.id === id);
    const next = name.trim();
    if (!a || !next || a.name === next) return;
    a.name = next;
    this.persist();
  }

  renameWorkspace(id: string, name: string) {
    const ws = this.workspaces.find((w) => w.id === id);
    const next = name.trim();
    if (!ws || !next || ws.name === next) return;
    ws.name = next;
    this.persist();
  }

  addAgent(input: {
    workspaceId: string;
    name?: string;
    kind: AgentKind;
    run: string | null;
    cwd?: string | null;
    initialPrompt?: string | null;
    /** Join an existing tab (split pane); defaults to a fresh singleton group. */
    groupId?: string;
  }): Agent {
    const siblings = this.agents.filter((a) => a.workspaceId === input.workspaceId);
    const id = uid("agent");
    const agent: Agent = {
      id,
      workspaceId: input.workspaceId,
      groupId: input.groupId ?? id,
      name: input.name?.trim() || this.nextAgentName(input.workspaceId, input.kind),
      kind: input.kind,
      run: input.run,
      cwd: input.cwd ?? null,
      lane: "backlog",
      taskId: null,
      // One past the highest existing sibling order — NOT `siblings.length`, which
      // collides with a surviving agent's order after any Close (removeAgent doesn't
      // re-sequence). Guarantees a unique slot at the end of the list.
      order: nextOrder(siblings),
      sessionId: input.kind === "claude" ? crypto.randomUUID() : null,
      sessionStarted: false,
      sessionCwd: null,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      initialPrompt: input.initialPrompt ?? null,
      archived: false,
      status: "idle",
      exitCode: null,
      state: "idle",
      stateChangedAt: Date.now(),
      acknowledged: true,
    };
    this.agents.push(agent);
    this.activeWorkspaceId = input.workspaceId;
    this.activeAgentByWs[input.workspaceId] = agent.id;
    // Focus the tab this agent lives in (its own group unless it joined a split).
    this.activeTabByWs[input.workspaceId] = agent.groupId;
    // A freshly created agent is one the user just opened — launch it now (so a
    // task-seeded prompt starts working immediately). Creation is always explicit.
    this.launchedAgentIds.add(agent.id);
    this.persist();
    return agent;
  }

  /** Cmd+T convenience: a Claude agent in the active workspace. */
  newClaudeInActive(): Agent | undefined {
    if (!this.activeWorkspaceId) return;
    return this.addAgent({
      workspaceId: this.activeWorkspaceId,
      kind: "claude",
      run: "claude",
    });
  }

  setActiveAgent(id: string) {
    const a = this.agents.find((x) => x.id === id);
    if (!a) return;
    a.lastUsedAt = Date.now();
    this.activeWorkspaceId = a.workspaceId;
    this.activeAgentByWs[a.workspaceId] = id;
    // Focusing a pane also selects the tab it lives in.
    this.activeTabByWs[a.workspaceId] = a.groupId;
    // Selecting an agent (tab / roster click, tab-index shortcut, open-from-page,
    // reopen, restore-from-history) only FOCUSES it — it does NOT resume the Claude
    // session. The pane shows the "Resume" placeholder until the user clicks it
    // (launchAgent), which is the sole path that spawns the PTY / resumes a saved
    // conversation. A brand-new agent still starts on creation (addAgent), since it
    // has no prior session to resume.
    // NOTE: merely selecting the tab does NOT clear a "done" badge — the agent keeps
    // showing "done" until the user actually clicks into its terminal (see
    // markReviewed). Blocked is never cleared this way.
    // `lastUsedAt` and the two selection maps are persisted fields, so save them —
    // otherwise the focused agent/tab only survived a quit by luck. persist() is
    // debounced (250ms), which is what makes it cheap enough for every click.
    this.persist();
  }

  /** Whether the user has explicitly opened this agent this run (see {@link launchedAgentIds}). */
  isLaunched(id: string): boolean {
    return this.launchedAgentIds.has(id);
  }

  /**
   * Explicitly launch an agent's process — used by the "resume" placeholder shown
   * when a restored/inactive agent is on screen but its Claude session hasn't been
   * started yet this run. Idempotent.
   */
  launchAgent(id: string) {
    // Reopening a slept agent cancels its pending sleep and refreshes recency so
    // the reaper doesn't immediately sleep it again.
    this.sleepingAgentIds.delete(id);
    const a = this.agents.find((x) => x.id === id);
    if (a) a.lastUsedAt = Date.now();
    this.launchedAgentIds.add(id);
  }

  /**
   * Put an idle, off-screen agent to sleep: kill its PTY to free system resources
   * while KEEPING its Claude session intact. Removing it from {@link launchedAgentIds}
   * makes its {@link import("$lib/components/TerminalPane.svelte")} tear the process
   * down; reopening the agent resumes the conversation via `claude --resume`.
   *
   * The roster {@link Agent.state}/{@link Agent.stateChangedAt} are deliberately left
   * untouched so the sidebar order is unchanged — a sleeping agent looks exactly like
   * it did, it just isn't holding a process. Only the transient run `status` drops
   * back to idle. Idempotent; a no-op for an agent that isn't launched.
   */
  sleepAgent(id: string) {
    if (!this.launchedAgentIds.has(id)) return;
    const a = this.agents.find((x) => x.id === id);
    if (!a) return;
    // Flag the imminent PTY exit as intentional (see markExited) BEFORE tearing down.
    this.sleepingAgentIds.add(id);
    this.launchedAgentIds.delete(id); // TerminalPane disposes the PTY in response
    a.status = "idle";
    this.activity.delete(id); // drop turn tracking
    this.screens.delete(id); // its terminal is going away — no ground truth to read
  }

  /**
   * The user interacted with an agent's terminal (clicked or typed into it) — a
   * finished (done) agent has now been looked at, so it drops back to idle.
   *
   * "Blocked" is deliberately NOT cleared here: it means a dialog is on screen right
   * now, which is true whether or not the user has glanced at the pane. It clears
   * itself within a tick of Claude erasing that dialog (answered, or dismissed with
   * esc) — see tickMonitor. Faking the clear on interaction is what used to need the
   * tail/spell wipe, and that wipe was itself the "state won't come back" bug.
   */
  markReviewed(id: string) {
    const a = this.agents.find((x) => x.id === id);
    if (!a) return;
    // Interacting with the terminal counts as using the agent → keep it clear of
    // the idle-reaper.
    a.lastUsedAt = Date.now();
    const rec = this.activity.get(id);
    if (rec) rec.reviewPending = false;
    if (a.state === "done") {
      a.acknowledged = true;
      a.state = "idle";
      a.stateChangedAt = Date.now();
      // These are persisted fields; without this a review made just before quitting
      // was lost and the agent came back wearing a stale "done" badge.
      this.persist();
    }
  }

  /** Switch to the nth (1-based) tab of the active workspace (Cmd+1..9). */
  activateTabIndex(n: number) {
    const g = this.activeTabGroups[n - 1];
    if (g) this.setActiveTab(g.groupId);
  }

  setAgentLane(id: string, lane: TaskStatus) {
    const a = this.agents.find((x) => x.id === id);
    if (!a) return;
    // `laneOrder` is a position WITHIN one lane, so it means nothing in the lane the
    // card is moving to — carried across, a once-dragged card lands at an arbitrary
    // slot among cards still sorting by `order`. Clearing it drops the card back to
    // the `order` fallback until the user drags it again.
    if (this.effectiveLane(a) !== lane) a.laneOrder = undefined;
    // Coming back from Done re-enters the tab list — give it a fresh end slot so its
    // stale `order` can't collide with a tab that took that slot while it was gone.
    if (this.effectiveLane(a) === "done" && lane !== "done") {
      const tabOrders = this.agents.filter(
        (x) => x.workspaceId === a.workspaceId && !x.archived && this.effectiveLane(x) !== "done",
      );
      a.order = nextOrder(tabOrders);
    }
    // If this agent is linked to a task, forward the change to the task instead.
    if (a.taskId) {
      this.updateTask(a.taskId, { status: lane });
      return;
    }
    // Otherwise, set the agent's own lane.
    const wasDone = a.lane === "done";
    a.lane = lane;
    // If it just went to Done and was active, pick another tab.
    if (lane === "done" && this.activeAgentByWs[a.workspaceId] === id) {
      this.activeAgentByWs[a.workspaceId] = this.tabsOf(a.workspaceId)[0]?.id ?? null;
    }
    if (lane === "done" && !wasDone) this.recordActivity("agent", a.id, a.name, "completed", a.workspaceId);
    this.persist();
  }

  restoreFromHistory(id: string) {
    this.setAgentLane(id, "in-progress");
    this.setActiveAgent(id);
  }

  removeAgent(id: string) {
    const a = this.agents.find((x) => x.id === id);
    if (!a) return;
    const ws = a.workspaceId;
    const groupId = a.groupId;
    const wasActive = this.activeAgentByWs[ws] === id;
    // Snapshot the WHOLE agent (and its tab's split tree, captured before the leaf is
    // pruned below) so ⌘⇧Z can put it back — the record itself is about to be deleted.
    this.lastClosed = { agent: { ...a }, layout: this.tabLayouts[groupId] ?? null };
    this.launchedAgentIds.delete(id);
    this.agents = this.agents.filter((x) => x.id !== id);
    // Intentionally leave dangling ids in task.agentIds[] (same soft-ref convention as ActivityEntry.refId);
    // taskAgents() filters live agents only, so this id is naturally dropped from current views.

    // Drop the closed pane from its tab's split tree (collapsing the split if it's
    // now single-child). If the tab is empty, forget its layout entirely.
    const tree = this.tabLayouts[groupId];
    if (tree) {
      const pruned = removeLeaf(tree, id);
      const next = { ...this.tabLayouts };
      if (pruned) next[groupId] = pruned;
      else delete next[groupId];
      this.tabLayouts = next;
    }

    if (wasActive) {
      // Prefer a sibling pane in the same tab; otherwise fall to another tab.
      const siblings = this.agentsInGroup(groupId);
      if (siblings.length) {
        this.activeAgentByWs[ws] = siblings[0].id;
        this.activeTabByWs[ws] = groupId;
      } else {
        const g = this.tabGroups(ws)[0];
        this.activeAgentByWs[ws] = g?.agents[0]?.id ?? null;
        this.activeTabByWs[ws] = g?.groupId ?? null;
      }
    }
    this.persist();
  }

  /**
   * Close a whole tab — every live pane in the group. Scoped to displayable agents
   * so a sibling that has moved to the Done lane (and now lives in History) is left
   * intact rather than being permanently deleted along with the tab.
   */
  closeTab(groupId: string) {
    const ids = this.agentsInGroup(groupId).map((a) => a.id);
    for (const id of ids) this.removeAgent(id);
  }

  /** Move every pane of a tab to a kanban lane — the tab moves as one unit. */
  setGroupLane(groupId: string, lane: TaskStatus) {
    for (const a of this.agentsInGroup(groupId)) this.setAgentLane(a.id, lane);
  }

  /**
   * Reorder a whole tab (group) to an absolute slot among the workspace's other
   * tabs. Rewrites member `order`s so each tab stays a contiguous block, keeping the
   * grouping stable across reloads. Idempotent — safe to call each drag frame.
   */
  moveTabToIndex(groupId: string, index: number) {
    const ws = this.agentsInGroup(groupId)[0]?.workspaceId;
    if (!ws) return;
    const groups = this.tabGroups(ws);
    const from = groups.findIndex((g) => g.groupId === groupId);
    if (from === -1) return;
    const [moved] = groups.splice(from, 1);
    const at = Math.max(0, Math.min(index, groups.length));
    groups.splice(at, 0, moved);
    let o = 0;
    for (const g of groups) for (const a of g.agents) a.order = o++;
    this.persist();
  }

  /**
   * Put the last closed agent back (⌘⇧Z), re-inserting the {@link ClosedAgent}
   * snapshot {@link removeAgent} took. One-shot: the snapshot is consumed, so a second
   * press does nothing.
   *
   * It comes back UNLAUNCHED — deliberately not added to {@link launchedAgentIds} —
   * so its pane shows the "Resume" placeholder and nothing resumes the conversation
   * until the user clicks it. Its live fields are re-derived the same way a restored
   * agent's are (see restoredState): nothing is running, so it cannot be mid-turn.
   *
   * {@link closeTab} closes each pane in turn, so after closing a whole tab this
   * restores just the LAST pane that was closed, not the entire tab — one undo step
   * per close, matching what the six one-click Close buttons each do.
   *
   * Refuses when the agent's workspace is gone or archived (there is nowhere visible
   * to put it back), dropping the snapshot rather than resurrecting a hidden agent.
   */
  reopenLastAgent(): Agent | null {
    const snap = this.lastClosed;
    if (!snap) return null;
    // Guards run BEFORE the snapshot is consumed: a refusal must not also destroy the
    // undo. The workspace can come back (unarchive) and the id clash can clear, so a
    // press that can't be honoured now is a no-op, not a one-way loss.
    const ws = this.workspaces.find((w) => w.id === snap.agent.workspaceId);
    if (!ws || ws.archived) return null;
    if (this.agents.some((x) => x.id === snap.agent.id)) return null;
    this.lastClosed = null;

    const agent: Agent = {
      ...snap.agent,
      archived: false,
      // A fresh end-of-list slot: its old `order` may have been taken by a tab that
      // moved up while it was gone (removeAgent doesn't re-sequence).
      order: nextOrder(this.agents.filter((x) => x.workspaceId === ws.id)),
      status: "idle",
      exitCode: null,
      state: restoredState(snap.agent.state),
      stateChangedAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    this.agents.push(agent);
    // Restore the tab's arrangement; layoutFor reconciles it against whatever panes
    // the group has now, so a tree that references departed siblings is harmless.
    if (snap.layout) this.tabLayouts = { ...this.tabLayouts, [agent.groupId]: snap.layout };
    this.setActiveAgent(agent.id); // focuses (never launches) and persists
    return agent;
  }

  reorderAgents(draggedId: string, targetId: string) {
    const dragged = this.agents.find((a) => a.id === draggedId);
    if (!dragged) return;
    const list = this.tabsOf(dragged.workspaceId);
    const from = list.findIndex((a) => a.id === draggedId);
    const to = list.findIndex((a) => a.id === targetId);
    if (from === -1 || to === -1 || from === to) return;
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    list.forEach((a, i) => (a.order = i));
    this.persist();
  }

  /**
   * Move an agent (tab) to an absolute slot among the other tabs of its workspace
   * (0-based, measured with the dragged item removed). Idempotent — safe to call
   * on every pointer-move frame during a drag.
   */
  moveAgentToIndex(draggedId: string, index: number) {
    const dragged = this.agents.find((a) => a.id === draggedId);
    if (!dragged) return;
    const list = this.tabsOf(dragged.workspaceId);
    const from = list.findIndex((a) => a.id === draggedId);
    if (from === -1) return;
    const [moved] = list.splice(from, 1);
    const at = Math.max(0, Math.min(index, list.length));
    list.splice(at, 0, moved);
    list.forEach((a, i) => (a.order = i));
    this.persist();
  }

  markExited(id: string, code: number | null) {
    // An agent we intentionally put to sleep fires this same exit event when its
    // PTY is killed. That's not a real termination — leave it dormant (idle) so it
    // shows the "Resume" placeholder, not the "exited" state, and can be reopened.
    // (If the user already reopened it, isLaunched is true again → don't touch it.)
    if (this.sleepingAgentIds.has(id)) {
      this.sleepingAgentIds.delete(id);
      const slept = this.agents.find((x) => x.id === id);
      if (slept && !this.launchedAgentIds.has(id) && slept.status !== "exited") {
        slept.status = "idle";
      }
      // sleepAgent already dropped the turn record, but a late PTY chunk arriving
      // between the kill and this exit event can recreate one via noteOutput. Drop it
      // again so the agent doesn't carry a stale half-turn into its next launch.
      this.activity.delete(id);
      return;
    }
    const a = this.agents.find((x) => x.id === id);
    if (a) {
      a.status = "exited";
      a.exitCode = code;
      a.state = "exited";
      a.stateChangedAt = Date.now();
    }
    this.activity.delete(id);
  }
  markRunning(id: string) {
    const a = this.agents.find((x) => x.id === id);
    if (a) a.status = "running";
  }

  // ---------- activity journal ----------

  /**
   * Record that an agent/task was worked on or completed today. Deduped to one
   * entry per (day, entity, action) — repeat activity just refreshes its time.
   */
  private recordActivity(
    entity: ActivityEntry["entity"],
    refId: string,
    name: string,
    action: ActivityEntry["action"],
    workspaceId: string | null,
  ) {
    const now = Date.now();
    const day = dayKey(now);
    const wsName = workspaceId
      ? (this.workspaces.find((w) => w.id === workspaceId)?.name ?? null)
      : null;
    const existing = this.activityLog.find(
      (e) => e.day === day && e.entity === entity && e.refId === refId && e.action === action,
    );
    if (existing) {
      existing.at = now;
      existing.name = name;
      if (wsName) existing.workspaceName = wsName;
    } else {
      this.activityLog.push({
        id: uid("act"),
        day,
        at: now,
        entity,
        refId,
        name,
        action,
        workspaceId,
        workspaceName: wsName,
      });
    }
    this.persist();
  }

  private recordAgentActivity(agentId: string, action: ActivityEntry["action"]) {
    const a = this.agents.find((x) => x.id === agentId);
    if (a) this.recordActivity("agent", a.id, a.name, action, a.workspaceId);
  }

  /** Entries for one calendar day, newest first. */
  activityOn(day: string): ActivityEntry[] {
    return this.activityLog.filter((e) => e.day === day).sort((a, b) => b.at - a.at);
  }

  /**
   * The journal grouped by calendar day, newest day first and newest entry first
   * within each day. Drives the day-by-day timeline in History.
   */
  get activityByDay(): { day: string; at: number; entries: ActivityEntry[] }[] {
    const groups = new Map<string, ActivityEntry[]>();
    for (const e of this.activityLog) {
      const list = groups.get(e.day);
      if (list) list.push(e);
      else groups.set(e.day, [e]);
    }
    return [...groups.entries()]
      .map(([day, entries]) => ({
        day,
        at: Math.max(...entries.map((e) => e.at)),
        entries: entries.slice().sort((a, b) => b.at - a.at),
      }))
      .sort((a, b) => b.day.localeCompare(a.day));
  }

  // ---------- tasks ----------

  /** Tasks shown on the board (everything not archived), for the given status. */
  boardTasks(status: TaskStatus): TaskItem[] {
    return this.tasks
      .filter((t) => t.status === status && !t.archived)
      .sort((a, b) => a.order - b.order || b.createdAt - a.createdAt);
  }
  /** Archived tasks (the Tasks archive on the History page), newest-first. */
  get taskHistory(): TaskItem[] {
    return this.tasks
      .filter((t) => t.archived)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  get openTaskCount(): number {
    // Count agents shown in Tasks page (non-archived workspaces, not linked to ideas)
    return this.agents.filter((agent) => {
      // Skip agents from archived workspaces
      if (agent.workspaceId) {
        const ws = this.workspaces.find((w) => w.id === agent.workspaceId);
        if (ws?.archived) return false;
      }
      // Skip agents linked to idea tasks (they belong in Notes page)
      if (agent.taskId) {
        const task = this.tasks.find((t) => t.id === agent.taskId);
        if (task?.status === "idea") return false;
      }
      return true;
    }).length;
  }

  // ---------- helper methods for agent↔task relationships ----------

  /** The effective kanban lane for an agent: task's status if linked, otherwise agent.lane. */
  effectiveLane(agent: Agent): TaskStatus {
    const item = agent.taskId ? this.tasks.find((t) => t.id === agent.taskId) : undefined;
    return item ? item.status : agent.lane;
  }

  /** All agents related to this item (spawned-to-work or attached-as-context), live only. */
  linkedAgents(item: TaskItem): Agent[] {
    return item.agentIds.map((id) => this.agents.find((a) => a.id === id)).filter(Boolean) as Agent[];
  }

  /** All agents that ever worked this item (including closed ones). Same as linkedAgents but keeps dangling ids. */
  taskAgents(item: TaskItem): Agent[] {
    return this.linkedAgents(item);
  }

  /**
   * The note (idea) an agent is related to, if any: linked directly via taskId, the
   * parent note of a forked task it works, or a note that lists it as context.
   */
  noteForAgent(agent: Agent): TaskItem | undefined {
    if (agent.taskId) {
      const t = this.tasks.find((x) => x.id === agent.taskId);
      if (t?.status === "idea") return t;
      if (t?.parentId) {
        const parent = this.tasks.find((p) => p.id === t.parentId);
        if (parent?.status === "idea") return parent;
      }
    }
    return this.tasks.find((t) => t.status === "idea" && t.agentIds.includes(agent.id));
  }

  /** The most-recently-spawned live agent for this item, for UI that only wants "the current one". */
  primaryAgent(item: TaskItem): Agent | undefined {
    const agents = this.linkedAgents(item);
    return agents.length > 0 ? agents[agents.length - 1] : undefined;
  }

  /** Child tasks forked from this item (via forkTask). */
  children(item: TaskItem): TaskItem[] {
    return this.tasks.filter((t) => t.parentId === item.id);
  }

  // ---------- helper getters for ideas ↔ tasks ----------

  /** Active ideas (status "idea", not archived), sorted by updatedAt desc. */
  get ideaList(): TaskItem[] {
    return this.tasks.filter((t) => t.status === "idea" && !t.archived).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Archived ideas (status "idea", archived), sorted by updatedAt desc. */
  get ideaArchive(): TaskItem[] {
    return this.tasks.filter((t) => t.status === "idea" && t.archived).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  addTask(input: {
    title: string;
    details?: string;
    status?: TaskStatus;
    attachments?: TaskAttachment[];
  }): TaskItem {
    const now = Date.now();
    const task: TaskItem = {
      id: uid("task"),
      title: input.title.trim() || "Untitled task",
      details: input.details?.trim() ?? "",
      status: input.status ?? "backlog",
      createdAt: now,
      updatedAt: now,
      order: this.tasks.length,
      attachments: input.attachments ?? [],
      archived: input.status === "done",
      workspaceId: null,
      agentIds: [],
      parentId: null,
    };
    this.tasks.push(task);
    this.persist();
    return task;
  }

  /**
   * Move a task ahead of `targetId` within (or into) `status` — powers kanban
   * drag-and-drop across and within columns.
   */
  /** Journal a task's status change (worked when it enters progress, completed at Done). */
  private recordTaskStatus(task: TaskItem, oldStatus: TaskStatus) {
    if (task.status === oldStatus) return;
    if (task.status === "done") {
      this.recordActivity("task", task.id, task.title, "completed", task.workspaceId);
      // If this task has a parent (was forked from an idea), check if all live siblings are now done.
      // If so, archive the parent idea too.
      if (task.parentId) {
        const parent = this.tasks.find((t) => t.id === task.parentId);
        if (parent) {
          const siblings = this.children(parent);
          const allDone = siblings.every((s) => s.status === "done" || s.archived);
          if (allDone && !parent.archived) {
            parent.archived = true;
          }
        }
      }
    } else if (task.status === "in-progress")
      this.recordActivity("task", task.id, task.title, "worked", task.workspaceId);
  }

  moveTask(draggedId: string, status: TaskStatus, targetId: string | null) {
    const dragged = this.tasks.find((t) => t.id === draggedId);
    if (!dragged) return;
    const was = dragged.status;
    dragged.status = status;
    // Completing a task archives it — off the board.
    if (status === "done") {
      dragged.archived = true;
    }
    this.recordTaskStatus(dragged, was);
    // Re-sequence the column so `order` reflects the visible arrangement.
    const column = this.tasks
      .filter((t) => t.status === status && !t.archived && t.id !== draggedId)
      .sort((a, b) => a.order - b.order);
    const at = targetId ? column.findIndex((t) => t.id === targetId) : column.length;
    column.splice(at === -1 ? column.length : at, 0, dragged);
    column.forEach((t, i) => (t.order = i));
    this.persist();
  }

  updateTask(
    id: string,
    patch: {
      title?: string;
      details?: string;
      status?: TaskStatus;
      attachments?: TaskAttachment[];
    },
  ) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    const was = t.status;
    if (patch.title !== undefined) t.title = patch.title.trim() || t.title;
    if (patch.details !== undefined) {
      t.details = patch.details.trim();
      t.updatedAt = Date.now();
    }
    if (patch.status !== undefined) {
      t.status = patch.status;
      // The task's card and every agent card linked to it change lane together, so
      // their within-lane positions lapse for the same reason as in setAgentLane.
      if (patch.status !== was) {
        for (const a of this.agents) if (a.taskId === id) a.laneOrder = undefined;
      }
    }
    if (patch.attachments !== undefined) t.attachments = patch.attachments;
    // Completing a task archives it — off the board.
    if (patch.status === "done") {
      t.archived = true;
    }
    if (patch.status !== undefined) this.recordTaskStatus(t, was);
    this.persist();
  }

  /** Move a (Done) task off the board into the archive. */
  archiveTask(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.archived = true;
    this.persist();
  }

  /** Bring an archived task back onto the board (keeps its status). */
  unarchiveTask(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.archived = false;
    this.persist();
  }

  removeTask(id: string) {
    this.tasks = this.tasks.filter((t) => t.id !== id);
    this.persist();
  }

  /**
   * Spawn a new Claude agent for an idea/task inside `workspaceId` and seed it
   * with the task text so it starts working immediately. Pushes the agent into
   * agentIds and sets agent.taskId to link them. Flips the item to In Progress
   * only if it was "backlog" (preserves status if already in-progress/testing).
   */
  createAgentForTask(itemId: string, workspaceId: string): Agent | undefined {
    const item = this.tasks.find((t) => t.id === itemId);
    if (!item) return;

    // For idea tasks, only allow one agent per note
    if (item.status === "idea") {
      const existingAgent = this.agents.find((a) => a.taskId === itemId);
      if (existingAgent) return existingAgent;
    }

    const agent = this.addAgent({
      workspaceId,
      kind: "claude",
      run: "claude",
      name: item.title,
      initialPrompt: buildTaskPrompt(item),
    });
    item.workspaceId = workspaceId;
    item.agentIds.push(agent.id);
    agent.taskId = itemId;
    // A backlog item with an agent is now active work → In Progress. Ideas are handled
    // by createAgentForNote (which forks a board task and leaves the note in place).
    if (item.status === "backlog") {
      item.status = "in-progress";
    }
    this.recordActivity("task", item.id, item.title, "worked", workspaceId);
    this.persist();
    return agent;
  }

  /**
   * Create an agent for a NOTE (idea): forks a board task from it (so the work shows
   * on the Tasks page) while the note itself stays in the Notes list. The agent is
   * linked to the note too, so the note shows "Open agent" and blocks re-creation.
   * Returns the existing agent if the note already has one.
   */
  createAgentForNote(noteId: string, workspaceId: string, overrides?: { title?: string; details?: string }): Agent | undefined {
    const note = this.tasks.find((t) => t.id === noteId);
    if (!note) return;
    const existing = note.agentIds.map((id) => this.agents.find((a) => a.id === id)).find(Boolean);
    if (existing) return existing;
    const task = this.forkTask(noteId, overrides);
    if (!task) return;
    const agent = this.createAgentForTask(task.id, workspaceId);
    if (agent && !note.agentIds.includes(agent.id)) {
      note.agentIds.push(agent.id);
      this.persist();
    }
    return agent;
  }

  /**
   * Fork a new sibling task from an idea/task. The new task has status "backlog"
   * and parentId pointing back to the source. The source remains unchanged.
   * Allows a single idea to spawn multiple independent child tasks.
   */
  forkTask(sourceId: string, overrides?: { title?: string; details?: string }): TaskItem | undefined {
    const source = this.tasks.find((t) => t.id === sourceId);
    if (!source) return;
    const newTask = this.addTask({
      title: overrides?.title ?? source.title,
      details: overrides?.details ?? source.details,
      status: "backlog",
    });
    newTask.parentId = sourceId;
    this.persist();
    return newTask;
  }

  /** Attach an existing idea/task to an agent as context (not as a worker). """  Idempotent. */
  attachAgent(itemId: string, agentId: string) {
    const item = this.tasks.find((t) => t.id === itemId);
    if (!item || item.agentIds.includes(agentId)) return;
    item.agentIds.push(agentId);
    this.persist();
  }

  /** Detach an idea/task from an agent. Idempotent. */
  detachAgent(itemId: string, agentId: string) {
    const item = this.tasks.find((t) => t.id === itemId);
    if (!item) return;
    item.agentIds = item.agentIds.filter((id) => id !== agentId);
    this.persist();
  }

  // ---------- activity monitor ----------
  //
  // Every 250ms each live Claude agent's AgentState is re-derived from what its
  // terminal is ACTUALLY DISPLAYING — xterm's own screen buffer, read through the
  // reader each mounted pane registers here and interpreted by readScreenSignal
  // (see $lib/terminal/claudeScreen, which documents the markers and the real frames
  // they were verified against). Claude draws those markers and Claude erases them, so
  // the state follows the real turn and self-heals: nothing can stay pinned to a phrase
  // that has left the screen. That is the whole point of reading the screen instead of
  // accumulating the byte stream, which is what used to leave agents stuck "working" or
  // "blocked" and replay chimes on every redraw.
  //
  // Relaunching (`claude`), quitting (`exit`), resuming a session or any other
  // terminal noise draws no status line, so it never counts as a turn and never fires
  // a sound. Non-Claude agents have no turn lifecycle at all.

  /**
   * Per-agent activity — intentionally OUTSIDE $state to avoid reactivity churn. The turn
   * fields are {@link TurnMemo}, owned by the stepTurn reducer; the two frame counters are
   * the monitor's own read gate:
   *   frame     — counts screen updates; bumped once per PARSED chunk of output
   *   readFrame — the `frame` the last screen reading was taken at
   */
  private activity = new Map<string, TurnMemo & { frame: number; readFrame: number }>();
  /** Live screen readers, one per mounted terminal. Also outside $state. */
  private screens = new Map<string, (maxRows?: number) => string>();
  private monitorTimer: ReturnType<typeof setInterval> | null = null;

  private rec(id: string) {
    let r = this.activity.get(id);
    if (!r) {
      r = {
        ...freshTurnMemo(),
        frame: 0,
        readFrame: -1, // never read → the first tick always looks
      };
      this.activity.set(id, r);
    }
    return r;
  }

  /**
   * A mounted terminal offers up its live screen. Until an agent is registered here it
   * has no ground truth, and the monitor leaves its state (and roster position) alone
   * rather than guessing — which is what keeps a dormant or slept agent looking exactly
   * as the user left it.
   */
  registerScreen(id: string, read: (maxRows?: number) => string) {
    this.screens.set(id, read);
    this.ensureMonitor();
  }

  /** The terminal is going away (pane closed, agent slept). */
  unregisterScreen(id: string) {
    this.screens.delete(id);
  }

  /**
   * Called once per chunk of PTY output, AFTER xterm has parsed it into the buffer (see
   * createTerminal's write callback). So this means "the screen changed": it marks the
   * agent as worth reading again, and nothing else — the screen itself is the state.
   */
  noteOutput(id: string) {
    this.rec(id).frame++;
    this.ensureMonitor();
  }

  /**
   * Called with each keystroke the user sends to a PTY. Keystrokes echo back as output
   * anyway; this only guarantees the monitor is running, since "working" comes from
   * Claude's status line and never from typing `claude`/`exit`/etc.
   */
  noteInput(id: string, _data: string) {
    void _data;
    this.ensureMonitor();
  }

  /** Mark the start of a user turn; bumps lastUsedAt so the agent stays sorted near the top. */
  beginTurn(id: string) {
    const a = this.agents.find((x) => x.id === id);
    if (a) a.lastUsedAt = Date.now();
  }

  private ensureMonitor() {
    if (this.monitorTimer || typeof window === "undefined") return;
    this.monitorTimer = setInterval(() => this.tickMonitor(), MONITOR_TICK_MS);
  }

  private reaperTimer: ReturnType<typeof setInterval> | null = null;

  /** Start the idle-reaper (once). Called from load() so it runs the whole session. */
  ensureReaper() {
    if (this.reaperTimer || typeof window === "undefined") return;
    this.reaperTimer = setInterval(() => this.reapIdleAgents(), REAP_TICK_MS);
  }

  /**
   * Sleep every launched agent that has gone unused for over an hour and isn't the
   * one currently on screen — reclaiming its Claude process while preserving the
   * session (see {@link sleepAgent}). This is what stops idle agents from holding
   * system resources; the user reopening any of them resumes it losslessly.
   *
   * Deliberately conservative about WHICH agents qualify:
   *   - the on-screen (active) agent is never slept — the user has it open;
   *   - only Claude agents, whose sessions resume via `--resume` (a shell's live
   *     process state would be lost, so those are left running);
   *   - only quiescent agents (idle/done) — never one mid-turn (working) or waiting
   *     on the user (blocked), which killing would interrupt.
   */
  private reapIdleAgents() {
    const now = Date.now();
    // Agents currently on screen = every visible pane of the active tab (all of a
    // split grid, not just the focused one) — never sleep any of them.
    const onScreen = new Set(this.visibleAgentIds);
    for (const a of this.agents) {
      if (onScreen.has(a.id)) continue; // never sleep what the user has open
      if (!this.launchedAgentIds.has(a.id)) continue; // no live PTY to reclaim
      if (a.kind !== "claude") continue; // only Claude sessions resume losslessly
      if (a.state !== "idle" && a.state !== "done") continue; // don't interrupt work
      if (now - a.lastUsedAt < IDLE_SLEEP_MS) continue; // used recently enough
      this.sleepAgent(a.id);
    }
  }

  /** Commit a derived state, keeping the roster's recency key and disk in sync. */
  private commitState(a: Agent, next: AgentState, now: number) {
    if (a.state === next) return;
    a.state = next;
    a.stateChangedAt = now; // recency key for the sidebar's within-group sort
    this.persist();
  }

  private tickMonitor() {
    const now = Date.now();
    for (const a of this.agents) {
      if (a.archived) continue; // archived-with-workspace agents are inert

      // Only Claude agents have a working/blocked/done turn lifecycle. Shell and
      // custom agents (and any raw terminal noise) never drive status or sounds.
      if (a.kind !== "claude") {
        if (a.status === "exited") this.commitState(a, "exited", now);
        else if (this.screens.has(a.id)) this.commitState(a, "idle", now);
        continue;
      }

      if (a.status === "exited") {
        const rec = this.activity.get(a.id);
        if (rec) {
          rec.spell = false;
          rec.reviewPending = false;
          rec.alertedBlocked = false;
        }
        this.commitState(a, "exited", now);
        continue;
      }

      // No mounted terminal ⇒ no ground truth. Leave the agent exactly as it is: a
      // dormant (never opened this run) or slept agent must never be re-derived from
      // guesswork, or reopening the app would shuffle the roster.
      const read = this.screens.get(a.id);
      if (!read) continue;

      const rec = this.rec(a.id);
      // Read only when there is something to read: the screen has changed since the last
      // reading, or a reading is still waiting to settle. Deliberately NOT "output
      // arrived in the last N seconds" — a hidden or minimised window has its timers
      // throttled hard by the webview, and a tick that lands after such a window closed
      // would skip the frame where the turn ended and lose the chime for good. Keyed on
      // a change counter, a late tick still reads the very frame it missed.
      if (rec.frame === rec.readFrame && !rec.pending) continue;
      rec.readFrame = rec.frame;

      let raw: ScreenSignal;
      try {
        // The WHOLE visible screen, not just its last rows: Claude's status line and
        // input box are bottom-anchored, but a permission dialog is drawn right after
        // the transcript and can sit high up a tall pane with blank rows beneath it.
        raw = readScreenSignal(read());
      } catch {
        continue; // terminal disposed mid-tick
      }

      // The turn state machine and its one-chime-per-event rules live in stepTurn, which
      // is a pure reducer over `rec` precisely so those rules can be tested directly.
      const step = stepTurn(rec, raw, now);
      if (step.turnStarted) {
        a.acknowledged = false;
        a.lastUsedAt = now;
        this.recordActivity("agent", a.id, a.name, "worked", a.workspaceId);
      }
      if (step.chime === "blocked") playBlocked();
      else if (step.chime === "done") playDone();
      if (step.state) this.commitState(a, step.state, now);
    }
  }

  /**
   * The command to type into the shell when (re)spawning this agent.
   * For Claude: first launch creates a session with a known id; later launches resume it,
   * so reopening the app brings the previous conversation back.
   */
  effectiveRun(agent: Agent): string | null {
    if (agent.kind === "claude") {
      if (agent.sessionId) {
        const id = agent.sessionId;
        // On the very first launch, seed the task prompt as claude's opening message.
        const seed =
          !agent.sessionStarted && agent.initialPrompt
            ? " " + shellQuote(agent.initialPrompt)
            : "";
        // Self-correcting: each agent binds to its OWN session id.
        //  - `--resume <id>` exits 1 if that session doesn't exist yet,
        //  - `--session-id <id>` errors if it already exists.
        // Chaining with `||` picks the right one automatically. We order by the
        // likely case (sessionStarted) just to avoid an error flash on the common path.
        return agent.sessionStarted
          ? `claude --resume ${id} || claude --session-id ${id}`
          : `claude --session-id ${id}${seed} || claude --resume ${id}${seed}`;
      }
      return "claude";
    }
    return agent.run;
  }

  /**
   * Called once a Claude agent's terminal has launched, so future opens resume it.
   * Captures the exact directory the session was created in so every later resume
   * runs there (see {@link cwdOf}) — otherwise `claude --resume` (which is cwd-scoped)
   * would find nothing and spawn an empty session.
   */
  markSessionStarted(id: string, cwd: string | null) {
    const a = this.agents.find((x) => x.id === id);
    if (!a || a.kind !== "claude") return;
    let changed = false;
    if (!a.sessionStarted) {
      a.sessionStarted = true;
      changed = true;
    }
    // Pin the session's directory the first time we have one — including for agents
    // started before this field existed, so they're protected from future cwd drift.
    // (An already-drifted legacy agent's session is under its old path and can't be
    // recovered regardless; pinning the current path never makes that worse.)
    if (!a.sessionCwd && cwd?.trim()) {
      a.sessionCwd = cwd;
      changed = true;
    }
    if (changed) this.persist();
  }

  // ---------- settings ----------

  addDefaultProject(path: string) {
    const trimmed = path.trim();
    if (trimmed && !this.defaultProjects.includes(trimmed)) {
      this.defaultProjects.push(trimmed);
      this.persist();
    }
  }

  removeDefaultProject(path: string) {
    const idx = this.defaultProjects.indexOf(path);
    if (idx !== -1) {
      this.defaultProjects.splice(idx, 1);
      this.persist();
    }
  }

  // ---------- layout ----------

  /** Clamp + persist the sidebar rail width. */
  setSidebarWidth(px: number) {
    this.sidebarWidth = Math.max(180, Math.min(560, Math.round(px)));
    this.persist();
  }

  /** Expanded ⇄ collapsed for one workspace's agent children in the sidebar tree. */
  toggleWorkspaceCollapsed(id: string) {
    this.wsCollapsed[id] = !this.wsCollapsed[id];
    this.persist();
  }
  /** Force one workspace's agent children open (used when its row is selected). */
  expandWorkspace(id: string) {
    if (!this.wsCollapsed[id]) return;
    this.wsCollapsed[id] = false;
    this.persist();
  }
  /**
   * Fold / unfold the whole tree in one write — a per-workspace loop would persist
   * once per row.
   */
  setAllWorkspacesCollapsed(collapsed: boolean) {
    const next: Record<string, boolean> = {};
    if (collapsed) for (const w of this.liveWorkspaces) next[w.id] = true;
    this.wsCollapsed = next;
    this.persist();
  }

  /** Clamp + persist the Notes page's note-list pane width. */
  setNotesListWidth(px: number) {
    this.notesListWidth = Math.max(200, Math.min(560, Math.round(px)));
    this.persist();
  }

  // ---------- shortcuts ----------

  updateShortcut(id: string, updates: Partial<Omit<Shortcut, "id">>) {
    const shortcut = this.shortcuts.find((s) => s.id === id);
    if (!shortcut) return;
    Object.assign(shortcut, updates);
    this.persist();
  }

  resetShortcutsToDefault() {
    this.shortcuts = this.getDefaultShortcuts();
    this.persist();
  }

  getShortcutsByContext(context: Shortcut["context"]): Shortcut[] {
    return this.shortcuts.filter((s) => s.context === context || s.context === "global");
  }

  setPageView(page: string, view: string) {
    this.pageViews[page] = view;
    this.persist();
  }

  getPageView(page: string): string {
    return this.pageViews[page] || "default";
  }

  /** Per-note editor mode. */
  getNotePreview(id: string): boolean {
    return !!this.notePreview[id];
  }
  setNotePreview(id: string, preview: boolean) {
    if (preview) this.notePreview[id] = true;
    else delete this.notePreview[id];
    this.persist();
  }

  setLastNote(id: string | null) {
    if (this.lastNoteId === id) return;
    this.lastNoteId = id;
    this.persist();
  }

  // ---------- persistence ----------

  /**
   * {@link tabLayouts} with orphaned entries dropped — groups no agent belongs to any
   * more. Layouts are otherwise only deleted when {@link removeAgent} empties a group,
   * so tabs emptied via the Done lane and groups of long-gone agents accumulated
   * forever; layoutFor already ignores them at render time, so this is pure cleanup.
   * Deliberately keyed on ALL agents (archived and done included) so an archived
   * workspace's split arrangement still survives until its agents really go away.
   */
  private liveTabLayouts(): Record<string, LayoutNode> {
    const groups = new Set(this.agents.map((a) => a.groupId));
    const out: Record<string, LayoutNode> = {};
    for (const [groupId, tree] of Object.entries(this.tabLayouts)) {
      if (groups.has(groupId)) out[groupId] = tree;
    }
    return out;
  }

  private snapshot() {
    return {
      version: 1,
      workspaces: this.workspaces,
      agents: this.agents.map((a) => ({
        id: a.id,
        workspaceId: a.workspaceId,
        groupId: a.groupId,
        name: a.name,
        kind: a.kind,
        run: a.run,
        cwd: a.cwd,
        lane: a.lane,
        taskId: a.taskId,
        order: a.order,
        laneOrder: a.laneOrder,
        sessionId: a.sessionId,
        sessionStarted: a.sessionStarted,
        sessionCwd: a.sessionCwd,
        createdAt: a.createdAt,
        lastUsedAt: a.lastUsedAt,
        initialPrompt: a.initialPrompt,
        archived: a.archived,
        // Persist the roster-ordering keys so reopening restores the exact order
        // (blocked→done→working→idle, most-recent-first). See rosterOf / STATE_RANK.
        state: a.state,
        stateChangedAt: a.stateChangedAt,
        acknowledged: a.acknowledged,
      })),
      tasks: this.tasks,
      activityLog: this.activityLog,
      activeWorkspaceId: this.activeWorkspaceId,
      activeAgentByWs: this.activeAgentByWs,
      activeTabByWs: this.activeTabByWs,
      tabLayouts: this.liveTabLayouts(),
      defaultProjects: this.defaultProjects,
      terminalScrollPos: this.terminalScrollPos,
      shortcuts: this.shortcuts,
      pageViews: this.pageViews,
      notePreview: this.notePreview,
      lastNoteId: this.lastNoteId,
      lastClosed: this.lastClosed,
      sidebarWidth: this.sidebarWidth,
      wsCollapsed: this.wsCollapsed,
      notesListWidth: this.notesListWidth,
      codeOpenByWs: this.codeOpenByWs,
      codeSideTab: this.codeSideTab,
      codeTreeWidth: this.codeTreeWidth,
      codeRunHeight: this.codeRunHeight,
      codeShowHidden: this.codeShowHidden,
      codeDiffSplit: this.codeDiffSplit,
      codeViewedByWs: this.codeViewedByWs,
    };
  }

  persist() {
    if (!this.loaded) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      invoke("save_state", { state: this.snapshot() }).catch((e) =>
        console.error("[Codesu] save_state failed", e),
      );
    }, 250);
  }

  /**
   * Write any pending (debounced) state to disk right now and await it. Called when
   * the window is closing so a reorder made in the last 250ms — the debounce window —
   * is never lost; without this, quitting quickly after a drag would drop it and the
   * app would reopen in the pre-drag positions.
   */
  async flush(): Promise<void> {
    if (!this.loaded) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      await invoke("save_state", { state: this.snapshot() });
    } catch (e) {
      console.error("[Codesu] flush save_state failed", e);
    }
  }

  async load() {
    try {
      const data = await invoke<any>("load_state");
      if (data && Array.isArray(data.workspaces)) {
        this.workspaces = data.workspaces;
        const archivedWs = new Set(
          this.workspaces.filter((w) => w.archived).map((w) => w.id),
        );
        this.agents = (data.agents ?? []).map((a: any) => {
          const { task: legacyTask, ...rest } = a;
          return {
            ...rest,
            // Legacy agents predate tabs → each becomes its own singleton tab.
            groupId: a.groupId ?? a.id,
            // Keep agents in lock-step with their workspace's archived state.
            archived: (a.archived ?? false) || archivedWs.has(a.workspaceId),
            // Migrate: task -> lane, add taskId
            lane: a.lane ?? legacyTask ?? "backlog",
            taskId: a.taskId ?? null,
            // The Tasks board's own ordering key. Absent for agents never dragged on
            // the board (and for every pre-existing state file) — those keep sorting
            // by `order`, so the board looks exactly as it did. See Agent.laneOrder.
            laneOrder: typeof a.laneOrder === "number" ? a.laneOrder : undefined,
            // Migrate: give every Claude agent a tracked session id so it resumes by id.
            // Legacy agents (no id) start a fresh tracked session going forward.
            sessionId: a.sessionId ?? (a.kind === "claude" ? crypto.randomUUID() : null),
            sessionStarted: a.sessionId ? (a.sessionStarted ?? false) : false,
            // The directory the session was created in, so resume runs there (cwd-scoped).
            sessionCwd: a.sessionCwd ?? null,
            createdAt: a.createdAt ?? Date.now(),
            lastUsedAt: a.lastUsedAt ?? a.createdAt ?? Date.now(),
            initialPrompt: a.initialPrompt ?? null,
            status: "idle" as RunStatus,
            exitCode: null,
            // Restore the roster-ordering state so the agents reappear in the order
            // they were left (blocked→done→…, most-recent-first). Nothing is running
            // yet, so a state that asserts live activity is dropped — see
            // restoredState. The monitor re-derives the truth from the agent's real
            // screen as soon as it is opened. Legacy rows (no saved state) fall back to
            // idle, keyed by lastUsedAt so their recency ordering is still sensible.
            state: restoredState(a.state),
            stateChangedAt: a.stateChangedAt ?? a.lastUsedAt ?? a.createdAt ?? Date.now(),
            acknowledged: a.acknowledged ?? true,
          };
        });
        // Migrate: tasks with agentId -> agentIds, add updatedAt, add parentId
        const migratedTasks = Array.isArray(data.tasks)
          ? data.tasks.map((t: any, i: number) => ({
              id: t.id,
              title: t.title ?? "Untitled task",
              details: t.details ?? "",
              // Legacy "open" tasks map onto the new Backlog column.
              status: ((t.status === "open" ? "backlog" : t.status) ?? "backlog") as TaskStatus,
              createdAt: t.createdAt ?? Date.now(),
              updatedAt: t.updatedAt ?? t.createdAt ?? Date.now(),
              order: t.order ?? i,
              attachments: Array.isArray(t.attachments) ? t.attachments : [],
              archived: !!t.archived,
              workspaceId: t.workspaceId ?? null,
              agentIds: Array.isArray(t.agentIds) ? t.agentIds : t.agentId ? [t.agentId] : [],
              parentId: t.parentId ?? null,
            }))
          : [];

        // Migrate: notes -> idea-status tasks; a note's old taskId becomes the child task's parentId
        const migratedIdeas = Array.isArray(data.notes)
          ? data.notes.map((n: any) => ({
              id: n.id,
              title: n.title ?? "",
              details: n.body ?? "",
              status: "idea" as TaskStatus,
              createdAt: n.createdAt ?? Date.now(),
              updatedAt: n.updatedAt ?? n.createdAt ?? Date.now(),
              order: 0,
              attachments: [] as TaskAttachment[],
              archived: !!n.archived,
              workspaceId: null,
              agentIds: [] as string[],
              parentId: null,
            }))
          : [];

        // Link ideas to their child tasks (via parentId)
        for (const n of data.notes ?? []) {
          if (n.taskId) {
            const child = migratedTasks.find((t: any) => t.id === n.taskId);
            if (child) child.parentId = n.id;
          }
        }

        this.tasks = [...migratedIdeas, ...migratedTasks];
        // Backfill agent.taskId reverse pointer + self-heal any pre-existing lane/status desync
        for (const t of this.tasks) {
          for (const aid of t.agentIds) {
            const a = this.agents.find((x: any) => x.id === aid);
            if (a) {
              a.taskId = t.id;
              a.lane = t.status;
            }
          }
        }

        // Activity journal, pruned to the retention window so it can't grow forever.
        const cutoff = Date.now() - ACTIVITY_RETENTION_DAYS * 86_400_000;
        this.activityLog = Array.isArray(data.activityLog)
          ? data.activityLog
              .filter((e: any) => e && typeof e.day === "string" && (e.at ?? 0) >= cutoff)
              .map((e: any) => ({
                id: e.id ?? uid("act"),
                day: e.day,
                at: e.at ?? Date.now(),
                entity: e.entity === "task" ? "task" : "agent",
                refId: e.refId ?? "",
                name: e.name ?? "(unknown)",
                action: e.action === "completed" ? "completed" : "worked",
                workspaceId: e.workspaceId ?? null,
                workspaceName: e.workspaceName ?? null,
              }))
          : [];
        this.activeWorkspaceId =
          data.activeWorkspaceId ?? this.liveWorkspaces[0]?.id ?? null;
        this.activeAgentByWs = data.activeAgentByWs ?? {};
        this.activeTabByWs = data.activeTabByWs ?? {};
        // Restore per-tab split layouts, dropping any that reference an agent that
        // no longer exists (self-healed further by layoutFor at render time).
        this.tabLayouts =
          data.tabLayouts && typeof data.tabLayouts === "object" ? data.tabLayouts : {};
        this.defaultProjects = Array.isArray(data.defaultProjects) ? data.defaultProjects : [];
        this.terminalScrollPos = typeof data.terminalScrollPos === "number" ? data.terminalScrollPos : 0;
        // Load shortcuts with merge of defaults to catch new/updated shortcuts
        const defaults = this.getDefaultShortcuts();
        if (Array.isArray(data.shortcuts) && data.shortcuts.length > 0) {
          const savedMap = new Map((data.shortcuts as Shortcut[]).map(s => [s.id, s]));
          this.shortcuts = defaults.map(d => savedMap.get(d.id) || d);
          // One-off migration: "Close Current Agent" shipped bound to "Delete", which
          // the Mac delete key never reports (it sends "Backspace"), so the advertised
          // ⌘⌫ could not fire. Saved copies of that dead binding are moved onto the
          // working key; anything the user rebound themselves is left alone.
          const closeAgent = this.shortcuts.find((s) => s.id === "close-current-agent");
          if (closeAgent && closeAgent.key === "Delete") closeAgent.key = "Backspace";
        } else {
          this.shortcuts = defaults;
        }
        // Load page views
        if (typeof data.pageViews === "object" && data.pageViews) {
          this.pageViews = { ...this.pageViews, ...data.pageViews };
        }
        // Load per-note editor modes
        if (typeof data.notePreview === "object" && data.notePreview) {
          this.notePreview = { ...data.notePreview };
        }
        // Load last-open note
        this.lastNoteId = typeof data.lastNoteId === "string" ? data.lastNoteId : null;
        // Load the last closed agent so ⌘⇧Z still works after a restart. Older state
        // files stored only `lastClosedAgentId`, which pointed at a deleted record and
        // could never be reopened — those are simply dropped.
        this.lastClosed =
          data.lastClosed && typeof data.lastClosed === "object" && data.lastClosed.agent
            ? {
                agent: data.lastClosed.agent as Agent,
                layout: (data.lastClosed.layout as LayoutNode | null) ?? null,
              }
            : null;
        // Load persisted layout sizes (with sane clamps).
        if (typeof data.sidebarWidth === "number")
          this.sidebarWidth = Math.max(180, Math.min(560, data.sidebarWidth));
        if (data.wsCollapsed && typeof data.wsCollapsed === "object")
          this.wsCollapsed = { ...data.wsCollapsed };
        if (typeof data.notesListWidth === "number")
          this.notesListWidth = Math.max(200, Math.min(560, data.notesListWidth));
        // Code view: only the open-file PATHS are restored — each buffer is re-read from
        // disk when its tab is shown, so a file rewritten while the app was closed is
        // never presented as the version the user last saw.
        if (data.codeOpenByWs && typeof data.codeOpenByWs === "object") {
          const restored: Record<string, { paths: string[]; active: string | null }> = {};
          for (const [wsId, slot] of Object.entries<any>(data.codeOpenByWs)) {
            const paths = Array.isArray(slot?.paths)
              ? slot.paths.filter((p: unknown) => typeof p === "string")
              : [];
            const active =
              typeof slot?.active === "string" && paths.includes(slot.active)
                ? slot.active
                : (paths[0] ?? null);
            restored[wsId] = { paths, active };
          }
          this.codeOpenByWs = restored;
        }
        if (data.codeSideTab === "files" || data.codeSideTab === "changes")
          this.codeSideTab = data.codeSideTab;
        if (typeof data.codeTreeWidth === "number")
          this.codeTreeWidth = Math.max(160, Math.min(560, data.codeTreeWidth));
        if (typeof data.codeRunHeight === "number")
          this.codeRunHeight = Math.max(0, Math.min(900, data.codeRunHeight));
        if (typeof data.codeShowHidden === "boolean") this.codeShowHidden = data.codeShowHidden;
        if (typeof data.codeDiffSplit === "boolean") this.codeDiffSplit = data.codeDiffSplit;
        if (data.codeViewedByWs && typeof data.codeViewedByWs === "object") {
          const viewed: Record<string, Record<string, string>> = {};
          for (const [wsId, slot] of Object.entries<any>(data.codeViewedByWs)) {
            if (!slot || typeof slot !== "object") continue;
            viewed[wsId] = Object.fromEntries(
              Object.entries(slot).filter(([, sig]) => typeof sig === "string"),
            ) as Record<string, string>;
          }
          this.codeViewedByWs = viewed;
        }
        // Heal legacy `order` values: past releases could leave duplicates or gaps
        // (a new agent reused a removed sibling's slot), which made the tab and
        // workspace ordering shuffle on every reopen. Re-sequence to a dense, unique
        // range that preserves the current arrangement so it stays put from now on.
        normalizeOrder(this.workspaces, (a, b) => a.id.localeCompare(b.id));
        const agentsByWs = new Map<string, Agent[]>();
        for (const a of this.agents) {
          const list = agentsByWs.get(a.workspaceId) ?? [];
          list.push(a);
          agentsByWs.set(a.workspaceId, list);
        }
        for (const list of agentsByWs.values()) {
          normalizeOrder(list, (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
        }

        // Ensure every workspace has a valid active agent and on-screen tab.
        for (const w of this.workspaces) {
          if (!this.activeAgentByWs[w.id]) {
            this.activeAgentByWs[w.id] = this.tabsOf(w.id)[0]?.id ?? null;
          }
          const focusId = this.activeAgentByWs[w.id];
          const focus = focusId ? this.agents.find((a) => a.id === focusId) : null;
          if (!this.activeTabByWs[w.id]) {
            this.activeTabByWs[w.id] = focus?.groupId ?? this.tabGroups(w.id)[0]?.groupId ?? null;
          }
        }
      }
    } catch (e) {
      console.error("[Codesu] load_state failed", e);
    } finally {
      this.loaded = true;
    }
    // Begin reclaiming idle agents' processes (their sessions are preserved).
    this.ensureReaper();
    // Flag workspaces whose folder has disappeared, so the sidebar says so instead of
    // the user finding out when an agent refuses to start. Non-blocking.
    void this.checkWorkspacePaths();
    // Each Claude agent owns an isolated Claude config dir (that's what keeps its typed
    // prompts out of its siblings' ↑ history — see TerminalPane.resolveEnv). Closing an
    // agent leaves its directory behind, so the ones with no agent left are dropped here,
    // once per launch. Purely housekeeping: failures are ignored.
    //
    // Skipped when nothing loaded: an empty agent list also means "state.json was missing
    // or unreadable", and pruning against that would throw away the prompt history of
    // every agent the user still has. Homes of long-dead agents simply wait for a launch
    // that did load.
    if (this.agents.length) {
      void invoke("prune_claude_homes", {
        liveAgentIds: this.agents.map((a) => a.id),
      }).catch(() => {});
    }
    // Save any migration (newly-assigned session ids) back to disk.
    this.persist();
  }
}

export const app = new AppState();
