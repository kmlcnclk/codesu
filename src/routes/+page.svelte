<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { app } from "$lib/store/app.svelte";
  import { installFileDrop } from "$lib/terminal/attachments.svelte";
  import DropOverlay from "$lib/components/DropOverlay.svelte";
  import { gitStatus, isGitRepo } from "$lib/code/api";
  import ContextMenu, { type MenuItem } from "$lib/components/ContextMenu.svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import TabBar from "$lib/components/TabBar.svelte";
  import TerminalArea from "$lib/components/TerminalArea.svelte";
  import CodePage from "$lib/components/CodePage.svelte";
  import ReviewPage from "$lib/components/ReviewPage.svelte";
  import NewAgentDialog from "$lib/components/NewAgentDialog.svelte";
  import NewWorkspaceDialog from "$lib/components/NewWorkspaceDialog.svelte";
  import NewProjectDialog from "$lib/components/NewProjectDialog.svelte";
  import TasksPage from "$lib/components/TasksPage.svelte";
  import HistoryPage from "$lib/components/HistoryPage.svelte";
  import NotesPage from "$lib/components/NotesPage.svelte";
  import DailyReport from "$lib/components/DailyReport.svelte";
  import SettingsPage from "$lib/components/SettingsPage.svelte";
  import SystemTerminalView from "$lib/components/SystemTerminalView.svelte";
  import Icon from "$lib/components/Icon.svelte";
  import { setMuted, installAudioUnlock } from "$lib/sound";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { invoke } from "@tauri-apps/api/core";

  type View =
    | "agents"
    | "code"
    | "tasks"
    | "notes"
    | "report"
    | "history"
    | "settings"
    | "terminal"
    | "review";
  let view = $state<View>("agents");

  /**
   * The nav, as data.
   *
   * Each view carries its own hue: the icon wears it always and the active tab fills with
   * it, so "where am I" is answered by colour before the label is read. Seven identical
   * grey chips could not do that. Kept as a list rather than seven near-identical buttons
   * so a new view is one row, not a copy-paste.
   */
  const NAV: {
    view: View;
    label: string;
    icon: string;
    hue: string;
    title: string;
    badge?: () => number;
    mutedBadge?: boolean;
  }[] = [
    { view: "agents", label: "Agents", icon: "agents", hue: "--hue-blue", title: "Agents (⌘A)" },
    {
      view: "tasks",
      label: "Tasks",
      icon: "tasks",
      hue: "--hue-amber",
      title: "Tasks (⌘Y)",
      badge: () => app.openTaskCount,
    },
    {
      view: "notes",
      label: "Notes",
      icon: "notes",
      hue: "--hue-lime",
      title: "Notes (⌘N)",
      badge: () => app.ideaList.length,
      mutedBadge: true,
    },
    { view: "report", label: "Report", icon: "clipboard", hue: "--hue-violet", title: "Daily Report (⌘R)" },
    { view: "history", label: "History", icon: "archive", hue: "--hue-cyan", title: "History (⌘H)" },
    { view: "settings", label: "Settings", icon: "settings", hue: "--hue-rose", title: "Settings (⌘S)" },
  ];

  let showNewProject = $state(false);
  /** The project a new workspace is being created under, or null when the dialog is shut. */
  let newWorkspaceProj = $state<string | null>(null);
  let newAgentWs = $state<string | null>(null);

  /**
   * "Add a workspace" from anywhere that isn't a project row: it goes under the active
   * project, and with no project yet the only sensible first step is to add one.
   */
  function newWorkspaceForActive() {
    if (app.activeProjectId) newWorkspaceProj = app.activeProjectId;
    else showNewProject = true;
  }
  let muted = $state(false);
  // macOS hides the native traffic-light buttons in fullscreen; track it so the
  // titlebar's left inset (which reserves room for those buttons) can collapse and
  // not leave an empty gap.
  let isFullscreen = $state(false);
  function toggleMute() {
    muted = !muted;
    setMuted(muted);
  }

  /** Jump to the terminal view and focus a specific agent (used by Tasks/History). */
  function openAgentFromPage(agentId: string) {
    app.setActiveAgent(agentId);
    view = "agents";
  }

  /** Open a specific note on the Notes page (used by the Report). */
  function openNoteFromPage(noteId: string) {
    const note = app.tasks.find((t) => t.id === noteId);
    // Land on the tab the note actually lives in, so it's shown (not filtered out).
    app.setPageView("notes", note?.archived ? "archived" : "active");
    app.setLastNote(noteId);
    view = "notes";
  }

  onMount(() => {
    app.load();
    installAudioUnlock();
    // Painted from the last run's answer before any gh process exists, so the PR chip is
    // populated on the first frame instead of a second later.
    loadPrCache();
    // Then fill in every other project, once the launch has settled.
    const warm = setTimeout(() => void warmAllProjects(), 1200);

    // Attach keyboard handler
    window.addEventListener("keydown", onKeydown);

    // Re-stat the workspace folders whenever the app regains focus, so a folder
    // deleted (or restored) while the user was elsewhere is flagged/cleared right
    // away rather than only when an agent refuses to launch.
    window.addEventListener("focus", recheckPaths);

    const un = listen<{ id: string; code: number | null }>("session-exited", (e) => {
      app.markExited(e.payload.id, e.payload.code);
    });

    // Keep the titlebar inset in sync with fullscreen. Resize fires on the
    // enter/exit-fullscreen transition, so we re-check the flag there.
    const win = getCurrentWindow();
    const syncFullscreen = () =>
      win.isFullscreen().then((f) => (isFullscreen = f)).catch(() => {});
    syncFullscreen();
    const unResize = win.onResized(syncFullscreen);

    // Write any state still sitting inside persist()'s 250ms debounce before the
    // window goes away. Tauri awaits this handler and only then destroys the window
    // (it closes normally — we never preventDefault), so a reorder, selection or
    // review made in that last fraction of a second is no longer lost on quit.
    const unClose = win.onCloseRequested(async () => {
      await app.flush();
    });

    // Files dropped from Finder onto an agent's pane. Installed once, at the window
    // level, because Tauri delivers drags to the WINDOW (which is what makes real
    // filesystem paths available); it then routes them to the pane under the pointer.
    // installFileDrop() is idempotent — see the note on `installed` there — so it is
    // deliberately NOT torn down here: doing so would unhook a listener a hot-reloaded
    // remount still depends on.
    void installFileDrop();

    return () => {
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("focus", recheckPaths);
      clearTimeout(warm);
      un.then((f) => f());
      unResize.then((f) => f()).catch(() => {});
      unClose.then((f) => f()).catch(() => {});
    };
  });

  // Hoisted (function declaration, like onKeydown) so the listener above can name it
  // for both add and remove.
  function recheckPaths() {
    void app.checkWorkspacePaths();
    // A folder can become (or stop being) a repo while the app is open — `git init`,
    // a clone finishing — and that decides whether it can spawn worktree workspaces.
    void app.refreshProjectGit();
    // Coming back to the window is exactly when a PR was opened, reviewed or merged in
    // the browser, so the chip re-checks rather than showing what was true before.
    if (app.activeWorkspaceId) void loadPrs(app.activeWorkspaceId, true);
  }

  /**
   * True when the keystroke is being typed into a text field, where app shortcuts must
   * not fire: ⌘A in a note body means "select all", not "go to Agents", and the note
   * editor / search / title inputs don't stop propagation. Self-sufficient by design —
   * it does not rely on any component (modals included) swallowing the event first.
   *
   * The terminal is the one deliberate exception. xterm types through a hidden
   * <textarea>, but ⌘T / ⌘D / ⌘1-9 / ⌘⌫ are exactly the shortcuts the user needs WHILE
   * working in a pane, and Claude itself only ever binds ctrl chords — so keys landing
   * anywhere inside an .xterm root stay global.
   */
  function isEditableTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || typeof el.closest !== "function") return false;
    if (el.closest(".xterm")) return false;
    return !!el.closest(
      "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
    );
  }

  function onKeydown(e: KeyboardEvent) {
    if (isEditableTarget(e.target)) return;
    const key = e.key.toLowerCase();
    // Review is a place you step into and back out of, so Esc leaves it.
    if (key === "escape" && view === "review" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      closeReview();
      return;
    }
    const shortcuts = app.getShortcutsByContext(view as any);

    for (const shortcut of shortcuts) {
      const matches =
        shortcut.key.toLowerCase() === key &&
        shortcut.meta === e.metaKey &&
        shortcut.shift === e.shiftKey &&
        shortcut.ctrl === e.ctrlKey &&
        shortcut.alt === e.altKey;

      if (!matches) continue;

      e.preventDefault();

      // Navigation actions
      if (shortcut.action === "navigate-agents") {
        view = "agents";
      } else if (shortcut.action === "navigate-code") {
        toggleCode();
      } else if (shortcut.action === "navigate-review") {
        toggleReview();
      } else if (shortcut.action === "navigate-tasks") {
        view = "tasks";
      } else if (shortcut.action === "navigate-notes") {
        view = "notes";
      } else if (shortcut.action === "navigate-report") {
        view = "report";
      } else if (shortcut.action === "navigate-history") {
        view = "history";
      } else if (shortcut.action === "navigate-settings") {
        view = "settings";
      } else if (shortcut.action === "navigate-terminal") {
        view = view === "terminal" ? "agents" : "terminal";
      }
      // Agents-only actions
      else if (shortcut.action === "new-claude-agent") {
        if (app.activeWorkspaceId) app.newClaudeInActive();
        else newWorkspaceForActive();
      } else if (shortcut.action === "split-pane-vertical") {
        if (app.activeWorkspaceId) app.splitFocused("row");
        else newWorkspaceForActive();
      } else if (shortcut.action === "split-pane-horizontal") {
        if (app.activeWorkspaceId) app.splitFocused("col");
        else newWorkspaceForActive();
      } else if (shortcut.action === "flip-split") {
        if (app.activeAgent) app.flipSplitOf(app.activeAgent.id);
      } else if (shortcut.action === "close-current-agent") {
        if (app.activeAgent) {
          app.removeAgent(app.activeAgent.id);
        }
      } else if (shortcut.action === "reopen-last-agent") {
        app.reopenLastAgent();
      } else if (shortcut.action.startsWith("select-tab-")) {
        const tabNum = parseInt(shortcut.action.replace("select-tab-", ""));
        app.activateTabIndex(tabNum);
      }
      // Page view actions
      else if (shortcut.action.startsWith("set-page-view-")) {
        const viewName = shortcut.action.replace("set-page-view-", "");
        app.setPageView(view, viewName);
      }

      return; // Only process one shortcut per keypress
    }
  }

  /** Popover menu (the workspace picker) — position plus its items, or null when closed. */
  let popupMenu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);

  interface PullRequest {
    number: number;
    title: string;
    url: string;
    state: string;
    is_draft: boolean;
    head_ref: string;
    author: string;
    updated_at: string;
    review_decision: string | null;
    is_current: boolean;
  }

  /**
   * PR listings per workspace. Kept in memory rather than persisted: PR state goes stale
   * the moment someone pushes, and a number restored from disk would be a lie.
   */
  let prCache = $state<Record<string, PullRequest[]>>({});
  /** When each entry was fetched, so a stale one can be refreshed behind the menu. */
  let prFetchedAt = $state<Record<string, number>>({});
  /**
   * Fetches in flight, by workspace. A map rather than a set so a second caller can AWAIT
   * the first one's result instead of racing past it — opening the menu while the
   * prefetch is still running must wait for that answer, not paint an empty list over it.
   */
  const prInFlight = new Map<string, Promise<void>>();
  /** Per-workspace failure (a repo with no GitHub remote, say), shown instead of "none". */
  let prError = $state<Record<string, string>>({});
  /**
   * Set when gh itself is the problem (missing, or not signed in) rather than this repo.
   * Prefetching stops while it holds — spawning a login shell per workspace switch to
   * re-learn the same answer is pure cost. Cleared by "Try again" in the menu.
   */
  let prUnavailable = $state<string | null>(null);

  /** Long enough that switching between workspaces is free; short enough to stay honest. */
  const PR_TTL_MS = 90_000;
  const PR_STORE_KEY = "codesu.prs.v1";

  /**
   * Keep the cache across restarts.
   *
   * Every `gh` call costs a process spawn plus a network round trip, so a cold app used to
   * show a blank chip for a second on launch — the moment it most needs to be right. The
   * last known answer is written here and read back on mount, which is shown IMMEDIATELY
   * and then revalidated in the background. localStorage rather than the app store because
   * this is a cache, not state: losing it costs one refetch, and it must never travel into
   * a state file that means something.
   */
  function savePrCache() {
    try {
      localStorage.setItem(
        PR_STORE_KEY,
        JSON.stringify({ prs: prCache, at: prFetchedAt }),
      );
    } catch {
      /* a full or disabled localStorage just means no warm start */
    }
  }

  function loadPrCache() {
    try {
      const raw = localStorage.getItem(PR_STORE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as {
        prs?: Record<string, PullRequest[]>;
        at?: Record<string, number>;
      };
      if (saved.prs) prCache = saved.prs;
      // Timestamps are restored too, so a fresh-enough cache is not refetched on launch
      // — but anything past the TTL revalidates immediately, as it should.
      if (saved.at) prFetchedAt = saved.at;
    } catch {
      /* unreadable cache is no cache */
    }
  }

  /** The branch a workspace's PRs should be matched against. */
  function branchOf(ws: { id: string; branch: string | null }): string | null {
    // A worktree knows its own branch; the primary checkout's branch is whatever HEAD
    // says, which the gitStatus poll already told us.
    return ws.branch ?? (ws.id === app.activeWorkspaceId ? headBranch : null);
  }

  /** The PR for the workspace's own branch, if we have fetched one. */
  const currentPr = $derived.by(() => {
    const ws = app.activeWorkspace;
    if (!ws) return null;
    const list = prCache[ws.id];
    if (!list) return null;
    const branch = branchOf(ws);
    return list.find((p) => p.is_current || (branch && p.head_ref === branch)) ?? null;
  });

  /**
   * Fetch the active workspace's PRs, ahead of anyone asking for them.
   *
   * This runs on workspace switch rather than on click so the chip is already showing
   * "#42" by the time it is looked at — a chip you have to press and then wait on tells
   * you nothing at a glance, which was the whole point of putting it in the titlebar.
   *
   * Cheap by construction: one gh call per workspace, skipped entirely while a fresh
   * result is cached, and the OPEN half of the answer is repo-wide, so every sibling
   * workspace in the same project is seeded from the same response.
   */
  function loadPrs(wsId: string, force = false): Promise<void> {
    const running = prInFlight.get(wsId);
    if (running) return running;

    const ws = app.workspaces.find((w) => w.id === wsId);
    const proj = app.projectOf(wsId);
    if (!ws || !proj?.isGit) return Promise.resolve();
    if (prUnavailable && !force) return Promise.resolve();

    const fresh = untrack(() => Date.now() - (prFetchedAt[wsId] ?? 0) < PR_TTL_MS);
    if (fresh && !force) return Promise.resolve();

    const repo = ws.repo ?? proj.path;
    const branch = branchOf(ws);
    const run = (async () => {
      try {
        const prs = await invoke<PullRequest[]>("list_pull_requests", { repo, branch });
        prCache[wsId] = prs;
        prFetchedAt[wsId] = Date.now();
        prUnavailable = null;
        delete prError[wsId];
        seedSiblings(proj.id, wsId, prs);
        savePrCache();
      } catch (err) {
        const message = String(err instanceof Error ? err.message : err);
        // A broken repo is this workspace's problem; a missing or signed-out gh is every
        // workspace's, and must not be re-discovered on each switch.
        if (message.includes("gh") || message.includes("GitHub CLI")) prUnavailable = message;
        else prError[wsId] = message;
        prFetchedAt[wsId] = Date.now();
      } finally {
        prInFlight.delete(wsId);
      }
    })();
    prInFlight.set(wsId, run);
    return run;
  }

  /**
   * Share one repo's open PRs with the project's other workspaces.
   *
   * `gh pr list --state open` is repo-wide, so the answer for one workspace already
   * contains the answer for its siblings — seeding them here means switching between
   * branches of the same project shows their numbers instantly, with no second call.
   * Only OPEN entries travel: the closed/merged ones in a response belong to the branch
   * that was asked about, not to anyone else.
   */
  function seedSiblings(projectId: string, sourceWsId: string, prs: PullRequest[]) {
    const open = prs.filter((p) => p.state === "OPEN");
    for (const sib of app.workspacesOf(projectId)) {
      if (sib.id === sourceWsId || prCache[sib.id]) continue;
      const branch = sib.branch;
      if (!branch) continue;
      prCache[sib.id] = open.map((p) => ({ ...p, is_current: p.head_ref === branch }));
      // Deliberately NOT stamped as fetched: this is a good-enough preview, and the
      // workspace still earns its own full fetch (closed PRs included) when opened.
    }
  }

  // Prefetch whenever the workspace you are looking at changes.
  $effect(() => {
    const id = app.activeWorkspaceId;
    // Tracked so a primary workspace re-fetches once its branch is known.
    void headBranch;
    if (!id || !inWorkspaceView) return;
    void loadPrs(id);
  });

  /**
   * Warm every project once, shortly after launch.
   *
   * One call per PROJECT, not per workspace: the sweep is repo-wide, so a single answer
   * seeds every workspace under it. That means switching to any workspace — not just the
   * one that happened to be open — finds its chip already filled in.
   *
   * Staggered and deferred so it competes with nothing: the active workspace has already
   * been asked for by the effect above, and the rest can wait a moment.
   */
  async function warmAllProjects() {
    const projects = app.liveProjects.filter((p) => p.isGit);
    for (const proj of projects) {
      if (prUnavailable) return;
      const ws = app.workspacesOf(proj.id)[0];
      if (!ws) continue;
      await loadPrs(ws.id);
      // A gap between repos so a machine with many projects does not spawn a burst of
      // gh processes on top of everything else a launch is doing.
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  /** Colour by state, so the list is scannable before any label is read. */
  function prColor(pr: PullRequest): string {
    if (pr.state === "MERGED") return "#a371f7";
    if (pr.state === "CLOSED") return "#f85149";
    if (pr.is_draft) return "#8b949e";
    if (pr.review_decision === "CHANGES_REQUESTED") return "#d29922";
    return "#3fb950";
  }

  /** The PR's state in one word, the way GitHub itself says it. */
  function prState(pr: PullRequest): string {
    if (pr.state === "MERGED") return "merged";
    if (pr.state === "CLOSED") return "closed";
    if (pr.is_draft) return "draft";
    if (pr.review_decision === "APPROVED") return "approved";
    if (pr.review_decision === "CHANGES_REQUESTED") return "changes requested";
    return "open";
  }

  function prLabel(pr: PullRequest): string {
    // Menu rows size to their content and PR titles run long; an untruncated one would
    // stretch the popup past the window. Truncated here rather than in the menu's CSS so
    // every other menu in the app keeps sizing to its own labels.
    const title = pr.title.length > 44 ? `${pr.title.slice(0, 43).trimEnd()}…` : pr.title;
    // "open" is the resting state and the green dot already says it; only the states
    // worth stopping on are spelled out.
    const state = prState(pr);
    return `#${pr.number}  ${title}` + (state === "open" ? "" : `  ·  ${state}`);
  }

  /** The PR menu's rows: this branch's PRs first, then the rest of the repo's open ones. */
  function buildPrItems(prs: PullRequest[], repo: string): MenuItem[] {
    const items: MenuItem[] = [];
    const mine = prs.filter((p) => p.is_current);
    const others = prs.filter((p) => !p.is_current);

    if (mine.length) {
      for (const pr of mine) {
        items.push({ label: prLabel(pr), color: prColor(pr), onSelect: () => void openUrl(pr.url) });
      }
    } else {
      items.push({ label: "No pull request for this branch", disabled: true });
    }
    if (others.length) {
      items.push({ label: "Other open pull requests", disabled: true, separatorBefore: true });
      for (const pr of others) {
        items.push({
          label: `${prLabel(pr)}  ·  ${pr.head_ref}`,
          color: prColor(pr),
          onSelect: () => void openUrl(pr.url),
        });
      }
    }
    items.push({
      label: "Open repository on GitHub",
      separatorBefore: true,
      onSelect: () => {
        invoke<string>("github_repo_url", { repo })
          .then((url) => openUrl(url))
          .catch((err) => console.error("[Codesu] repo url failed", err));
      },
    });
    return items;
  }

  /**
   * Pull requests for the active workspace, opened straight from the titlebar.
   *
   * The menu opens BEFORE the fetch resolves, showing a placeholder, because `gh` against
   * a cold network is slow enough that a chip which does nothing for a second reads as
   * broken. Results are swapped into the same open menu when they land.
   *
   * The repo is the PROJECT's path, not the workspace's: a worktree has the same remote,
   * and asking git from the main checkout is the case that is always set up.
   */
  async function showPrMenu(e: MouseEvent) {
    const ws = app.activeWorkspace;
    if (!ws) return;
    const repo = ws.repo ?? app.projectOf(ws.id)?.path ?? ws.path;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const at = { x: Math.min(r.left, window.innerWidth - 420), y: r.bottom + 4 };
    const render = (items: MenuItem[]) => (popupMenu = { ...at, items });
    const wsId = ws.id;

    // Straight from the prefetch in the overwhelming majority of cases. A spinner only
    // appears when the prefetch has not landed yet — a cold start, or a workspace opened
    // within the same instant it was switched to.
    if (prUnavailable) {
      render([
        { label: prUnavailable, disabled: true },
        {
          label: "Try again",
          separatorBefore: true,
          onSelect: () => {
            prUnavailable = null;
            void showPrMenu(e);
          },
        },
      ]);
      return;
    }
    const cached = prCache[wsId];
    render(cached ? buildPrItems(cached, repo) : [{ label: "Loading pull requests…", disabled: true }]);

    // Refresh behind the open menu so a PR opened since the prefetch still turns up. If a
    // prefetch is already running this joins it rather than starting a second.
    await loadPrs(wsId, true);
    // Only repaint if this menu is still the one on screen — the user may have dismissed
    // it, or opened another, while gh was thinking.
    if (!popupMenu) return;
    const failure = prUnavailable ?? prError[wsId];
    if (failure) {
      render([
        { label: failure, disabled: true },
        {
          label: "Try again",
          separatorBefore: true,
          onSelect: () => {
            prUnavailable = null;
            delete prError[wsId];
            void showPrMenu(e);
          },
        },
      ]);
      return;
    }
    render(buildPrItems(prCache[wsId] ?? [], repo));
  }

  /**
   * Workspace picker on the titlebar chip.
   *
   * This is the only way to change workspace in the Code view, which has no sidebar —
   * so it lists every live workspace, with its accent dot, and offers the new-workspace
   * dialog at the bottom.
   */
  function showWorkspaceMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Grouped by project, in the rail's own order: workspace names ("main", "fix/…")
    // repeat across projects, so a flat list of them cannot be navigated.
    const items: MenuItem[] = [];
    for (const proj of app.liveProjects) {
      const spaces = app.workspacesOf(proj.id);
      if (!spaces.length) continue;
      let first = true;
      for (const w of spaces) {
        items.push({
          label: first ? `${proj.name} / ${w.name}` : `    ${w.name}`,
          color: w.color,
          checked: w.id === app.activeWorkspaceId,
          separatorBefore: first && items.length > 0,
          onSelect: () => app.setActiveWorkspace(w.id),
        });
        first = false;
      }
    }
    items.push({
      label: "New workspace…",
      separatorBefore: true,
      onSelect: newWorkspaceForActive,
    });
    popupMenu = { x: Math.min(r.left, window.innerWidth - 240), y: r.bottom + 4, items };
  }

  /**
   * The view to come back to when Code is toggled off.
   *
   * Code takes over the whole window, so leaving it is a "go back", not a "go to Agents":
   * toggling out of it from the Tasks board should land on the Tasks board. Never holds
   * "code" itself, or the button would toggle onto itself.
   */
  let viewBeforeCode = $state<View>("agents");

  /** Enter the Code view, remembering where from. */
  function enterCode() {
    if (view !== "code") viewBeforeCode = view;
    view = "code";
  }

  /** The titlebar Code button and ⌘E: in when out, back where you were when in. */
  function toggleCode() {
    if (view === "code") view = viewBeforeCode;
    else enterCode();
  }

  /**
   * The view to come back to when Review is closed — same idea as `viewBeforeCode`.
   * Review is reachable from the session's tab strip only, so that is almost always
   * "agents", but going back where you came from is the rule either way.
   */
  let viewBeforeReview = $state<View>("agents");

  // ---- review badge ----
  /**
   * The changed files of the active workspace, so the titlebar can say — without the
   * user having to enter Review and look — that there is something to read.
   *
   * Polled rather than pushed: the changes come from agents editing on disk, which the
   * app never sees. Null means "no repo here", and hides the button entirely.
   */
  let changedPaths = $state<string[] | null>(null);

  const reviewWs = $derived(app.activeWorkspace);
  const unreviewed = $derived(
    reviewWs && changedPaths
      ? changedPaths.length - app.codeViewedCount(reviewWs.id, changedPaths)
      : 0,
  );
  /**
   * Highlight only when an agent has just finished a turn.
   *
   * "Unreviewed files exist" was the obvious signal and the wrong one: a working tree
   * carries dozens of changes nobody has ticked at all times, so the button was lit
   * permanently and stopped meaning anything. A finished turn is the moment there is
   * genuinely something NEW to read.
   */
  const freshTurn = $derived(
    app.activeTabGroups.some((g) => g.agents.some((a) => a.state === "done")),
  );

  /** The branch the active workspace's checkout is actually on (see the gitStatus poll). */
  let headBranch = $state<string | null>(null);

  /** Code and Review belong to the workspace views; elsewhere they have nothing to act on. */
  const inWorkspaceView = $derived(view === "agents" || view === "code" || view === "review");

  $effect(() => {
    const root = reviewWs?.path;
    if (!root) {
      changedPaths = null;
      return;
    }
    let cancelled = false;

    const refresh = async () => {
      try {
        if (!(await isGitRepo(root))) {
          if (!cancelled) changedPaths = null;
          return;
        }
        const st = await gitStatus(root);
        if (!cancelled) {
          changedPaths = st.changes.map((c) => c.path);
          // Free, from a call already being made: a primary workspace has no `branch`
          // of its own, so without this the main checkout could never match a PR.
          headBranch = st.branch ?? null;
        }
      } catch {
        if (!cancelled) {
          changedPaths = null;
          headBranch = null;
        }
      }
    };

    void refresh();
    // Polling only pays for itself while a view that shows the button is on screen.
    const timer = setInterval(() => {
      if (inWorkspaceView) void refresh();
    }, 5000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  });

  /** Open the Review page (the titlebar's Review button). */
  function openReview() {
    if (view !== "review") viewBeforeReview = view;
    view = "review";
  }

  function closeReview() {
    view = viewBeforeReview === "review" ? "agents" : viewBeforeReview;
  }

  /**
   * The titlebar Review button and ⌘⇧R: in when out, back where you were when in.
   *
   * Guarded on there being a diff to read at all — outside a git workspace the button is
   * not drawn, so the shortcut must not open an empty page either.
   */
  function toggleReview() {
    if (view === "review") closeReview();
    else if (changedPaths) openReview();
  }

  /** "Edit file" inside a diff — hand the file to the Code view, which owns editing. */
  function editFromReview(absPath: string) {
    if (app.activeWorkspaceId) app.openCodeFile(app.activeWorkspaceId, absPath);
    enterCode();
  }

  /** Switch a workspace into the Code view (from the sidebar's context menu). */
  function openCodeFromSidebar(workspaceId: string) {
    app.setActiveWorkspace(workspaceId);
    enterCode();
  }

  function openNewAgent(workspaceId: string) {
    newAgentWs = workspaceId;
  }
  function newAgentForActive() {
    if (app.activeWorkspaceId) newAgentWs = app.activeWorkspaceId;
    else newWorkspaceForActive();
  }
</script>

<div class="app">
  <header class="titlebar" class:fullscreen={isFullscreen} data-tauri-drag-region>
    <span class="brand" title="Codesu">
      <!--
        The wordmark alone read as a stray label floating beside the traffic lights;
        paired with the mark it becomes a lockup the eye can anchor on.

        The mark is the shipped app icon itself (a copy of src-tauri/icons/128x128@2x.png),
        never a redrawn approximation — the titlebar and the dock have to show the same
        object. It carries its own squircle and transparent corners, so no tile, border or
        radius is applied here; 256px of source keeps it crisp on retina.
      -->
      <img class="mark" src="/brand-mark.png" alt="" aria-hidden="true" />
      <span class="wordmark">Codesu</span>
    </span>

    <nav class="nav" aria-label="Views">
      {#each NAV as item (item.view)}
        <button
          class="nav-btn"
          class:on={view === item.view}
          style:--hue="var({item.hue})"
          onclick={() => (view = item.view)}
          title={item.title}
        >
          <Icon name={item.icon} size={15} /><span class="nav-lbl">{item.label}</span>
          {#if item.badge?.()}<span class="nav-badge" class:muted={item.mutedBadge}>{item.badge()}</span>{/if}
        </button>
      {/each}
    </nav>

    <button
      class="terminal-btn"
      class:on={view === "terminal"}
      title="Terminal (⌘⇧T)"
      onclick={() => (view = view === "terminal" ? "agents" : "terminal")}
    >
      <Icon name="terminal" size={15} />
    </button>

    <span class="spacer"></span>
    <button
      class="mute"
      class:off={muted}
      title={muted ? "Sounds off — click to enable" : "Sounds on — click to mute"}
      aria-label="Toggle agent sounds"
      onclick={toggleMute}
    ><Icon name={muted ? "volumeMute" : "volume"} size={15} /></button>
    {#if (view === "agents" || view === "code" || view === "review") && app.activeWorkspace}
      <!-- Derived from the WORKSPACE, never from activeProjectId: two independent ids
           can drift apart, and a chip naming one project while the panes show another
           is worse than no chip at all. -->
      {@const crumbProj = app.projectOf(app.activeWorkspace.id)}
      <span class="crumbs">
        <button
          class="ws-chip"
          style="--accent:{app.activeWorkspace.color}"
          title="Switch workspace"
          onclick={showWorkspaceMenu}
        >
          <!-- Project first, then the workspace inside it: workspace names repeat
               across projects ("main", "fix/…"), so the name alone does not locate you. -->
          <span class="d"></span>{#if crumbProj}<span class="proj">{crumbProj.name}</span
            ><span class="sep">/</span>{/if}{app.activeWorkspace.name}
          <Icon name="chevronDown" size={12} />
        </button>
        {#if view === "agents" && app.activeAgent}<span class="arrow">›</span><span class="ag"
            >{app.activeAgent.name}</span
          >{/if}
        <!--
          Review happens on GitHub, so the workspace only has to get you there. The chip
          wears the branch's PR number once we know it, which doubles as the answer to
          "did I already open one for this?" without a trip to the browser.
        -->
        {#if crumbProj?.isGit}
          <button
            class="pr-chip"
            class:has-pr={!!currentPr}
            style={currentPr ? `--pr:${prColor(currentPr)}` : ""}
            title={currentPr
              ? `#${currentPr.number} ${currentPr.title} — ${prState(currentPr)} · open on GitHub`
              : "Pull requests for this workspace"}
            onclick={showPrMenu}
          >
            <Icon name="pullRequest" size={13} />
            <span class="pr-lbl">{currentPr ? `#${currentPr.number}` : "PRs"}</span>
          </button>
        {/if}
      </span>
    {/if}
    <!--
      Code and Review sit together at the end of the titlebar rather than in the nav
      group: both take over the whole window (no agent rail), so they read as modes you
      enter next to the workspace they apply to — not as two tabs among seven. Neither
      has anything to act on outside the workspace views, so both go with them.

      They are one segmented control, not two buttons: they are the two halves of a
      single question — which side of the workspace you are looking at — and only one can
      be lit at a time. The lit half is also the way back out (see toggleCode/Review).
    -->
    {#if inWorkspaceView}
      <div class="mode-seg" role="group" aria-label="Workspace mode">
        <button
          class="seg"
          class:on={view === "code"}
          aria-pressed={view === "code"}
          title={view === "code" ? "Close Code (⌘E)" : "Code (⌘E)"}
          onclick={toggleCode}
        >
          <Icon name="code2" size={14} /><span class="cb-lbl">Code</span>
        </button>
        {#if changedPaths}
          <button
            class="seg review-seg"
            class:on={view === "review"}
            class:pending={freshTurn && view !== "review"}
            aria-pressed={view === "review"}
            title={changedPaths.length === 0
              ? "Review changes — working tree clean (⌘⇧R)"
              : `Review ${changedPaths.length} changed file${changedPaths.length === 1 ? "" : "s"}` +
                (unreviewed > 0 ? ` · ${unreviewed} not yet reviewed` : " · all reviewed") +
                " (⌘⇧R)"}
            onclick={toggleReview}
          >
            <Icon name="diff" size={14} /><span class="cb-lbl">Review</span>
            {#if changedPaths.length}<span class="rb-count">{changedPaths.length}</span>{/if}
          </button>
        {/if}
      </div>
    {/if}
  </header>

  <div class="body">
    <!--
      The workspace/agent rail belongs to the Agents view only. The Code view already
      spends its width on a file tree and a diff, and hands workspace switching to the
      titlebar chip instead (see `showWorkspaceMenu`).
    -->
    {#if view === "agents"}
      <Sidebar
        onNewProject={() => (showNewProject = true)}
        onNewWorkspace={(projectId) => (newWorkspaceProj = projectId)}
        onNewAgent={openNewAgent}
        onOpenCode={openCodeFromSidebar}
      />
    {/if}
    <div class="main">
      <!--
        The Agents view stays mounted (hidden) while other views are shown, so the
        live PTYs and Claude sessions are never torn down when switching views.
      -->
      <div class="agents-view" style:display={view === "agents" ? "flex" : "none"}>
        {#if app.activeWorkspaceId}
          <TabBar onNewAgent={newAgentForActive} />
        {/if}
        <TerminalArea />
      </div>
      <!--
        Like the Agents view, the Code view stays mounted (hidden) so its run shell keeps
        running — and its scrollback survives — while the user is looking elsewhere.
      -->
      <div style:display={view === "code" ? "flex" : "none"} style:flex="1" style:min-height="0">
        <CodePage />
      </div>
      <!--
        Review is its own page, not a tab inside Code: reading a diff and editing a file
        are different jobs, and sharing one rail made both harder to find. It is reached
        from the session's tab strip and stays mounted so a half-read review survives a
        trip back to the terminal.
      -->
      <div style:display={view === "review" ? "flex" : "none"} style:flex="1" style:min-height="0">
        <ReviewPage onClose={closeReview} onEditFile={editFromReview} onSent={openAgentFromPage} />
      </div>
      <!--
        System terminal also stays mounted (hidden) to preserve PTY state and buffer.
      -->
      <div style:display={view === "terminal" ? "flex" : "none"} style:flex="1" style:min-height="0">
        <SystemTerminalView />
      </div>
      {#if view === "tasks"}
        <TasksPage onOpenAgent={openAgentFromPage} />
      {:else if view === "notes"}
        <NotesPage onOpenAgent={openAgentFromPage} />
      {:else if view === "report"}
        <DailyReport onOpenAgent={openAgentFromPage} onOpenNote={openNoteFromPage} />
      {:else if view === "history"}
        <HistoryPage onOpenAgent={openAgentFromPage} onOpenNote={openNoteFromPage} />
      {:else if view === "settings"}
        <SettingsPage />
      {/if}
    </div>
  </div>
</div>

{#if showNewProject}
  <NewProjectDialog
    onClose={() => (showNewProject = false)}
    onCreated={(project, created) => {
      // A brand-new project opens on its own folder with one agent ready to talk to,
      // rather than on an empty pane the user has to furnish first. Only a REAL create:
      // re-picking a folder you already track just selects it, and seeding an agent
      // there would spawn an unasked-for Claude (and its PTY) in an open workspace.
      if (!created) return;
      const primary = app.workspacesOf(project.id)[0];
      if (primary) app.addAgent({ workspaceId: primary.id, kind: "claude", run: "claude" });
    }}
  />
{/if}
{#if newWorkspaceProj}
  <NewWorkspaceDialog
    projectId={newWorkspaceProj}
    onClose={() => (newWorkspaceProj = null)}
    onCreated={(ws) => {
      app.addAgent({
        workspaceId: ws.id,
        kind: "claude",
        run: "claude",
      });
    }}
  />
{/if}
{#if newAgentWs}
  <NewAgentDialog workspaceId={newAgentWs} onClose={() => (newAgentWs = null)} />
{/if}
{#if popupMenu}
  <ContextMenu x={popupMenu.x} y={popupMenu.y} items={popupMenu.items} onClose={() => (popupMenu = null)} />
{/if}

<!-- Window-level, because Tauri delivers file drags to the window and no pane can see
     them. It paints the drag and reports where the files landed. -->
<DropOverlay />

<style>
  :global(html),
  :global(body) {
    margin: 0;
    height: 100%;
    background: var(--bg);
  }
  .app {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: var(--text);
  }
  .titlebar {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 40px;
    /* Left inset clears the native macOS traffic-light buttons, which the
       "Overlay" title-bar style floats over the top-left of the window. */
    padding: 0 12px 0 78px;
    background: var(--surface-1);
    border-bottom: 1px solid var(--border);
    user-select: none;
    /* Glide the content in/out as the traffic lights appear/disappear, roughly
       matching macOS's own fullscreen transition so it feels intentional. */
    transition: padding-left 0.35s cubic-bezier(0.32, 0.72, 0, 1);
  }
  /* In fullscreen macOS hides the traffic lights, so drop the reserved inset
     to avoid an empty gap on the left of the titlebar. */
  .titlebar.fullscreen {
    padding-left: 12px;
  }
  @media (prefers-reduced-motion: reduce) {
    .titlebar {
      transition: none;
    }
  }
  .brand {
    display: flex;
    align-items: center;
    /* 6, not 8: the artwork's own canvas padding already contributes ~2px on its right. */
    gap: 6px;
    /* Not a button: the whole lockup stays part of the window drag region. */
    pointer-events: none;
  }
  .mark {
    flex: none;
    width: 22px;
    height: 22px;
    display: block;
    /* The artwork's own body fills ~80% of its canvas (the macOS icon grid), so 22px of
       box renders an ~18px tile — the size the wordmark next to it wants. */
    object-fit: contain;
  }
  .wordmark {
    /* 700/0.4px was heavier and wider than every other label in the bar. The name is
       an identity, not a call to action — 600 at normal tracking sits with the nav. */
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.1px;
    color: var(--text);
    white-space: nowrap;
  }
  .nav {
    display: flex;
    gap: 3px;
    margin-left: 14px;
    padding: 3px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 9px;
  }
  .nav-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.12s ease, color 0.12s ease, box-shadow 0.12s ease;
  }
  /* The icon carries the view's hue even when the tab is idle — dimmed, so a row of
     seven reads as a palette rather than as a fairground. */
  .nav-btn :global(svg) {
    color: var(--hue);
    opacity: 0.62;
    transition: opacity var(--t-fast);
  }
  .nav-btn:hover {
    color: var(--text-secondary);
    background: var(--surface-3);
  }
  .nav-btn:hover :global(svg) {
    opacity: 0.9;
  }
  .nav-btn.on {
    background: color-mix(in srgb, var(--hue) 16%, transparent);
    color: var(--hue);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--hue) 30%, transparent);
  }
  .nav-btn.on :global(svg) {
    opacity: 1;
  }
  .nav-badge {
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    display: grid;
    place-items: center;
    border-radius: 8px;
    background: var(--hue, var(--accent));
    color: var(--on-hue);
    font-size: 10px;
    font-weight: 800;
  }
  .nav-badge.muted {
    background: var(--surface-4);
    color: var(--text-muted);
  }
  .terminal-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 7px;
    cursor: pointer;
    transition: background 0.13s, color 0.13s;
  }
  .terminal-btn:hover {
    color: var(--text);
    background: var(--surface-3);
  }
  .terminal-btn.on {
    background: var(--accent-soft);
    color: var(--accent-bright);
    box-shadow: inset 0 0 0 1px var(--accent-softer);
  }
  .spacer {
    flex: 1;
  }
  .mute {
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    cursor: pointer;
    color: var(--text-muted);
    padding: 4px 6px;
    border-radius: 5px;
    transition: background 0.12s ease, color 0.12s ease;
  }
  .mute:hover {
    background: var(--surface-3);
    color: var(--text);
  }
  .mute.off {
    color: var(--text-ghost);
    opacity: 0.7;
  }
  .crumbs {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    max-width: 45%;
    overflow: hidden;
  }
  .ws-chip {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--text-secondary);
    font-size: 12px;
    font-family: inherit;
    padding: 3px 7px 3px 8px;
    background: var(--surface-3);
    border: 1px solid transparent;
    border-radius: 5px;
    white-space: nowrap;
    cursor: pointer;
    transition: background var(--t-fast), border-color var(--t-fast), color var(--t-fast);
  }
  .ws-chip:hover {
    background: var(--surface-4);
    border-color: var(--border-strong);
    color: var(--text);
  }
  .ws-chip .d {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    flex-shrink: 0;
  }
  /* The project is the context, the workspace is the subject: the project name is
     dimmed so the eye lands on which workspace you are in. */
  .ws-chip .proj {
    color: var(--text-muted);
  }
  .ws-chip .sep {
    color: var(--text-ghost);
    margin: 0 3px;
  }
  /* A quiet sibling to the workspace chip: same height and radius, no accent dot, and
     it only takes colour once there is a PR to point at. */
  .pr-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 22px;
    padding: 0 8px;
    margin-left: 6px;
    border: 1px solid var(--border-2);
    border-radius: 6px;
    background: transparent;
    color: var(--text-3);
    font-size: 11.5px;
    cursor: pointer;
    transition:
      background 0.12s ease,
      color 0.12s ease,
      border-color 0.12s ease;
  }
  .pr-chip:hover {
    background: var(--surface-3);
    color: var(--text-1);
    border-color: var(--border-1);
  }
  .pr-chip.has-pr {
    color: var(--pr);
    border-color: color-mix(in srgb, var(--pr) 40%, transparent);
  }
  .pr-lbl {
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.01em;
  }

  .arrow {
    color: var(--text-ghost);
    margin: 0 2px;
  }
  .ag {
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* One pill, two halves: a track with a thumb, the way a segmented control works. The
     lit half is a rounded pill INSIDE the track, so it never has to line up with the
     track's own corners — and with a moving fill to mark the selection, a divider
     between the halves would only be a second line saying the same thing. */
  .mode-seg {
    display: flex;
    flex-shrink: 0;
    margin-left: 4px;
    padding: 2px;
    gap: 2px;
    border: 1px solid var(--border-strong);
    background: var(--surface-2);
    border-radius: 9px;
  }
  .seg {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 600;
    padding: 3px 9px;
    border-radius: 7px;
    cursor: pointer;
    transition: background 0.13s, color 0.13s;
  }
  .seg:hover {
    background: var(--surface-4);
    color: var(--text);
  }
  /* At rest the two halves are only words in a track, so a hairline keeps them from
     reading as one label. Any fill — hover or selection — already separates them, so
     the line steps out of the way rather than cutting through a rounded edge. */
  .seg + .seg::before {
    content: "";
    position: absolute;
    left: -2px;
    top: 3px;
    bottom: 3px;
    width: 1px;
    background: var(--border-strong);
    transition: opacity 0.13s;
  }
  .mode-seg:hover .seg + .seg::before,
  .mode-seg:has(.seg.on) .seg + .seg::before,
  .mode-seg:has(.seg:focus-visible) .seg + .seg::before {
    opacity: 0;
  }
  /* Same "you are here" treatment the nav group gives its active tab. */
  .seg.on {
    background: var(--accent-soft);
    color: var(--accent-bright);
  }
  .seg.on:hover {
    background: color-mix(in srgb, var(--accent) 20%, var(--surface-2));
  }
  /* Review stays quiet until an agent finishes a turn — the moment it exists to
     advertise. */
  .review-seg.pending {
    color: var(--accent-bright);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .rb-count {
    font-size: 10px;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 6px;
    background: var(--surface-4);
    color: var(--text-muted);
  }
  .review-seg.pending .rb-count,
  .review-seg.on .rb-count {
    background: color-mix(in srgb, var(--accent) 26%, transparent);
    color: var(--accent-bright);
  }
  @media (max-width: 820px) {
    .cb-lbl {
      display: none;
    }
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  /* Fills .main; toggled to display:none (not unmounted) when a page is shown. */
  .agents-view {
    flex: 1;
    min-height: 0;
    flex-direction: column;
  }
</style>
