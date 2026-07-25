<script lang="ts">
  import { onMount } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import { invoke } from "@tauri-apps/api/core";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { app } from "$lib/store/app.svelte";
  import ContextMenu, { type MenuItem } from "$lib/components/ContextMenu.svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import TabBar from "$lib/components/TabBar.svelte";
  import TerminalArea from "$lib/components/TerminalArea.svelte";
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

  type View = "agents" | "tasks" | "notes" | "report" | "history" | "settings" | "terminal";
  let view = $state<View>("agents");

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

  // "Open in editor" dropdown (Agents view only).
  let editorMenu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);

  // Brand logos for the dropdown items.
  const VSCODE_LOGO = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#0098FF" d="M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z"/></svg>`;
  // Official IntelliJ IDEA icon (Wikimedia Commons).
  const INTELLIJ_LOGO = `<svg viewBox="0 0 70 70" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><linearGradient id="ijeaG1" gradientUnits="userSpaceOnUse" x1="0.7898" y1="40.0893" x2="33.3172" y2="40.0893"><stop offset="0.2581" stop-color="#F97A12"/><stop offset="0.4591" stop-color="#B07B58"/><stop offset="0.7241" stop-color="#577BAE"/><stop offset="0.9105" stop-color="#1E7CE5"/><stop offset="1" stop-color="#087CFA"/></linearGradient><polygon fill="url(#ijeaG1)" points="17.7,54.6 0.8,41.2 9.2,25.6 33.3,35"/><linearGradient id="ijeaG2" gradientUnits="userSpaceOnUse" x1="25.7674" y1="24.88" x2="79.424" y2="54.57"><stop offset="0" stop-color="#F97A12"/><stop offset="0.0718" stop-color="#CB7A3E"/><stop offset="0.1541" stop-color="#9E7B6A"/><stop offset="0.242" stop-color="#757B91"/><stop offset="0.3344" stop-color="#537BB1"/><stop offset="0.4324" stop-color="#387CCC"/><stop offset="0.5381" stop-color="#237CE0"/><stop offset="0.6552" stop-color="#147CEF"/><stop offset="0.7925" stop-color="#0B7CF7"/><stop offset="1" stop-color="#087CFA"/></linearGradient><polygon fill="url(#ijeaG2)" points="70,18.7 68.7,59.2 41.8,70 25.6,59.6 49.3,35 38.9,12.3 48.2,1.1"/><linearGradient id="ijeaG3" gradientUnits="userSpaceOnUse" x1="63.2277" y1="42.9153" x2="48.2903" y2="-1.7191"><stop offset="0" stop-color="#FE315D"/><stop offset="0.0784" stop-color="#CB417E"/><stop offset="0.1601" stop-color="#9E4E9B"/><stop offset="0.2474" stop-color="#755BB4"/><stop offset="0.3392" stop-color="#5365CA"/><stop offset="0.4365" stop-color="#386DDB"/><stop offset="0.5414" stop-color="#2374E9"/><stop offset="0.6576" stop-color="#1478F3"/><stop offset="0.794" stop-color="#0B7BF8"/><stop offset="1" stop-color="#087CFA"/></linearGradient><polygon fill="url(#ijeaG3)" points="70,18.7 48.7,43.9 38.9,12.3 48.2,1.1"/><linearGradient id="ijeaG4" gradientUnits="userSpaceOnUse" x1="10.7204" y1="16.473" x2="55.5237" y2="90.58"><stop offset="0" stop-color="#FE315D"/><stop offset="0.0402" stop-color="#F63462"/><stop offset="0.1037" stop-color="#DF3A71"/><stop offset="0.1667" stop-color="#C24383"/><stop offset="0.2912" stop-color="#AD4A91"/><stop offset="0.5498" stop-color="#755BB4"/><stop offset="0.9175" stop-color="#1D76ED"/><stop offset="1" stop-color="#087CFA"/></linearGradient><polygon fill="url(#ijeaG4)" points="33.7,58.1 5.6,68.3 10.1,52.5 16,33.1 0,27.7 10.1,0 32.1,2.7 53.7,27.4"/><rect x="13.7" y="13.5" fill="#000000" width="43.2" height="43.2"/><rect x="17.7" y="48.6" fill="#FFFFFF" width="16.2" height="2.7"/><polygon fill="#FFFFFF" points="29.4,22.4 29.4,19.1 20.4,19.1 20.4,22.4 23,22.4 23,33.7 20.4,33.7 20.4,37 29.4,37 29.4,33.7 26.9,33.7 26.9,22.4"/><path fill="#FFFFFF" d="M38,37.3c-1.4,0-2.6-0.3-3.5-0.8c-0.9-0.5-1.7-1.2-2.3-1.9l2.5-2.8c0.5,0.6,1,1,1.5,1.3c0.5,0.3,1.1,0.5,1.7,0.5c0.7,0,1.3-0.2,1.8-0.7c0.4-0.5,0.6-1.2,0.6-2.3V19.1h4v11.7c0,1.1-0.1,2-0.4,2.8c-0.3,0.8-0.7,1.4-1.3,2c-0.5,0.5-1.2,1-2,1.2C39.8,37.1,39,37.3,38,37.3"/></svg>`;

  async function openInEditor(editor: "vscode" | "intellij") {
    const ws = app.activeWorkspace;
    if (!ws) return;
    try {
      await invoke("open_in_editor", { path: ws.path, editor });
    } catch (e) {
      console.error("[Codesu] open_in_editor failed", e);
      alert(
        `Couldn't open ${editor === "vscode" ? "VS Code" : "IntelliJ IDEA"}.\n\n${e}`,
      );
    }
  }

  function showEditorMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    editorMenu = {
      x: Math.min(r.left, window.innerWidth - 210),
      y: r.bottom + 4,
      items: [
        { label: "Open in VS Code", iconSvg: VSCODE_LOGO, onSelect: () => openInEditor("vscode") },
        { label: "Open in IntelliJ IDEA", iconSvg: INTELLIJ_LOGO, onSelect: () => openInEditor("intellij") },
      ],
    };
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
      <button class="nav-btn" class:on={view === "agents"} onclick={() => (view = "agents")} title="Agents">
        <Icon name="agents" size={15} /><span class="nav-lbl">Agents</span>
      </button>
      <button class="nav-btn" class:on={view === "tasks"} onclick={() => (view = "tasks")} title="Tasks">
        <Icon name="tasks" size={15} /><span class="nav-lbl">Tasks</span>
        {#if app.openTaskCount > 0}<span class="nav-badge">{app.openTaskCount}</span>{/if}
      </button>
      <button class="nav-btn" class:on={view === "notes"} onclick={() => (view = "notes")} title="Notes">
        <Icon name="notes" size={15} /><span class="nav-lbl">Notes</span>
        {#if app.ideaList.length > 0}<span class="nav-badge muted">{app.ideaList.length}</span>{/if}
      </button>
      <button class="nav-btn" class:on={view === "report"} onclick={() => (view = "report")} title="Daily Report (⌘R)">
        <Icon name="clipboard" size={15} /><span class="nav-lbl">Report</span>
      </button>
      <button class="nav-btn" class:on={view === "history"} onclick={() => (view = "history")} title="History (⌘H)">
        <Icon name="archive" size={15} /><span class="nav-lbl">History</span>
      </button>
      <button class="nav-btn" class:on={view === "settings"} onclick={() => (view = "settings")} title="Settings (⌘,)">
        <Icon name="settings" size={15} /><span class="nav-lbl">Settings</span>
      </button>
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
    {#if view === "agents" && app.activeWorkspace}
      <span class="crumbs">
        <span class="ws-chip" style="--accent:{app.activeWorkspace.color}">
          <span class="d"></span>{app.activeWorkspace.name}
        </span>
        {#if app.activeAgent}<span class="arrow">›</span><span class="ag">{app.activeAgent.name}</span>{/if}
      </span>
      <button class="open-editor" title="Open workspace in an editor" onclick={showEditorMenu}>
        <Icon name="open" size={14} /><span class="oe-lbl">Open in editor</span>
        <Icon name="chevronDown" size={13} />
      </button>
    {/if}
  </header>

  <div class="body">
    <!-- The workspace/agent rail belongs to the Agents view only. -->
    {#if view === "agents"}
      <Sidebar onNewWorkspace={() => (showNewWorkspace = true)} onNewAgent={openNewAgent} />
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
{#if editorMenu}
  <ContextMenu x={editorMenu.x} y={editorMenu.y} items={editorMenu.items} onClose={() => (editorMenu = null)} />
{/if}

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
  .nav-btn:hover {
    color: var(--text-secondary);
    background: var(--surface-3);
  }
  .nav-btn.on {
    background: var(--accent-soft);
    color: var(--accent-bright);
    box-shadow: inset 0 0 0 1px var(--accent-softer);
  }
  .nav-badge {
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    display: grid;
    place-items: center;
    border-radius: 8px;
    background: var(--accent);
    color: var(--accent-fg);
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
    padding: 2px 8px;
    background: var(--surface-3);
    border-radius: 5px;
    white-space: nowrap;
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
  .open-editor {
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
  .open-editor:hover {
    background: var(--surface-4);
    border-color: var(--accent);
    color: var(--accent-bright);
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
