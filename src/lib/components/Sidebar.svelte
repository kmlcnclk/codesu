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

  /** Drives the header's one toggle: fold everything, or unfold everything. */
  let allCollapsed = $derived(
    app.liveWorkspaces.length > 0 && app.liveWorkspaces.every((w) => app.wsCollapsed[w.id]),
  );

  /**
   * Type-to-filter. A rail with five projects and thirty agents is a scroll, not
   * a list; the reference's filter glyph is the answer, so it is a real one here.
   * A workspace whose OWN name matches keeps its whole roster (you asked for the
   * project); otherwise only its matching agents show, and empty projects drop out.
   */
  let query = $state("");
  let searching = $state(false);
  let searchEl = $state<HTMLInputElement | null>(null);

  let q = $derived(query.trim().toLowerCase());
  let rows = $derived.by(() => {
    const all = app.liveWorkspaces.map((ws) => ({ ws, roster: app.rosterOf(ws.id) }));
    if (!q) return all;
    return all.flatMap((row) => {
      if (row.ws.name.toLowerCase().includes(q)) return [row];
      const hits = row.roster.filter((a) => a.name.toLowerCase().includes(q));
      return hits.length ? [{ ws: row.ws, roster: hits }] : [];
    });
  });

  let hits = $derived(rows.reduce((n, r) => n + r.roster.length, 0));

  function toggleSearch() {
    searching = !searching;
    if (!searching) query = "";
  }
  function searchKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (query) query = "";
      else toggleSearch();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      moveFocus(1);
    }
  }
  function focusOnMount(node: HTMLInputElement) {
    node.focus();
  }

  /** Split a name around the filter hit, so you can see WHY a row survived. */
  function hl(name: string): [string, string, string] | null {
    if (!q) return null;
    const i = name.toLowerCase().indexOf(q);
    if (i < 0) return null;
    return [name.slice(0, i), name.slice(i, i + q.length), name.slice(i + q.length)];
  }

  /** The badge letter — a project reads as itself before you get to its name. */
  function initial(name: string) {
    return (name.trim()[0] ?? "?").toUpperCase();
  }

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
    if (e.button !== 0 || editingWsId || q) return;
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

  /**
   * A tree is ONE tab stop, not thirty — Tab reaches the rail, arrows move inside
   * it. Only the row the selection is on stays tabbable; the rest are reachable
   * by keyboard through {@link moveFocus}. Falls back down the chain when the
   * selected row is filtered out from under it.
   */
  let tabId = $derived.by(() => {
    const a = app.activeAgent?.id;
    if (a && rows.some((r) => r.roster.some((x) => x.id === a))) return a;
    const w = app.activeWorkspaceId;
    if (w && rows.some((r) => r.ws.id === w)) return w;
    return rows[0]?.ws.id ?? null;
  });

  /**
   * Selection can change from anywhere — ⌘1–9, the tab bar, a terminal closing.
   * When it does, the rail follows it. `block: "nearest"` means an already-visible
   * row is left exactly where it is, so this never yanks the list under the pointer.
   */
  $effect(() => {
    const id = app.activeAgent?.id ?? app.activeWorkspaceId;
    if (!id || !listEl || wsDragId) return;
    requestAnimationFrame(() => {
      listEl?.querySelector<HTMLElement>(".selected")?.scrollIntoView({ block: "nearest" });
    });
  });

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
      <div class="head-actions">
        <button
          class="head-act"
          class:on={searching}
          title="Filter workspaces and agents"
          aria-label="Filter workspaces and agents"
          aria-pressed={searching}
          onclick={toggleSearch}
        >
          <Icon name="filter" size={14} />
        </button>
        <button
          class="head-act"
          title={allCollapsed ? "Expand all" : "Collapse all"}
          aria-label={allCollapsed ? "Expand all" : "Collapse all"}
          onclick={() => app.setAllWorkspacesCollapsed(!allCollapsed)}
        >
          <Icon name={allCollapsed ? "chevronsDown" : "chevronsUp"} size={14} />
        </button>
        <button class="head-act" title="New workspace" onclick={onNewWorkspace} aria-label="New workspace">
          <Icon name="plus" size={15} />
        </button>
      </div>
    </header>

    {#if searching}
      <div class="search" class:filled={!!q}>
        <span class="search-icon" aria-hidden="true"><Icon name="search" size={13} /></span>
        <input
          bind:this={searchEl}
          bind:value={query}
          use:focusOnMount
          type="text"
          placeholder="Filter…"
          aria-label="Filter workspaces and agents"
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          onkeydown={searchKey}
        />
        {#if q}
          <span class="hits" title="{hits} agent(s) shown">{hits}</span>
          <button
            class="clear"
            title="Clear filter (Esc)"
            aria-label="Clear filter"
            onclick={() => {
              query = "";
              searchEl?.focus();
            }}
          >
            <Icon name="close" size={11} />
          </button>
        {/if}
      </div>
    {/if}

    <ul class="list ws-list" role="tree" aria-label="Workspaces" bind:this={listEl}>
      {#each rows as { ws, roster } (ws.id)}
        {@const editing = editingWsId === ws.id}
        {@const missing = app.isPathMissing(ws.path)}
        {@const open = q ? true : !app.wsCollapsed[ws.id]}
        {@const attention = app.attentionCountOf(ws.id)}
        {@const working = roster.filter((a) => a.state === "working").length}
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
            tabindex={tabId === ws.id ? 0 : -1}
            onpointerdown={(e) => wsPointerDown(e, ws)}
            onpointermove={wsPointerMove}
            onpointerup={wsPointerUp}
            onpointercancel={wsPointerUp}
            onclick={() => wsClick(ws)}
            ondblclick={() => startRenameWs(ws)}
            onkeydown={(e) => wsKey(e, ws)}
            oncontextmenu={(e) => wsMenu(e, ws)}
          >
            <!--
              One column, two marks. At rest it is the workspace's BADGE — a
              tinted tile carrying the project's initial, which is the fastest
              thing to scan down a rail of similar names, and the only place the
              hue lives. On hover it becomes the fold arrow, so the twisty costs
              no width of its own and the name keeps every pixel it can get.
            -->
            <span
              class="lead"
              role="button"
              tabindex="-1"
              title={open ? "Collapse" : "Expand"}
              onpointerdown={(e) => e.stopPropagation()}
              onclick={(e) => {
                e.stopPropagation();
                app.toggleWorkspaceCollapsed(ws.id);
              }}
              onkeydown={(e) => e.stopPropagation()}
            >
              <span
                class="ws-icon"
                class:missing
                style={missing ? undefined : `--hue:${ws.color}`}
              >
                {#if missing}
                  <Icon name="alert" size={12} />
                {:else if ws.isWorktree}
                  <Icon name="branch" size={12} />
                {:else}
                  {initial(ws.name)}
                {/if}
              </span>
              <span class="twisty" class:open aria-hidden="true">
                <Icon name="chevronDown" size={13} />
              </span>
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
              {@const parts = hl(ws.name)}
              <span class="ws-name"
                >{#if parts}{parts[0]}<mark>{parts[1]}</mark>{parts[2]}{:else}{ws.name}{/if}</span
              >
              <!-- Folded, but not silent: a project with agents running says so,
                   otherwise a bare count reads as "nothing is happening in here". -->
              {#if !open && working > 0 && attention === 0}
                <span class="ws-working" title="{working} agent(s) working"></span>
              {/if}
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
            <ul class="agent-list" role="group" style="--ws-hue:{ws.color}">
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
                    tabindex={tabId === agent.id ? 0 : -1}
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
                      {@const parts = hl(agent.name)}
                      <span
                        class="agent-name"
                        class:attn={agent.state === "blocked" || agent.state === "done"}
                      >{#if parts}{parts[0]}<mark>{parts[1]}</mark>{parts[2]}{:else}{agent.name}{/if}</span>
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

      {#if rows.length === 0}
        <li class="hint">
          {q ? `No workspace or agent matches “${query.trim()}”.` : "No workspaces. Click + to add one."}
        </li>
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
    padding: 7px 6px 5px 8px;
  }
  /* A panel title, not a micro-label: sentence case at reading size with the
     panel's own menu hung off it, the way a tool window is titled in the IDE. */
  .group-title {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 2px 4px 2px 4px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.01em;
    color: var(--text-muted);
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }
  .group-title :global(svg) {
    color: var(--text-faint);
  }
  .group-title:hover {
    background: var(--surface-3);
    color: var(--text);
  }
  /* Ghost glyphs, not boxed buttons: panel chrome should sit behind the list it
     titles, and a boxed control at the top of a rail reads louder than any row. */
  .head-actions {
    display: flex;
    align-items: center;
    gap: 1px;
  }
  .head-act {
    width: 22px;
    height: 22px;
    padding: 0;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--text-faint);
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }
  .head-act:hover {
    background: var(--surface-3);
    color: var(--text);
  }
  .head-act.on {
    background: var(--accent-softer);
    color: var(--accent);
  }

  /* ---- filter field ----
     The WRAPPER is the field; the input inside it is just text. app.css gives
     every :focus-visible element a ring, which on a borderless input drew a
     second, square ring inside the rounded one — so the input's ring is dropped
     and the wrapper wears the app's own focus treatment instead. */
  .search {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    /* Flush with the rows' own 4px gutter, so the field lines up with the list
       it filters rather than floating 2px inside it. */
    margin: 0 4px 6px;
    padding: 0 4px 0 7px;
    height: 28px;
    border: 1px solid transparent;
    border-radius: 7px;
    /* At rest it reads as a recessed well, not a bordered box — one less line in
       a panel whose whole job is to stay behind its content. */
    background: var(--surface-3);
    color: var(--text-faint);
    transition: background 0.12s, border-color 0.12s, box-shadow 0.12s;
  }
  .search:hover {
    background: var(--surface-4);
  }
  .search:focus-within {
    background: var(--bg);
    border-color: var(--accent-line);
    box-shadow: var(--ring);
  }
  .search-icon {
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    color: var(--text-ghost);
    transition: color 0.12s;
  }
  .search:focus-within .search-icon,
  .search.filled .search-icon {
    color: var(--accent);
  }
  .search input {
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0;
    border: 0;
    outline: none;
    background: transparent;
    font-family: inherit;
    font-size: 12.5px;
    color: var(--text);
  }
  /* The wrapper already shows focus; a ring on the input would double it. */
  .search input:focus-visible {
    box-shadow: none;
  }
  .search input::placeholder {
    color: var(--text-ghost);
  }
  /* What the filter caught, in the field's own dead space. */
  .hits {
    flex: 0 0 auto;
    padding: 0 1px;
    font-size: 11px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--text-ghost);
  }
  .clear {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    padding: 0;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--text-faint);
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }
  .clear:hover {
    background: var(--surface-4);
    color: var(--text);
  }

  .list {
    list-style: none;
    margin: 0;
    gap: 1px;
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
    scrollbar-width: thin;
    scrollbar-color: transparent transparent;
    transition: scrollbar-color 0.2s;
  }
  .list:hover {
    scrollbar-color: var(--surface-4) transparent;
  }
  .list::-webkit-scrollbar {
    width: 8px;
  }
  .list::-webkit-scrollbar-thumb {
    border: 2px solid transparent;
    border-radius: 8px;
    background-clip: content-box;
    background-color: transparent;
  }
  .list:hover::-webkit-scrollbar-thumb {
    background-color: var(--surface-4);
  }
  .list::-webkit-scrollbar-thumb:hover {
    background-color: var(--border-strong);
  }
  .node {
    display: flex;
    flex-direction: column;
  }
  /* A break before the next workspace, none between a workspace and its own
     agents: whitespace does the grouping, so the indent can stay shallow and
     names keep their width. */
  .node + .node {
    margin-top: 4px;
  }

  /* ---- shared row shell ---- */
  .ws,
  .agent {
    position: relative;
    width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    border: 0;
    /* Rounded at both ends: every row is a self-contained shape. */
    border-radius: 6px;
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

  /* ---- workspace row ---- */
  .ws {
    height: 28px;
    padding: 0 4px 0 6px;
    cursor: grab;
    touch-action: none;
    /* Pins to the top of the scroller while its own agents scroll past, so a
       long roster never leaves you asking which project you are looking at.
       Needs an opaque fill — the rows below must not show through it. */
    position: sticky;
    top: 0;
    z-index: 3;
    background: var(--surface-1);
  }
  /* Sticky rows report their PINNED rect, which would poison the drop-slot maths
     (and pin the row you are dragging to the top). While a drag is live the whole
     list goes back to static flow. */
  .ws-list:has(.dragging) .ws {
    position: relative;
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
    font-size: 13px;
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

  /* The shared badge / twisty column. Both marks are stacked in it; only one is
     ever visible, so the column costs 18px once instead of twice. */
  .lead {
    position: relative;
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    cursor: pointer;
  }
  .lead > * {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    transition: opacity 0.12s ease;
  }
  /* A tinted tile with the project's initial: the hue is identity, and an initial
     is quicker to pick out of a column of near-identical names than a folder. */
  .ws-icon {
    border-radius: 5px;
    font-size: 10px;
    font-weight: 700;
    line-height: 1;
    color: var(--hue);
    background: color-mix(in srgb, var(--hue) 16%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--hue) 28%, transparent);
  }
  .ws-icon.missing {
    --hue: var(--danger, #ff6b6b);
  }
  .twisty {
    opacity: 0;
    color: var(--text-muted);
    transform: rotate(-90deg);
    transition: transform 0.13s ease, opacity 0.12s ease;
  }
  .twisty.open {
    transform: rotate(0deg);
  }
  /* Hover swaps the badge for the fold arrow — same square, no reflow. */
  .ws:hover .ws-icon,
  .ws:focus-visible .ws-icon {
    opacity: 0;
  }
  .ws:hover .twisty,
  .ws:focus-visible .twisty {
    opacity: 1;
  }

  /* ---- agent rows ---- */
  .agent-list {
    position: relative;
    list-style: none;
    /* Sits a touch below its workspace row, and its own rows are spaced like the
       top-level ones — separate pills read as separate rows. */
    margin: 1px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
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
    height: 26px;
    /* Clears the pinned workspace header when a row is scrolled into view. */
    scroll-margin-top: 30px;
    scroll-margin-bottom: 4px;
    /* 30px = the workspace row's own glyph column (6 pad + 18 lead + 6 gap), so
       the status dots sit exactly under the project badges. */
    padding: 0 4px 0 30px;
    cursor: pointer;
  }
  .agent-name {
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
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
  /* The filter hit, shown in the name itself — you can see WHY a row survived. */
  .ws-name :global(mark),
  .agent-name :global(mark) {
    background: color-mix(in srgb, var(--accent) 30%, transparent);
    color: var(--text);
    border-radius: 2px;
    padding: 0 1px;
  }

  /* Folded-project activity: the same ring the agent rows use, shrunk to a hint. */
  .ws-working {
    flex: 0 0 auto;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    border: 1.5px solid color-mix(in srgb, var(--accent) 25%, transparent);
    border-top-color: var(--accent);
    animation: spin 0.9s linear infinite;
  }

  .kbd {
    flex: 0 0 auto;
    font-size: 10.5px;
    color: var(--text-ghost);
    font-family: ui-monospace, monospace;
  }

  /* ---- status glyphs (the tree's only state colour) ---- */
  .status {
    width: 16px;
    height: 16px;
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
    padding: 1px 0 2px 30px;
  }
  .empty-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 24px;
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
