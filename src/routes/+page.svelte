<script lang="ts">
  import { onMount } from "svelte";
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
  import TasksPage from "$lib/components/TasksPage.svelte";
  import HistoryPage from "$lib/components/HistoryPage.svelte";
  import NotesPage from "$lib/components/NotesPage.svelte";
  import DailyReport from "$lib/components/DailyReport.svelte";
  import SettingsPage from "$lib/components/SettingsPage.svelte";
  import SystemTerminalView from "$lib/components/SystemTerminalView.svelte";
  import Icon from "$lib/components/Icon.svelte";
  import { setMuted, installAudioUnlock } from "$lib/sound";

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

  let showNewWorkspace = $state(false);
  let newAgentWs = $state<string | null>(null);
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
      un.then((f) => f());
      unResize.then((f) => f()).catch(() => {});
      unClose.then((f) => f()).catch(() => {});
    };
  });

  // Hoisted (function declaration, like onKeydown) so the listener above can name it
  // for both add and remove.
  function recheckPaths() {
    void app.checkWorkspacePaths();
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
        else showNewWorkspace = true;
      } else if (shortcut.action === "split-pane-vertical") {
        if (app.activeWorkspaceId) app.splitFocused("row");
        else showNewWorkspace = true;
      } else if (shortcut.action === "split-pane-horizontal") {
        if (app.activeWorkspaceId) app.splitFocused("col");
        else showNewWorkspace = true;
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

  /**
   * Workspace picker on the titlebar chip.
   *
   * This is the only way to change workspace in the Code view, which has no sidebar —
   * so it lists every live workspace, with its accent dot, and offers the new-workspace
   * dialog at the bottom.
   */
  function showWorkspaceMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: MenuItem[] = app.liveWorkspaces.map((w) => ({
      label: w.name,
      color: w.color,
      checked: w.id === app.activeWorkspaceId,
      onSelect: () => app.setActiveWorkspace(w.id),
    }));
    items.push({
      label: "New workspace…",
      separatorBefore: true,
      onSelect: () => (showNewWorkspace = true),
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
        if (!cancelled) changedPaths = st.changes.map((c) => c.path);
      } catch {
        if (!cancelled) changedPaths = null;
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
    else showNewWorkspace = true;
  }
</script>

<div class="app">
  <header class="titlebar" class:fullscreen={isFullscreen} data-tauri-drag-region>
    <span class="brand">Codesu</span>

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
      <span class="crumbs">
        <button
          class="ws-chip"
          style="--accent:{app.activeWorkspace.color}"
          title="Switch workspace"
          onclick={showWorkspaceMenu}
        >
          <span class="d"></span>{app.activeWorkspace.name}
          <Icon name="chevronDown" size={12} />
        </button>
        {#if view === "agents" && app.activeAgent}<span class="arrow">›</span><span class="ag"
            >{app.activeAgent.name}</span
          >{/if}
      </span>
    {/if}
    <!--
      Code and Review sit together at the end of the titlebar rather than in the nav
      group: both take over the whole window (no agent rail), so they read as modes you
      enter next to the workspace they apply to — not as two tabs among seven. Neither
      has anything to act on outside the workspace views, so both go with them.
    -->
    {#if inWorkspaceView}
      {#if changedPaths}
        <button
          class="code-btn review-btn"
          class:on={view === "review"}
          class:pending={freshTurn && view !== "review"}
          aria-pressed={view === "review"}
          title={changedPaths.length === 0
            ? "Review changes — working tree clean"
            : `Review ${changedPaths.length} changed file${changedPaths.length === 1 ? "" : "s"}` +
              (unreviewed > 0 ? ` · ${unreviewed} not yet reviewed` : " · all reviewed")}
          onclick={() => (view === "review" ? closeReview() : openReview())}
        >
          <Icon name="diff" size={14} /><span class="cb-lbl">Review</span>
          {#if changedPaths.length}<span class="rb-count">{changedPaths.length}</span>{/if}
        </button>
      {/if}
      <button
        class="code-btn"
        class:on={view === "code"}
        aria-pressed={view === "code"}
        title={view === "code" ? "Close Code (⌘E)" : "Code (⌘E)"}
        onclick={toggleCode}
      >
        <Icon name="code2" size={14} /><span class="cb-lbl">Code</span>
      </button>
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
        onNewWorkspace={() => (showNewWorkspace = true)}
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

{#if showNewWorkspace}
  <NewWorkspaceDialog
    onClose={() => (showNewWorkspace = false)}
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
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.4px;
    color: var(--text);
    display: flex;
    align-items: center;
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
  .code-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    margin-left: 4px;
    border: 1px solid var(--border-strong);
    background: var(--surface-3);
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 600;
    padding: 4px 9px;
    border-radius: 7px;
    cursor: pointer;
    transition: background 0.13s, color 0.13s, border-color 0.13s;
  }
  .code-btn:hover {
    background: var(--surface-4);
    border-color: var(--accent);
    color: var(--accent-bright);
  }
  /* Same "you are here" treatment the nav group gives its active tab. */
  .code-btn.on {
    background: var(--accent-soft);
    border-color: var(--accent-line);
    color: var(--accent-bright);
  }
  /* Review is the quieter of the pair until an agent finishes a turn — the moment it
     exists to advertise. */
  .review-btn {
    background: var(--surface-2);
    color: var(--text-muted);
  }
  .review-btn.pending {
    color: var(--accent-bright);
    border-color: color-mix(in srgb, var(--accent) 55%, transparent);
    background: color-mix(in srgb, var(--accent) 12%, var(--surface-2));
  }
  .rb-count {
    font-size: 10px;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 6px;
    background: var(--surface-4);
    color: var(--text-muted);
  }
  .review-btn.pending .rb-count,
  .review-btn.on .rb-count {
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
