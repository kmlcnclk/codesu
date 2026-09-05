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

  /** Full state wording — carried by the row's tooltip, not a second line of text. */
  function stateText(state: Agent["state"]): string {
    if (state === "working") return "Working…";
    if (state === "done") return "Done · review";
    if (state === "blocked") return "Blocked · needs input";
    if (state === "exited") return "Exited";
    return "Idle · ready";
  }

  /** The panel's own menu, hung off the title — the IDE's "Project ⌄" affordance. */
  function headerMenu(e: MouseEvent) {
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    menu = {
      x: r.left,
      y: r.bottom + 4,
      items: [
        { label: "New workspace…", onSelect: onNewWorkspace },
        { label: "Expand all", separatorBefore: true, onSelect: () => app.setAllWorkspacesCollapsed(false) },
        { label: "Collapse all", onSelect: () => app.setAllWorkspacesCollapsed(true) },
      ],
    };
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
  /**
   * A click selects the workspace. Clicking the one you are already on folds it —
   * standard tree behaviour, and it makes the twisty a shortcut rather than the
   * only way to collapse something.
   */
  function wsClick(ws: Workspace) {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (editingWsId === ws.id) return;
    if (ws.id === app.activeWorkspaceId) {
      app.toggleWorkspaceCollapsed(ws.id);
      return;
    }
    app.setActiveWorkspace(ws.id);
    app.expandWorkspace(ws.id);
  }

  // ---- keyboard: the rail behaves like a tree, not a stack of buttons ----
  let listEl = $state<HTMLElement | null>(null);

  /** Move focus to the previous/next visible row (workspaces and agents alike). */
  function moveFocus(delta: 1 | -1) {
    if (!listEl) return;
    const rows = Array.from(listEl.querySelectorAll<HTMLElement>("[data-row]"));
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = rows[at < 0 ? (delta === 1 ? 0 : rows.length - 1) : at + delta];
    next?.focus();
  }

  function wsKey(e: KeyboardEvent, ws: Workspace) {
    if (editingWsId === ws.id) return;
    switch (e.key) {
      case "Enter":
        e.preventDefault();
        app.setActiveWorkspace(ws.id);
        break;
      case "ArrowRight":
        e.preventDefault();
        app.expandWorkspace(ws.id);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (!app.wsCollapsed[ws.id]) app.toggleWorkspaceCollapsed(ws.id);
        break;
      case "ArrowDown":
        e.preventDefault();
        moveFocus(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveFocus(-1);
        break;
    }
  }

  function agentKey(e: KeyboardEvent, agent: Agent) {
    if (editingAgentId === agent.id) return;
    switch (e.key) {
      case "Enter":
        e.preventDefault();
        app.setActiveAgent(agent.id);
        break;
      case "ArrowDown":
        e.preventDefault();
        moveFocus(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveFocus(-1);
        break;
      case "ArrowLeft":
        // Left on a child jumps to its parent row, as in any file tree.
        e.preventDefault();
        listEl?.querySelector<HTMLElement>(`.ws[data-id="${agent.workspaceId}"]`)?.focus();
        break;
    }
  }

  // ---- resizing: sidebar width ----
  let sidebarEl = $state<HTMLElement | null>(null);

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
</script>

<!--
  One tree: workspaces at the root, their agents nested underneath.

  Colour follows app.css's own rule, which the old rail broke in five places at
  once. A hue is IDENTITY — here exactly one mark per workspace (its glyph),
  inherited as a hairline by its agents' guide. Status colours keep their
  MEANING — only a working / done / blocked agent gets one. Selection is the
  IDE's own selected-row wash (--accent-soft), so "what is selected" never has
  to compete with "which project is this".
-->
<aside class="sidebar" bind:this={sidebarEl} style="width:{app.sidebarWidth}px">
  <section class="group">
    <header class="group-head">
      <button class="group-title" onclick={headerMenu} title="Workspaces panel">
        Workspaces
        <Icon name="chevronDown" size={13} />
      </button>
      <button class="add" title="New workspace" onclick={onNewWorkspace} aria-label="New workspace">
        <Icon name="plus" size={15} />
      </button>
    </header>

    <ul class="list ws-list" bind:this={listEl}>
      {#each app.liveWorkspaces as ws (ws.id)}
        {@const editing = editingWsId === ws.id}
        {@const missing = app.isPathMissing(ws.path)}
        {@const roster = app.rosterOf(ws.id)}
        {@const open = !app.wsCollapsed[ws.id]}
        {@const attention = app.attentionCountOf(ws.id)}
        {@const selected = ws.id === app.activeWorkspaceId}
        {@const holdsSelection = selected && !!app.activeAgent}
        <li class="node" class:holds-selection={holdsSelection} animate:flip={{ duration: 160 }}>
          <div
            class="ws"
            class:selected={selected && !app.activeAgent}
            class:missing
            class:dragging={wsDragId === ws.id && wsDragMoved}
            title={missing ? `Folder not found: ${ws.path}` : ws.name}
            data-id={ws.id}
            data-row
            role="treeitem"
            aria-expanded={open}
            aria-selected={selected}
            tabindex="0"
            onpointerdown={(e) => wsPointerDown(e, ws)}
            onpointermove={wsPointerMove}
            onpointerup={wsPointerUp}
            onpointercancel={wsPointerUp}
            onclick={() => wsClick(ws)}
            ondblclick={() => startRenameWs(ws)}
            onkeydown={(e) => wsKey(e, ws)}
            oncontextmenu={(e) => wsMenu(e, ws)}
          >
            <span class="twisty" class:open aria-hidden="true">
              <Icon name="chevronDown" size={13} />
            </span>
            <!--
              The workspace's hue lives here and nowhere else on the row: one
              small mark, favicon-sized, which is what a hue is for. A missing
              folder overrides it — those agents cannot launch, so it reads broken.
            -->
            <span class="ws-icon" style={missing ? undefined : `color:${ws.color}`}>
              <Icon name={missing ? "alert" : ws.isWorktree ? "branch" : "folder"} size={15} />
            </span>

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
              <!--
                A badge is only in the layout when there IS one, and the count is
                dropped while the workspace is open, since its agents are right
                there to count.
              -->
              {#if attention > 0}
                <span class="badge pip" title="{attention} agent(s) awaiting you">{attention}</span>
              {:else if !open && roster.length > 0}
                <span class="badge count">{roster.length}</span>
              {/if}
              <!--
                Hover actions OVERLAY the end of the row instead of reserving a
                column, so at a narrow rail the full name is what you see; the
                fade keeps the button legible over the text it covers. Reserving
                that column is what chopped "hiccup-backend" into "hiccup-b…".
              -->
              <span class="row-actions">
                <button
                  class="act"
                  title="New agent in {ws.name}"
                  aria-label="New agent in {ws.name}"
                  onpointerdown={(e) => e.stopPropagation()}
                  onclick={(e) => {
                    e.stopPropagation();
                    app.expandWorkspace(ws.id);
                    onNewAgent(ws.id);
                  }}
                >
                  <Icon name="plus" size={14} />
                </button>
              </span>
            {/if}
          </div>

          {#if open && !editing}
            <!-- The guide inherits the workspace's hue at 22%: enough to tie a run
                 of agents to its parent, far too quiet to read as decoration. -->
            <ul class="agent-list" style="--ws-hue:{ws.color}">
              {#each roster as agent (agent.id)}
                {@const meta = STATE_META[agent.state]}
                {@const aEditing = editingAgentId === agent.id}
                {@const isActive = agent.id === app.activeAgent?.id}
                <!-- ⌘1–9 address the ACTIVE workspace's tabs only, so the hint
                     appears on that workspace's rows only. -->
                {@const tabNo =
                  ws.id === app.activeWorkspaceId
                    ? app.activeTabGroups.findIndex((g) => g.groupId === agent.groupId) + 1
                    : 0}
                <li animate:flip={{ duration: 160 }}>
                  <div
                    class="agent"
                    class:selected={isActive}
                    data-state={agent.state}
                    data-row
                    role="treeitem"
                    aria-selected={isActive}
                    tabindex="0"
                    title={aEditing ? undefined : `${agent.name} — ${stateText(agent.state)}`}
                    onclick={() => !aEditing && app.setActiveAgent(agent.id)}
                    ondblclick={() => startRenameAgent(agent)}
                    onkeydown={(e) => agentKey(e, agent)}
                    oncontextmenu={(e) => agentMenu(e, agent)}
                  >
                    <!-- The tree's only status colour: idle and exited agents are
                         deliberately colourless, so a coloured dot always means
                         "this one wants you". -->
                    <span class="status" style="--state:{meta.color}" aria-label={meta.label}>
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

                    {#if aEditing}
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
                      <span
                        class="agent-name"
                        class:attn={agent.state === "blocked" || agent.state === "done"}
                      >{agent.name}</span>
                      {#if tabNo >= 1 && tabNo <= 9}<span class="kbd">⌘{tabNo}</span>{/if}
                      <span class="row-actions">
                        <button
                          class="act danger"
                          title="Close agent"
                          aria-label="Close agent"
                          onclick={(e) => {
                            e.stopPropagation();
                            app.removeAgent(agent.id);
                          }}
                        >
                          <Icon name="close" size={14} />
                        </button>
                      </span>
                    {/if}
                  </div>
                </li>
              {/each}

              {#if roster.length === 0}
                <li class="empty">
                  <button class="empty-btn" onclick={() => onNewAgent(ws.id)}>
                    <Icon name="plus" size={12} /> New agent
                  </button>
                </li>
              {/if}
            </ul>
          {/if}
        </li>
      {/each}

      {#if app.liveWorkspaces.length === 0}
        <li class="hint">No workspaces. Click + to add one.</li>
      {/if}
    </ul>
  </section>

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
    overflow: hidden;
    user-select: none;
  }
  .group {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding-bottom: 8px;
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
    padding: 8px 8px 8px 10px;
  }
  /* A panel title, not a micro-label: sentence case at reading size with the
     panel's own menu hung off it, the way a tool window is titled in the IDE. */
  .group-title {
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 3px 5px 3px 4px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    font-family: inherit;
    font-size: 13.5px;
    font-weight: 600;
    color: var(--text);
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }
  .group-title :global(svg) {
    color: var(--text-faint);
  }
  .group-title:hover {
    background: var(--surface-3);
  }
  .add {
    width: 24px;
    height: 24px;
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
    color: var(--text);
  }

  .list {
    list-style: none;
    margin: 0;
    gap: 3px;
    /* A hair of clearance on both sides so a row's highlight reads as its own
       rounded shape rather than as a band clipped by the panel's edges.
       Indentation lives in each row's padding, so a nested row's highlight still
       spans the same width as a top-level one. */
    padding: 0 4px;
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .node {
    display: flex;
    flex-direction: column;
  }
  /* A break before the next workspace, none between a workspace and its own
     agents: whitespace does the grouping, so the indent can stay shallow and
     names keep their width. */
  .node + .node {
    margin-top: 6px;
  }

  /* ---- shared row shell ---- */
  .ws,
  .agent {
    position: relative;
    width: 100%;
    display: flex;
    align-items: center;
    gap: 4px;
    border: 0;
    /* Rounded at both ends: every row is a self-contained shape. */
    border-radius: 7px;
    background: transparent;
    color: var(--text-secondary);
    text-align: left;
    overflow: hidden;
    outline: none;
  }
  /* An outline, not a box-shadow: the shadow is the selected row's edge marker. */
  .ws:focus-visible,
  .agent:focus-visible {
    outline: 1px solid var(--accent-line);
    outline-offset: -1px;
  }
  .ws:hover,
  .agent:hover {
    background: var(--surface-3);
  }
  /*
   * Exactly ONE row in the tree is filled. Nothing else takes a wash, so the fill
   * plus a full-contrast label is the whole selection signal — the parent branch
   * is marked in a different currency (see below) precisely so a second tinted
   * band never sits against this one and blurs which row is selected.
   */
  .ws.selected,
  .agent.selected {
    background: var(--accent-soft);
  }
  .ws.selected .ws-name,
  .agent.selected .agent-name {
    color: var(--text);
    font-weight: 600;
  }
  /*
   * The branch that CONTAINS the selection is marked in a different currency —
   * a lit guide line and a brighter label, no fill at all. Same information,
   * zero competition with the filled row. The guide brightens in the WORKSPACE's
   * own hue rather than switching to the accent: the line's colour is the
   * workspace's identity, and identity must not change because of focus.
   */
  .node.holds-selection .agent-list::before {
    background: color-mix(in srgb, var(--ws-hue) 55%, transparent);
  }
  .node.holds-selection > .ws .ws-name {
    color: var(--text);
  }
  .node.holds-selection > .ws .ws-icon {
    color: var(--text-secondary);
  }

  /* ---- workspace row ---- */
  .ws {
    height: 32px;
    padding: 0 4px 0 8px;
    cursor: grab;
    touch-action: none;
  }
  .ws.dragging {
    cursor: grabbing;
    background: var(--surface-4);
    box-shadow: var(--shadow-md);
    opacity: 0.95;
    z-index: 2;
  }
  .ws-name {
    flex: 1;
    min-width: 0;
    font-size: 13.5px;
    font-weight: 600;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Folder gone from disk — its agents cannot launch, so the row reads broken. */
  .ws.missing .ws-name {
    color: var(--text-faint);
  }
  .ws.missing .ws-icon {
    color: var(--danger, #ff6b6b);
  }
  .ws-icon {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
  }

  /* Fold arrow: 13px of ink, the full row height as hit area. */
  .twisty {
    width: 14px;
    height: 100%;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    color: var(--text-ghost);
    transform: rotate(-90deg);
    transition: transform 0.13s ease, color 0.12s ease;
  }
  .twisty.open {
    transform: rotate(0deg);
  }
  .ws:hover .twisty {
    color: var(--text-muted);
  }

  /* ---- agent rows ---- */
  .agent-list {
    position: relative;
    list-style: none;
    /* Sits a touch below its workspace row, and its own rows are spaced like the
       top-level ones — separate pills read as separate rows. */
    margin: 3px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  /* The guide is drawn, not bordered, so the rows themselves stay full-bleed. It
     carries the parent workspace's hue at 22% — enough to tie a run of agents to
     its parent, far too quiet to read as decoration. */
  .agent-list::before {
    content: "";
    position: absolute;
    left: 15px;
    top: 2px;
    bottom: 2px;
    width: 1px;
    /* Above the rows: a row's hover / selection fill spans the full width and was
       painting over the guide, so the line broke wherever the pointer went. It
       crosses the rows' left padding only, so it never touches a label. */
    z-index: 1;
    pointer-events: none;
    background: color-mix(in srgb, var(--ws-hue) 22%, transparent);
  }
  .agent {
    height: 30px;
    /* 26px = the workspace row's own glyph column (8 pad + 14 twisty + 4 gap), so
       the status dots sit exactly under the folder glyphs. */
    padding: 0 4px 0 26px;
    cursor: pointer;
  }
  .agent-name {
    flex: 1;
    min-width: 0;
    font-size: 13.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Blocked / done — the two states a person must act on — get weight; the
     colour stays in the glyph. */
  .agent-name.attn {
    color: var(--text);
    font-weight: 600;
  }

  /* ---- hover actions: overlaid on the row's end, never a reserved column ---- */
  .row-actions {
    position: absolute;
    top: 0;
    right: 0;
    height: 100%;
    padding: 0 4px 0 14px;
    display: flex;
    align-items: center;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.12s;
    /* Fades the label out under the button rather than letting the two collide. */
    background: linear-gradient(to right, transparent, var(--row-bg) 14px);
  }
  .ws,
  .agent {
    --row-bg: var(--surface-1);
  }
  .ws:hover,
  .agent:hover {
    --row-bg: var(--surface-3);
  }
  /* The wash colours are translucent, so the fade needs their opaque equivalent
     or the button sits on a visible seam. */
  .ws.selected,
  .agent.selected {
    --row-bg: color-mix(in srgb, var(--accent) 22%, var(--surface-1));
  }
  .ws.selected:hover,
  .agent.selected:hover {
    --row-bg: color-mix(in srgb, var(--accent) 22%, var(--surface-3));
  }
  .ws:hover .row-actions,
  .agent:hover .row-actions,
  .ws:focus-visible .row-actions,
  .agent:focus-visible .row-actions,
  .row-actions:focus-within {
    opacity: 1;
    pointer-events: auto;
  }
  .act {
    width: 22px;
    height: 22px;
    padding: 0;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--text-faint);
    cursor: pointer;
    transition: color 0.12s, background 0.12s;
  }
  .act:hover {
    background: var(--surface-4);
    color: var(--text);
  }
  .act.danger:hover {
    color: var(--danger, #ff6b6b);
  }

  .badge {
    flex: 0 0 auto;
    min-width: 17px;
    height: 17px;
    padding: 0 4px;
    display: grid;
    place-items: center;
    border-radius: 9px;
    font-size: 11px;
    font-weight: 600;
  }
  /* A count is a number, not a status: no colour. */
  .count {
    background: var(--surface-4);
    color: var(--text-muted);
  }
  /* This one IS a status — agents blocked, or done and waiting on review. */
  .pip {
    background: var(--danger-strong);
    color: #fff;
    font-weight: 700;
  }
  .kbd {
    flex: 0 0 auto;
    font-size: 10.5px;
    color: var(--text-ghost);
    font-family: ui-monospace, monospace;
  }

  /* ---- status glyphs (the tree's only state colour) ---- */
  .status {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    font-size: 11px;
    font-weight: 800;
  }
  .idle-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: 1.5px solid var(--text-ghost);
  }
  .agent:hover .idle-dot {
    border-color: var(--text-faint);
  }
  .dash {
    color: var(--text-ghost);
  }
  /* working — rotating ring */
  .spinner {
    width: 13px;
    height: 13px;
    border-radius: 50%;
    border: 1.5px solid color-mix(in srgb, var(--state) 25%, transparent);
    border-top-color: var(--state);
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  /* done — a crisp check, no halo */
  .tick {
    width: 15px;
    height: 15px;
    border-radius: 50%;
    background: var(--ok);
    color: var(--on-hue, #04140a);
    display: grid;
    place-items: center;
    font-size: 10px;
    font-weight: 900;
  }
  /* blocked — pulsing red: the one thing in the rail allowed to move for attention */
  .bang {
    width: 15px;
    height: 15px;
    border-radius: 50%;
    background: var(--danger-strong);
    color: #2a0605;
    display: grid;
    place-items: center;
    font-size: 11px;
    animation: bang-pulse 1.1s ease-in-out infinite;
  }
  @keyframes bang-pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(255, 95, 87, 0.5); }
    50% { box-shadow: 0 0 0 4px rgba(255, 95, 87, 0); }
  }

  /* ---- inline rename ---- */
  .rename-input {
    flex: 1;
    min-width: 0;
    font-size: 13.5px;
    font-weight: 500;
    font-family: inherit;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--accent);
    border-radius: 4px;
    padding: 1px 5px;
    outline: none;
  }

  /* ---- empty states ---- */
  /* An expanded workspace with no agents offers the action instead of a dead end. */
  .empty {
    display: flex;
    padding: 1px 0 2px 26px;
  }
  .empty-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 26px;
    padding: 0 7px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--text-ghost);
    font-size: 12.5px;
    font-family: inherit;
    cursor: pointer;
    transition: color 0.12s, background 0.12s;
  }
  .empty-btn:hover {
    background: var(--surface-3);
    color: var(--text-muted);
  }
  .hint {
    padding: 7px 10px;
    font-size: 12.5px;
    color: var(--text-ghost);
  }
</style>
