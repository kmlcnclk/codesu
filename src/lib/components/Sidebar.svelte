<script lang="ts">
  import { flip } from "svelte/animate";
  import {
    app,
    TASK_META,
    TASK_STATUSES,
    STATE_META,
    type Workspace,
    type Agent,
  } from "$lib/store/app.svelte";
  import ContextMenu, { type MenuItem } from "./ContextMenu.svelte";
  import Icon from "./Icon.svelte";

  let {
    onNewWorkspace,
    onNewAgent,
    onOpenCode,
  }: {
    onNewWorkspace: () => void;
    onNewAgent: (workspaceId: string) => void;
    /** Open this workspace in the built-in Code view. */
    onOpenCode?: (workspaceId: string) => void;
  } = $props();

  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);

  // Pointer-based drag reorder for workspaces (HTML5 DnD is unreliable in the
  // webview; pointer events are not, and let us show a grab/grabbing cursor).
  let wsDragId = $state<string | null>(null);
  let wsDragMoved = $state(false);
  let startY = 0;
  let wsLastIdx = -1;
  let suppressClick = false;

  // Inline rename: exactly one of these is set while its input is open.
  let editingWsId = $state<string | null>(null);
  let editingAgentId = $state<string | null>(null);
  let editValue = $state("");

  function startRenameWs(ws: Workspace) {
    editingAgentId = null;
    editingWsId = ws.id;
    editValue = ws.name;
  }
  function startRenameAgent(agent: Agent) {
    editingWsId = null;
    editingAgentId = agent.id;
    editValue = agent.name;
  }
  function commitWs(id: string) {
    app.renameWorkspace(id, editValue);
    editingWsId = null;
  }
  function commitAgent(id: string) {
    app.renameAgent(id, editValue);
    editingAgentId = null;
  }
  function cancelEdit() {
    editingWsId = null;
    editingAgentId = null;
  }
  function editKey(e: KeyboardEvent, commit: () => void) {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  }
  /** Focus + select the rename field the moment it appears. */
  function selectOnMount(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  function wsMenu(e: MouseEvent, ws: Workspace) {
    e.preventDefault();
    app.setActiveWorkspace(ws.id);
    menu = {
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Open in Codesu editor", onSelect: () => onOpenCode?.(ws.id) },
        { label: "Rename workspace", separatorBefore: true, onSelect: () => startRenameWs(ws) },
        { label: "New Claude agent", color: "var(--accent)", separatorBefore: true, onSelect: () => app.addAgent({ workspaceId: ws.id, kind: "claude", run: "claude" }) },
        { label: "New agent…", onSelect: () => onNewAgent(ws.id) },
        { label: "Archive workspace", danger: true, separatorBefore: true, onSelect: () => app.archiveWorkspace(ws.id) },
      ],
    };
  }

  function agentMenu(e: MouseEvent, agent: Agent) {
    e.preventDefault();
    const items: MenuItem[] = [
      { label: "Rename agent", onSelect: () => startRenameAgent(agent) },
    ];
    TASK_STATUSES.forEach((s, idx) =>
      items.push({
        label: TASK_META[s].label,
        color: TASK_META[s].color,
        checked: app.effectiveLane(agent) === s,
        separatorBefore: idx === 0,
        onSelect: () => app.setAgentLane(agent.id, s),
      }),
    );
    items.push({ label: "Close agent", danger: true, separatorBefore: true, onSelect: () => app.removeAgent(agent.id) });
    menu = { x: e.clientX, y: e.clientY, items };
  }

  function wsPointerDown(e: PointerEvent, ws: Workspace) {
    if (e.button !== 0 || editingWsId) return;
    wsDragId = ws.id;
    startY = e.clientY;
    wsDragMoved = false;
    wsLastIdx = -1;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function wsPointerMove(e: PointerEvent) {
    if (wsDragId === null) return;
    if (!wsDragMoved && Math.abs(e.clientY - startY) < 4) return;
    wsDragMoved = true;
    // Insertion slot = how many *other* rows sit above the cursor's center.
    const others = Array.from(
      document.querySelectorAll<HTMLElement>(".ws-list .ws"),
    ).filter((el) => el.dataset.id !== wsDragId);
    let idx = 0;
    for (const el of others) {
      const r = el.getBoundingClientRect();
      if (e.clientY > r.top + r.height / 2) idx++;
    }
    // Only reorder when the slot actually changes (avoids per-frame churn/lag).
    if (idx === wsLastIdx) return;
    wsLastIdx = idx;
    app.moveWorkspaceToIndex(wsDragId, idx);
  }
  function wsPointerUp(e: PointerEvent) {
    if (wsDragId === null) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be gone */
    }
    if (wsDragMoved) suppressClick = true;
    wsDragId = null;
    wsDragMoved = false;
  }
  function wsClick(ws: Workspace) {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (editingWsId !== ws.id) app.setActiveWorkspace(ws.id);
  }

  // ---- resizing: sidebar width + the workspaces/agents vertical split ----
  let sidebarEl = $state<HTMLElement | null>(null);
  let listsEl = $state<HTMLElement | null>(null);

  /** Drag the right edge to resize the whole rail. */
  function widthPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = app.sidebarWidth;
    const move = (ev: PointerEvent) => app.setSidebarWidth(startW + (ev.clientX - startX));
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
      } catch {
        /* capture may already be gone */
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /** Drag the divider between Workspaces and Agents to re-split their heights. */
  function splitPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (!listsEl) return;
      const r = listsEl.getBoundingClientRect();
      if (r.height <= 0) return;
      app.setWorkspacesRatio((ev.clientY - r.top) / r.height);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
      } catch {
        /* capture may already be gone */
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
</script>

<aside class="sidebar" bind:this={sidebarEl} style="width:{app.sidebarWidth}px">
  <div class="lists" bind:this={listsEl}>
  <!-- Workspaces (top) -->
  <section class="group workspaces" style="flex:{app.workspacesRatio} 1 0">
    <header class="group-head">
      <span class="group-title">Workspaces</span>
      <button class="add" title="New workspace" onclick={onNewWorkspace} aria-label="New workspace">
        <Icon name="plus" size={14} />
      </button>
    </header>

    <ul class="list ws-list">
      {#each app.liveWorkspaces as ws (ws.id)}
        {@const editing = editingWsId === ws.id}
        {@const missing = app.isPathMissing(ws.path)}
        <li animate:flip={{ duration: 160 }}>
          <button
            class="ws"
            class:active={ws.id === app.activeWorkspaceId}
            class:missing
            class:dragging={wsDragId === ws.id && wsDragMoved}
            title={missing ? `Folder not found: ${ws.path}` : undefined}
            data-id={ws.id}
            style="--accent:{ws.color}"
            onpointerdown={(e) => wsPointerDown(e, ws)}
            onpointermove={wsPointerMove}
            onpointerup={wsPointerUp}
            onpointercancel={wsPointerUp}
            onclick={() => wsClick(ws)}
            ondblclick={() => startRenameWs(ws)}
            oncontextmenu={(e) => wsMenu(e, ws)}
          >
            <span class="bar"></span>
            <!-- A missing folder replaces the folder/branch glyph: its agents cannot be
                 launched at all, so it needs to read as broken at a glance. -->
            <span class="ws-icon">
              <Icon name={missing ? "alert" : ws.isWorktree ? "branch" : "folder"} size={14} />
            </span>
            <span class="ws-label">
              {#if editing}
                <input
                  class="rename-input"
                  bind:value={editValue}
                  use:selectOnMount
                  onclick={(e) => e.stopPropagation()}
                  ondblclick={(e) => e.stopPropagation()}
                  onpointerdown={(e) => e.stopPropagation()}
                  onkeydown={(e) => {
                    e.stopPropagation();
                    editKey(e, () => commitWs(ws.id));
                  }}
                  onblur={() => commitWs(ws.id)}
                />
              {:else}
                <span class="ws-name">{ws.name}</span>
                <span class="ws-sub">
                  {missing ? "folder missing" : (ws.branch ?? ws.path.split("/").slice(-1)[0])}
                </span>
              {/if}
            </span>
            {#if !editing}
              {#if app.attentionCountOf(ws.id) > 0}
                <span class="pip" title="Agents awaiting you">{app.attentionCountOf(ws.id)}</span>
              {:else if app.countOf(ws.id) > 0}
                <span class="count" style="background:{ws.color}22; color:{ws.color}">
                  {app.countOf(ws.id)}
                </span>
              {/if}
            {/if}
          </button>
        </li>
      {/each}

      {#if app.liveWorkspaces.length === 0}
        <li class="hint">No workspaces. Click + to add one.</li>
      {/if}
    </ul>
  </section>

  <!-- Draggable divider: re-splits Workspaces vs Agents heights. -->
  <div
    class="v-resize"
    role="separator"
    aria-orientation="horizontal"
    aria-label="Resize workspaces and agents sections"
    title="Drag to resize"
    onpointerdown={splitPointerDown}
    ondblclick={() => app.setWorkspacesRatio(0.42)}
  >
    <span class="grip-line"></span>
  </div>

  <!-- Agents (bottom) -->
  <section class="group agents" style="flex:{1 - app.workspacesRatio} 1 0">
    <header class="group-head">
      <span class="group-title">Agents</span>
      {#if app.activeWorkspaceId}
        <button class="add" title="New agent (⌘T)" onclick={() => onNewAgent(app.activeWorkspaceId!)} aria-label="New agent">
          <Icon name="plus" size={14} />
        </button>
      {/if}
    </header>

    <ul class="list">
      {#each app.activeRoster as agent (agent.id)}
        {@const meta = STATE_META[agent.state]}
        {@const taskMeta = TASK_META[app.effectiveLane(agent)]}
        {@const editing = editingAgentId === agent.id}
        {@const tabNo = app.activeTabGroups.findIndex((g) => g.groupId === agent.groupId) + 1}
        <!-- Row colour: live state (working=blue / done=green / blocked=red)
             overrides the kanban task colour; otherwise (idle/exited) the task
             status colour is shown. Backlog is the neutral default → no accent. -->
        {@const attn = agent.state === "working" || agent.state === "done" || agent.state === "blocked"}
        {@const rowColor = attn ? meta.color : taskMeta.color}
        {@const showAccent = attn || app.effectiveLane(agent) !== "backlog"}
        <li animate:flip={{ duration: 160 }}>
          <div
            class="agent"
            class:active={agent.id === app.activeAgent?.id}
            class:accent={showAccent}
            data-state={agent.state}
            style="--state:{meta.color}; --row:{rowColor}"
            role="button"
            tabindex="0"
            onclick={() => !editing && app.setActiveAgent(agent.id)}
            ondblclick={() => startRenameAgent(agent)}
            onkeydown={(e) => e.key === "Enter" && !editing && app.setActiveAgent(agent.id)}
            oncontextmenu={(e) => agentMenu(e, agent)}
          >
            <span class="sbar"></span>
            <!-- status glyph -->
            <span class="status" data-state={agent.state} aria-label={meta.label}>
              {#if agent.state === "working"}
                <span class="spinner"></span>
              {:else if agent.state === "done"}
                <span class="tick">✓</span>
              {:else if agent.state === "blocked"}
                <span class="bang">!</span>
              {:else if agent.state === "exited"}
                <span class="dash">–</span>
              {:else}
                <span class="idle-dot"></span>
              {/if}
            </span>

            <span class="ws-label">
              {#if editing}
                <input
                  class="rename-input"
                  bind:value={editValue}
                  use:selectOnMount
                  onclick={(e) => e.stopPropagation()}
                  ondblclick={(e) => e.stopPropagation()}
                  onpointerdown={(e) => e.stopPropagation()}
                  onkeydown={(e) => {
                    e.stopPropagation();
                    editKey(e, () => commitAgent(agent.id));
                  }}
                  onblur={() => commitAgent(agent.id)}
                />
              {:else}
                <span class="ws-name">{agent.name}</span>
                <span class="ws-sub state-sub" style="color:{meta.color}">
                  {#if agent.state === "working"}Working…
                  {:else if agent.state === "done"}Done · review
                  {:else if agent.state === "blocked"}Blocked · needs input
                  {:else if agent.state === "exited"}Exited
                  {:else}Idle · ready{/if}
                </span>
              {/if}
            </span>

            {#if !editing}
              {#if tabNo >= 1 && tabNo <= 9}<span class="kbd">⌘{tabNo}</span>{/if}
              <button
                class="close"
                title="Close agent"
                aria-label="Close agent"
                onclick={(e) => {
                  e.stopPropagation();
                  app.removeAgent(agent.id);
                }}><Icon name="close" size={13} /></button
              >
            {/if}
          </div>
        </li>
      {/each}

      {#if app.activeWorkspaceId && app.activeRoster.length === 0}
        <li class="hint">No agents. Press ⌘T or click +.</li>
      {/if}
      {#if !app.activeWorkspaceId}
        <li class="hint">Select a workspace to see its agents.</li>
      {/if}
    </ul>
  </section>
  </div>

  <!-- Draggable right edge: resizes the whole rail. -->
  <div
    class="x-resize"
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize sidebar"
    title="Drag to resize"
    onpointerdown={widthPointerDown}
    ondblclick={() => app.setSidebarWidth(268)}
  ></div>
</aside>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => (menu = null)} />
{/if}

<style>
  .sidebar {
    position: relative;
    flex-shrink: 0;
    background: var(--surface-1);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    /* The two lists scroll independently, so the sidebar itself never scrolls. */
    overflow: hidden;
    user-select: none;
  }
  /* Holds the two sections + the divider; the split ratio lives on the sections. */
  .lists {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .group {
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 6px 0;
  }
  /* Both sections' heights are driven by an inline flex ratio (app.workspacesRatio). */
  .group.agents {
    border-top: 1px solid var(--border-muted);
    min-height: 0;
  }

  /* Divider between the two sections — grab it to re-split their heights. */
  .v-resize {
    flex: 0 0 auto;
    height: 7px;
    margin-top: -4px;
    display: grid;
    place-items: center;
    cursor: row-resize;
    touch-action: none;
  }
  .v-resize .grip-line {
    width: 26px;
    height: 3px;
    border-radius: 2px;
    background: var(--border-strong);
    transition: background 0.12s ease, width 0.12s ease;
  }
  .v-resize:hover .grip-line {
    width: 40px;
    background: var(--accent);
  }

  /* Invisible hit-strip on the rail's right edge — grab it to resize the rail. */
  .x-resize {
    position: absolute;
    top: 0;
    right: 0;
    width: 6px;
    height: 100%;
    cursor: col-resize;
    touch-action: none;
    z-index: 5;
  }
  .x-resize:hover {
    background: color-mix(in srgb, var(--accent) 45%, transparent);
  }
  .group-head {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: space-between;
    padding: 9px 14px 7px;
  }
  .group-title {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .add {
    width: 22px;
    height: 22px;
    padding: 0;
    display: grid;
    place-items: center;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-3);
    color: var(--text-secondary);
    cursor: pointer;
    transition: all 0.14s;
  }
  .add:hover {
    background: var(--surface-4);
    border-color: var(--accent);
    color: var(--accent-bright);
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0 8px;
    display: flex;
    flex-direction: column;
    gap: 3px;
    /* Each section's rows scroll within the section, not the whole sidebar. */
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }

  /* ---- workspace rows ---- */
  .ws {
    position: relative;
    width: 100%;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 8px 10px 8px 12px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: var(--text-secondary);
    text-align: left;
    cursor: grab;
    overflow: hidden;
    touch-action: none;
    transition: background 0.12s ease, border-color 0.12s ease;
  }
  .ws .bar {
    position: absolute;
    left: 0;
    top: 6px;
    bottom: 6px;
    width: 3px;
    border-radius: 0 3px 3px 0;
    background: var(--accent);
    /* Faintly on for every row: the colour is the workspace's identity, not a selection
       cue, so it should be readable down the whole list — full strength when active. */
    opacity: 0.4;
    transition: opacity 0.14s;
  }
  .ws:hover {
    background: var(--surface-3);
  }
  .ws:hover .bar {
    opacity: 0.7;
  }
  .ws.active {
    background: color-mix(in srgb, var(--accent) 14%, var(--surface-2));
    border-color: color-mix(in srgb, var(--accent) 55%, transparent);
  }
  .ws.active .ws-name {
    color: color-mix(in srgb, var(--accent) 55%, var(--text));
  }
  .ws.active .bar {
    opacity: 1;
  }
  .ws.dragging {
    cursor: grabbing;
    background: var(--surface-4);
    border-color: color-mix(in srgb, var(--accent) 55%, transparent);
    box-shadow: var(--shadow-md);
    opacity: 0.95;
    z-index: 2;
  }
  .ws-icon {
    color: var(--accent, var(--text-faint));
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }
  /* Workspace whose folder is gone from disk — its agents can't be launched at all,
     so the row is dimmed and both the glyph and the subtitle turn to a warning. */
  .ws.missing {
    opacity: 0.72;
  }
  .ws.missing .ws-icon,
  .ws.missing .ws-sub {
    color: var(--danger, #ff6b6b);
  }
  .ws-label {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  .ws-name {
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ws-sub {
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .state-sub {
    font-weight: 500;
  }

  /* inline rename field */
  .rename-input {
    width: 100%;
    font-size: 13px;
    font-weight: 500;
    font-family: inherit;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--accent);
    border-radius: 6px;
    padding: 2px 6px;
    margin: -2px 0;
    outline: none;
    box-shadow: var(--ring);
  }

  .count {
    font-size: 11px;
    font-weight: 700;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    display: grid;
    place-items: center;
    border-radius: 9px;
  }
  /* Attention pip: a workspace has blocked/done agents waiting for you. */
  .pip {
    font-size: 11px;
    font-weight: 800;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    display: grid;
    place-items: center;
    border-radius: 9px;
    color: #fff;
    background: var(--danger-strong);
    box-shadow: 0 0 8px rgba(255, 95, 87, 0.6);
    animation: pip-pulse 1.6s ease-in-out infinite;
  }
  @keyframes pip-pulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.12); }
  }

  /* ---- agent rows ---- */
  .agent {
    position: relative;
    width: 100%;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 7px 8px 7px 10px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: var(--text-secondary);
    text-align: left;
    cursor: pointer;
    overflow: hidden;
    transition: background 0.12s ease, border-color 0.12s ease;
  }
  /* Accent bar in the row colour (--row): live state for working/done/blocked,
     otherwise the kanban task colour. Backlog (no .accent) shows no bar. */
  .agent .sbar {
    position: absolute;
    left: 0;
    top: 6px;
    bottom: 6px;
    width: 3px;
    border-radius: 0 3px 3px 0;
    background: var(--row);
    opacity: 0;
    transition: opacity 0.14s;
  }
  .agent.accent .sbar {
    opacity: 0.8;
  }
  .agent:hover {
    background: var(--surface-3);
  }
  .agent:hover.accent .sbar,
  .agent.active.accent .sbar {
    opacity: 1;
  }
  .agent.active {
    background: var(--surface-4);
    border-color: var(--border-strong);
  }
  /* Accented active rows take a faint wash + border in their row colour. */
  .agent.active.accent {
    background: color-mix(in srgb, var(--row) 12%, var(--surface-4));
    border-color: color-mix(in srgb, var(--row) 55%, transparent);
  }
  /* The name is tinted by the row colour when accented. */
  .agent.accent .ws-name {
    color: color-mix(in srgb, var(--row) 58%, var(--text));
    font-weight: 600;
  }

  .status {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    font-size: 11px;
    font-weight: 800;
  }
  /* working — rotating ring */
  .spinner {
    width: 13px;
    height: 13px;
    border-radius: 50%;
    border: 2px solid rgba(110, 139, 255, 0.25);
    border-top-color: var(--accent);
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  /* done — crisp green check with a tight ring (no heavy halo) */
  .tick {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--ok);
    color: #04140a;
    display: grid;
    place-items: center;
    font-size: 10px;
    font-weight: 900;
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent);
  }
  /* blocked — pulsing red */
  .bang {
    width: 15px;
    height: 15px;
    border-radius: 50%;
    background: var(--danger-strong);
    color: #2a0605;
    display: grid;
    place-items: center;
    font-size: 11px;
    animation: bang-pulse 1s ease-in-out infinite;
  }
  @keyframes bang-pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(255, 95, 87, 0.55); }
    50% { box-shadow: 0 0 0 5px rgba(255, 95, 87, 0); }
  }
  .idle-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: 1.5px solid var(--text-faint);
  }
  .dash {
    color: var(--text-faint);
  }

  .kbd {
    font-size: 9.5px;
    color: var(--text-faint);
    font-family: ui-monospace, monospace;
    flex-shrink: 0;
  }
  .close {
    width: 18px;
    height: 18px;
    padding: 0;
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    color: var(--text-faint);
    border-radius: 5px;
    cursor: pointer;
    opacity: 0;
    flex-shrink: 0;
    transition: color 0.13s, background 0.13s, opacity 0.13s;
  }
  .agent:hover .close,
  .agent.active .close {
    opacity: 1;
  }
  .close:hover {
    color: var(--danger);
    background: rgba(255, 107, 107, 0.12);
  }

  .hint {
    padding: 6px 12px;
    font-size: 12px;
    color: var(--text-ghost);
  }
</style>
