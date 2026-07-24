import { invoke } from "@tauri-apps/api/core";
import { SvelteSet } from "svelte/reactivity";
import { playDone, playBlocked } from "$lib/sound";

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
  context: "global" | "agents" | "tasks" | "notes" | "report" | "history" | "settings" | "terminal";
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

/** Sort weight: blocked & done float to the top so they're impossible to miss. */
export const STATE_ORDER: Record<AgentState, number> = {
  blocked: 0,
  done: 1,
  working: 2,
  idle: 3,
  exited: 4,
};

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

export const STATE_META: Record<AgentState, { label: string; color: string }> = {
  working: { label: "Working", color: "#6e8bff" },
  blocked: { label: "Blocked", color: "#ff5f57" },
  done: { label: "Done", color: "#3fb950" },
  idle: { label: "Idle", color: "#8b98a9" },
  exited: { label: "Exited", color: "#6b7789" },
};

/**
 * Heuristics for reading Claude Code's TUI out of the raw (ANSI-stripped) output
 * tail. Kept as plain arrays so they're trivial to tune as the CLI evolves.
 */
// A quiet terminal whose tail matches any of these means Claude wants an answer.
const BLOCKED_MARKERS = [
  /Do you want to/i,
  /Would you like/i,
  /❯\s*1\.\s/, // selection menu cursor on the first option
  /\bYes, and\b/i,
  /No, and tell Claude/i,
  /\(y\/n\)/i,
  /Press\s+.*\bto (confirm|continue|select)/i,
];
/**
 * Claude's live "working" status line. While a turn is settling we treat the agent
 * as still working for as long as this is the MOST RECENT thing drawn — so a short
 * thinking pause never fires "done" early. The instant Claude replaces it with the
 * result / input box, the turn is recognised as finished.
 */
const SPINNER_MARKERS = [/esc to interrupt/i];
// Only the freshest slice is checked, so a stale spinner line can't pin "working".
// Kept small: the spinner is always the last line WHILE working, but as soon as the
// turn ends Claude draws its input box, pushing the phrase out of this window fast.
const SPINNER_WINDOW = 160;
/**
 * A live spinner reprints its line at least once a second (the elapsed-time
 * counter ticks). So if no output has arrived for this long, any "esc to interrupt"
 * still sitting in the tail is STALE — the turn really finished. Without this gate a
 * lingering spinner phrase can pin an agent as "working" forever after it's done.
 */
const SPINNER_STALE_MS = 2000;
/**
 * Silence this long ⇒ a turn is settling. Kept short so the "done" chime/animation
 * fire promptly; the SPINNER_MARKERS keep-alive guards against firing mid-thought.
 */
const WORKING_QUIET_MS = 600;
/** How often the activity monitor re-derives every agent's state. */
const MONITOR_TICK_MS = 200;
/** Bytes of stripped tail we retain per agent for prompt detection. */
const TAIL_CAP = 3000;

// CSI / OSC / single-escape sequences, plus stray control bytes.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "").replace(CTRL_RE, "");
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
  name: string;
  kind: AgentKind;
  /** Program auto-run in the shell (null => plain shell). */
  run: string | null;
  /** Working dir (null => workspace path). */
  cwd: string | null;
  lane: TaskStatus; // agent's own kanban lane when not dedicated to a task (default "backlog")
  taskId: string | null; // which item (if any) this agent is currently dedicated to
  order: number;
  /** Stable Claude Code session id (uuid) so the conversation can be resumed. */
  sessionId: string | null;
  /** Whether this Claude session has been launched at least once (=> resume, not create). */
  sessionStarted: boolean;
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

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.floor(performance.now())}`;
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
  /** Per-workspace active agent id. */
  activeAgentByWs = $state<Record<string, string | null>>({});
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
  /** Last closed agent for undo/reopen. */
  lastClosedAgentId = $state<string | null>(null);
  /** Width (px) of the left sidebar rail — user-resizable, persisted. */
  sidebarWidth = $state(268);
  /** Fraction (0–1) of the sidebar's list area given to the Workspaces section;
   * the Agents section takes the rest. User-resizable, persisted. */
  workspacesRatio = $state(0.42);
  /** Width (px) of the Notes page's note-list pane — user-resizable, persisted. */
  notesListWidth = $state(296);

  /**
   * Agents whose Claude/shell process the user has explicitly opened THIS run.
   * Session-scoped and deliberately NOT persisted: on a fresh launch it starts
   * empty, so restoring the last-active agent shows it but does NOT auto-spawn its
   * PTY / resume Claude. A process only starts on an explicit user action —
   * clicking its tab or roster row, switching into its workspace, creating it, or
   * restoring it from History. This is what stops many agents from all launching at
   * once when the app is reopened.
   * @see TerminalPane — gates `start()` on {@link isLaunched}.
   */
  launchedAgentIds = new SvelteSet<string>();

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

      // Agents page only
      { id: "new-claude-agent", name: "New Claude Agent", key: "t", ctrl: false, shift: false, alt: false, meta: true, context: "agents", action: "new-claude-agent" },
      { id: "close-current-agent", name: "Close Current Agent", key: "Delete", ctrl: false, shift: false, alt: false, meta: true, context: "agents", action: "close-current-agent" },
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
  get activeAgent(): Agent | undefined {
    const id = this.activeWorkspaceId ? this.activeAgentByWs[this.activeWorkspaceId] : null;
    return this.agents.find(
      (a) => a.id === id && !a.archived && this.effectiveLane(a) !== "done",
    );
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
    for (const a of this.agents) if (a.workspaceId === id) a.archived = true;
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
    this.persist();
  }

  setActiveWorkspace(id: string) {
    this.activeWorkspaceId = id;
    if (!this.activeAgentByWs[id]) {
      this.activeAgentByWs[id] = this.tabsOf(id)[0]?.id ?? null;
    }
    // Switching into a workspace is an explicit user action → auto-resume its
    // active agent (unlike a fresh app launch, which restores state via load()
    // and leaves every agent dormant until clicked).
    const activeId = this.activeAgentByWs[id];
    if (activeId) this.launchedAgentIds.add(activeId);
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
  }): Agent {
    const siblings = this.agents.filter((a) => a.workspaceId === input.workspaceId);
    const agent: Agent = {
      id: uid("agent"),
      workspaceId: input.workspaceId,
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
    this.activeWorkspaceId = a.workspaceId;
    this.activeAgentByWs[a.workspaceId] = id;
    // Selecting an agent (tab / roster click, tab-index shortcut, open-from-page,
    // reopen, restore-from-history) is an explicit user open → allow its PTY to
    // start. Distinct from the fresh-launch restore in load(), which never lands
    // here and so leaves the agent dormant until clicked.
    this.launchedAgentIds.add(id);
    // NOTE: merely selecting the tab does NOT clear a "done" badge — the agent keeps
    // showing "done" until the user actually clicks into its terminal (see
    // markReviewed). Blocked is never cleared this way.
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
    this.launchedAgentIds.add(id);
  }

  /**
   * The user interacted with an agent's terminal (clicked or typed into it). A
   * finished (done) agent is now reviewed → idle. A blocked agent is also cleared:
   * the user is here handling it, so the red "needs input" pulse has done its job.
   *
   * Clearing blocked MUST also wipe the detection tail/spell — otherwise the stale
   * prompt phrase still sitting in the tail would re-trigger "blocked" on the very
   * next monitor tick, which is the "stuck error animation that won't clear" bug.
   * If Claude genuinely wants more input it redraws its prompt (new output), which
   * re-blocks cleanly; a live spinner still takes it straight to "working".
   */
  markReviewed(id: string) {
    const a = this.agents.find((x) => x.id === id);
    if (!a) return;
    const rec = this.activity.get(id);
    if (rec) rec.reviewPending = false;
    if (a.state === "done") {
      a.acknowledged = true;
      a.state = "idle";
      a.stateChangedAt = Date.now();
    } else if (a.state === "blocked") {
      if (rec) {
        rec.tail = "";
        rec.spell = false;
        rec.alertedBlocked = false;
      }
      a.state = "idle";
      a.stateChangedAt = Date.now();
    }
  }

  /** Switch to the nth (1-based) tab of the active workspace (Cmd+1..9). */
  activateTabIndex(n: number) {
    const tab = this.activeTabs[n - 1];
    if (tab) this.setActiveAgent(tab.id);
  }

  setAgentLane(id: string, lane: TaskStatus) {
    const a = this.agents.find((x) => x.id === id);
    if (!a) return;
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
    this.lastClosedAgentId = id; // Track for undo/reopen
    this.launchedAgentIds.delete(id);
    this.agents = this.agents.filter((x) => x.id !== id);
    // Intentionally leave dangling ids in task.agentIds[] (same soft-ref convention as ActivityEntry.refId);
    // taskAgents() filters live agents only, so this id is naturally dropped from current views.
    if (this.activeAgentByWs[ws] === id) {
      this.activeAgentByWs[ws] = this.tabsOf(ws)[0]?.id ?? null;
    }
    this.persist();
  }

  /** Reopen the last closed agent. */
  reopenLastAgent() {
    if (!this.lastClosedAgentId) return null;
    const agent = this.agents.find((a) => a.id === this.lastClosedAgentId);
    if (agent) {
      this.setActiveAgent(agent.id);
      this.lastClosedAgentId = null;
      return agent;
    }
    return null;
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
    if (patch.status !== undefined) t.status = patch.status;
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
  // The frontend feeds every PTY output batch into noteOutput(); a low-frequency
  // ticker then re-derives each Claude agent's AgentState purely from Claude's own
  // live spinner ("esc to interrupt"). That spinner shows ONLY while Claude is
  // processing a user prompt — so relaunching (`claude`), quitting (`exit`),
  // resuming on startup, or any other terminal noise never counts as "working" and
  // never fires a sound. Non-Claude agents have no such lifecycle at all.

  /**
   * Per-agent activity — intentionally OUTSIDE $state to avoid reactivity churn.
   *   spell        — inside a working spell (Claude's spinner has been live)
   *   reviewPending— a finished spell is waiting to be reviewed (drives "done")
   *   alertedBlocked— the blocked chime has already sounded for the CURRENT block, so
   *                   a prompt redraw (which flickers blocked→working→blocked) can't
   *                   replay it on a loop. Re-armed only when work genuinely resumes
   *                   (live spinner) or the turn ends.
   */
  private activity = new Map<
    string,
    {
      lastByteAt: number;
      tail: string;
      spell: boolean;
      reviewPending: boolean;
      alertedBlocked: boolean;
    }
  >();
  private monitorTimer: ReturnType<typeof setInterval> | null = null;

  private rec(id: string) {
    let r = this.activity.get(id);
    if (!r) {
      r = {
        lastByteAt: 0,
        tail: "",
        spell: false,
        reviewPending: false,
        alertedBlocked: false,
      };
      this.activity.set(id, r);
    }
    return r;
  }

  /** Called from the terminal layer with each decoded chunk of PTY output. */
  noteOutput(id: string, text: string) {
    if (!text) return;
    const rec = this.rec(id);
    rec.lastByteAt = Date.now();
    rec.tail = (rec.tail + stripAnsi(text)).slice(-TAIL_CAP);
    this.ensureMonitor();
  }

  /**
   * Called with each keystroke the user sends to a PTY. Kept only to make sure the
   * monitor is running; "working" is derived from Claude's spinner, not keystrokes,
   * so typing `claude`/`exit`/etc. never fabricates a turn.
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

  private tickMonitor() {
    const now = Date.now();
    for (const a of this.agents) {
      if (a.archived) continue; // archived-with-workspace agents are inert
      const rec = this.activity.get(a.id);
      if (!rec) continue;

      // Only Claude agents have a working/blocked/done turn lifecycle. Shell and
      // custom agents (and any raw terminal noise) never drive status or sounds.
      if (a.kind !== "claude") {
        const s: AgentState = a.status === "exited" ? "exited" : "idle";
        if (a.state !== s) {
          a.state = s;
          a.stateChangedAt = now;
        }
        continue;
      }
      if (a.status === "exited") {
        rec.spell = false;
        rec.alertedBlocked = false;
        if (a.state !== "exited") {
          a.state = "exited";
          a.stateChangedAt = now;
        }
        continue;
      }

      const idleFor = now - rec.lastByteAt;
      // Claude's live spinner ("esc to interrupt") is the ground truth for "I'm
      // processing a prompt". It only counts while output is actually flowing, so a
      // stale phrase left in the scrollback can't pin an agent as working forever.
      const spinnerLive =
        idleFor < SPINNER_STALE_MS &&
        SPINNER_MARKERS.some((re) => re.test(rec.tail.slice(-SPINNER_WINDOW)));
      // Stay "working" through the brief gaps between the spinner's reprints and
      // streaming bursts (when the phrase can momentarily scroll out of view).
      const working = spinnerLive || (rec.spell && idleFor < WORKING_QUIET_MS);

      // Re-arm the blocked chime the moment Claude is genuinely working again — the
      // LIVE spinner is showing, which a mere permission-prompt redraw never is. This
      // is what lets the next distinct block chime while stopping the same block from
      // chiming on every redraw.
      if (spinnerLive) rec.alertedBlocked = false;

      const promptShowing = BLOCKED_MARKERS.some((re) => re.test(rec.tail.slice(-1200)));

      let next: AgentState;
      if (spinnerLive) {
        // A live spinner is genuine work and always wins — this is how answering a
        // prompt (which brings the spinner back) exits the blocked state.
        next = "working";
      } else if (a.state === "blocked" && promptShowing) {
        // Already blocked and the prompt is still on screen → STAY blocked. A prompt
        // redraw makes idleFor small, which the quiet-window rule below would otherwise
        // read as "working" — flipping blocked→working→blocked, flickering the badge
        // and replaying the chime on a loop. Holding here is what stops that.
        next = "blocked";
      } else if (working) {
        next = "working";
      } else if (rec.spell) {
        // The spell just settled (600ms quiet, no spinner): waiting on the user if a
        // prompt is up, otherwise finished. Entry into blocked stays conservative so a
        // marker phrase appearing mid-response can't fire it early.
        next = promptShowing ? "blocked" : "done";
      } else {
        // A finished turn stays "done" until the user clicks into its terminal
        // (markReviewed). It is never auto-cleared on a timer.
        next = rec.reviewPending ? "done" : "idle";
      }

      if (a.state !== next) {
        if (next === "working") {
          if (!rec.spell) {
            // A genuine turn just started (spinner came up after user input).
            rec.spell = true;
            a.acknowledged = false;
            a.lastUsedAt = now;
            this.recordActivity("agent", a.id, a.name, "worked", a.workspaceId);
          }
        } else if (next === "blocked") {
          // Chime ONCE per block (keep the spell so answering resumes work). The flag
          // is cleared when work genuinely resumes or the turn ends, so it can't loop.
          if (!rec.alertedBlocked) {
            playBlocked();
            rec.alertedBlocked = true;
          }
        } else if (next === "done") {
          if (rec.spell) {
            rec.reviewPending = true;
            playDone();
          }
          rec.spell = false;
          rec.alertedBlocked = false;
          rec.tail = ""; // clear so a lingering spinner/prompt can't retrigger
        } else {
          rec.spell = false;
          rec.alertedBlocked = false;
          rec.tail = "";
        }
        a.state = next;
        a.stateChangedAt = now; // recency key for the sidebar's within-group sort
        this.persist();
      }
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

  /** Called once a Claude agent's terminal has launched, so future opens resume it. */
  markSessionStarted(id: string) {
    const a = this.agents.find((x) => x.id === id);
    if (a && a.kind === "claude" && !a.sessionStarted) {
      a.sessionStarted = true;
      this.persist();
    }
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

  /** Clamp + persist the Workspaces/Agents split ratio. */
  setWorkspacesRatio(ratio: number) {
    this.workspacesRatio = Math.max(0.12, Math.min(0.85, ratio));
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

  private snapshot() {
    return {
      version: 1,
      workspaces: this.workspaces,
      agents: this.agents.map((a) => ({
        id: a.id,
        workspaceId: a.workspaceId,
        name: a.name,
        kind: a.kind,
        run: a.run,
        cwd: a.cwd,
        lane: a.lane,
        taskId: a.taskId,
        order: a.order,
        sessionId: a.sessionId,
        sessionStarted: a.sessionStarted,
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
      defaultProjects: this.defaultProjects,
      terminalScrollPos: this.terminalScrollPos,
      shortcuts: this.shortcuts,
      pageViews: this.pageViews,
      notePreview: this.notePreview,
      lastNoteId: this.lastNoteId,
      lastClosedAgentId: this.lastClosedAgentId,
      sidebarWidth: this.sidebarWidth,
      workspacesRatio: this.workspacesRatio,
      notesListWidth: this.notesListWidth,
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
            // Keep agents in lock-step with their workspace's archived state.
            archived: (a.archived ?? false) || archivedWs.has(a.workspaceId),
            // Migrate: task -> lane, add taskId
            lane: a.lane ?? legacyTask ?? "backlog",
            taskId: a.taskId ?? null,
            // Migrate: give every Claude agent a tracked session id so it resumes by id.
            // Legacy agents (no id) start a fresh tracked session going forward.
            sessionId: a.sessionId ?? (a.kind === "claude" ? crypto.randomUUID() : null),
            sessionStarted: a.sessionId ? (a.sessionStarted ?? false) : false,
            createdAt: a.createdAt ?? Date.now(),
            lastUsedAt: a.lastUsedAt ?? a.createdAt ?? Date.now(),
            initialPrompt: a.initialPrompt ?? null,
            status: "idle" as RunStatus,
            exitCode: null,
            // Restore the roster-ordering state so the agents reappear in the exact
            // order they were left (blocked→done→working→idle, most-recent-first). The
            // live PTY is respawned lazily; the monitor re-derives state from real
            // output once the agent is opened. Legacy rows (no saved state) fall back
            // to idle, keyed by lastUsedAt so their recency ordering is still sensible.
            state: (a.state ?? "idle") as AgentState,
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
        this.defaultProjects = Array.isArray(data.defaultProjects) ? data.defaultProjects : [];
        this.terminalScrollPos = typeof data.terminalScrollPos === "number" ? data.terminalScrollPos : 0;
        // Load shortcuts with merge of defaults to catch new/updated shortcuts
        const defaults = this.getDefaultShortcuts();
        if (Array.isArray(data.shortcuts) && data.shortcuts.length > 0) {
          const savedMap = new Map((data.shortcuts as Shortcut[]).map(s => [s.id, s]));
          this.shortcuts = defaults.map(d => savedMap.get(d.id) || d);
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
        // Load last closed agent
        this.lastClosedAgentId = typeof data.lastClosedAgentId === "string" ? data.lastClosedAgentId : null;
        // Load persisted layout sizes (with sane clamps).
        if (typeof data.sidebarWidth === "number")
          this.sidebarWidth = Math.max(180, Math.min(560, data.sidebarWidth));
        if (typeof data.workspacesRatio === "number")
          this.workspacesRatio = Math.max(0.12, Math.min(0.85, data.workspacesRatio));
        if (typeof data.notesListWidth === "number")
          this.notesListWidth = Math.max(200, Math.min(560, data.notesListWidth));
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

        // Ensure every workspace has a valid active agent.
        for (const w of this.workspaces) {
          if (!this.activeAgentByWs[w.id]) {
            this.activeAgentByWs[w.id] = this.tabsOf(w.id)[0]?.id ?? null;
          }
        }
        // Keep counter ahead of restored ids to avoid collisions.
        counter = this.workspaces.length + this.agents.length + this.tasks.length + 1;
      }
    } catch (e) {
      console.error("[Codesu] load_state failed", e);
    } finally {
      this.loaded = true;
    }
    // Save any migration (newly-assigned session ids) back to disk.
    this.persist();
  }
}

export const app = new AppState();
