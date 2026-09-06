<script lang="ts">
  import { flip } from "svelte/animate";
  import {
    app,
    STATE_META,
    type Project,
    type Workspace,
    type AgentState,
  } from "$lib/store/app.svelte";
  import ContextMenu, { type MenuItem } from "./ContextMenu.svelte";
  import Icon from "./Icon.svelte";

  let {
    onNewProject,
    onNewWorkspace,
    onNewAgent,
    onOpenCode,
  }: {
    onNewProject: () => void;
    /** Open the "new workspace" flow for one project. */
    onNewWorkspace: (projectId: string) => void;
    onNewAgent: (workspaceId: string) => void;
    /** Open this workspace in the built-in Code view. */
    onOpenCode?: (workspaceId: string) => void;
  } = $props();

  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);

  /** Drives the header's one toggle: fold everything, or unfold everything. */
  let allCollapsed = $derived(
    app.liveProjects.length > 0 && app.liveProjects.every((p) => app.projCollapsed[p.id]),
  );

  /**
   * Type-to-filter. A project whose OWN name matches keeps all of its workspaces (you
   * asked for the project); otherwise only its matching workspaces show, and projects
   * left with nothing drop out.
   */
  let query = $state("");
  let searching = $state(false);
  let searchEl = $state<HTMLInputElement | null>(null);

  let q = $derived(query.trim().toLowerCase());
  let rows = $derived.by(() => {
    const all = app.liveProjects.map((proj) => ({ proj, spaces: app.workspacesOf(proj.id) }));
    if (!q) return all;
    return all.flatMap((row) => {
      if (row.proj.name.toLowerCase().includes(q)) return [row];
      const hits = row.spaces.filter((w) => w.name.toLowerCase().includes(q));
      return hits.length ? [{ proj: row.proj, spaces: hits }] : [];
    });
  });

  let hits = $derived(rows.reduce((n, r) => n + r.spaces.length, 0));

  /**
   * The state a workspace row wears: the most urgent state among its agents. The
   * roster is already ordered blocked → done → working → idle, so its head IS the
   * answer. Null when the workspace has no live agents — the row stays colourless,
   * which is the whole point of reserving colour for "this one wants you".
   */
  function wsState(ws: Workspace): AgentState | null {
    return app.rosterOf(ws.id)[0]?.state ?? null;
  }

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

  // Pointer-based drag reorder for projects (HTML5 DnD is unreliable in the
  // webview; pointer events are not, and let us show a grab/grabbing cursor).
  let projDragId = $state<string | null>(null);
  let projDragMoved = $state(false);
  let startY = 0;
  let projLastIdx = -1;
  let suppressClick = false;

  // Inline rename: exactly one of these is set while its input is open.
  let editingProjId = $state<string | null>(null);
  let editingWsId = $state<string | null>(null);
  let editValue = $state("");

  function startRenameProj(proj: Project) {
    editingWsId = null;
    editingProjId = proj.id;
    editValue = proj.name;
  }
  function startRenameWs(ws: Workspace) {
    editingProjId = null;
    editingWsId = ws.id;
    editValue = ws.name;
  }
  function commitProj(id: string) {
    app.renameProject(id, editValue);
    editingProjId = null;
  }
  function commitWs(id: string) {
    app.renameWorkspace(id, editValue);
    editingWsId = null;
  }
  function cancelEdit() {
    editingProjId = null;
    editingWsId = null;
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
  function stateText(state: AgentState | null): string {
    if (state === "working") return "an agent is working";
    if (state === "done") return "work to review";
    if (state === "blocked") return "an agent needs input";
    if (state === "exited") return "agent exited";
    if (state === "idle") return "agents idle";
    return "no agents yet";
  }

  /** The panel's own menu, hung off the title — the IDE's "Project ⌄" affordance. */
  function headerMenu(e: MouseEvent) {
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    menu = {
      x: r.left,
      y: r.bottom + 4,
      items: [
        { label: "New project…", onSelect: onNewProject },
        { label: "Expand all", separatorBefore: true, onSelect: () => app.setAllProjectsCollapsed(false) },
        { label: "Collapse all", onSelect: () => app.setAllProjectsCollapsed(true) },
      ],
    };
  }

  function projMenu(e: MouseEvent, proj: Project) {
    e.preventDefault();
    app.setActiveProject(proj.id);
    menu = {
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: "New workspace…",
          color: "var(--accent)",
          onSelect: () => {
            app.expandProject(proj.id);
            onNewWorkspace(proj.id);
          },
        },
        { label: "Rename project", separatorBefore: true, onSelect: () => startRenameProj(proj) },
        { label: "Archive project", danger: true, separatorBefore: true, onSelect: () => app.archiveProject(proj.id) },
      ],
    };
  }

  function wsMenu(e: MouseEvent, ws: Workspace) {
    e.preventDefault();
    app.setActiveWorkspace(ws.id);
    const items: MenuItem[] = [
      { label: "Open in Codesu editor", onSelect: () => onOpenCode?.(ws.id) },
      { label: "Rename workspace", separatorBefore: true, onSelect: () => startRenameWs(ws) },
      {
        label: "New Claude agent",
        color: "var(--accent)",
        separatorBefore: true,
        onSelect: () => {
          app.setActiveWorkspace(ws.id);
          app.addAgent({ workspaceId: ws.id, kind: "claude", run: "claude" });
        },
      },
      { label: "New agent…", onSelect: () => onNewAgent(ws.id) },
    ];
    // The primary workspace IS the project folder — archiving it would leave a project
    // with no way in, so that door is simply not offered.
    if (!ws.primary) {
      items.push({
        label: "Archive workspace",
        danger: true,
        separatorBefore: true,
        onSelect: () => app.archiveWorkspace(ws.id),
      });
    }
    menu = { x: e.clientX, y: e.clientY, items };
  }

  function projPointerDown(e: PointerEvent, proj: Project) {
    // A drag released over a different row dispatches its click to the list, not to a
    // row, so projClick never runs to clear this — and the next honest click was eaten.
    // Every fresh press starts from a clean slate instead.
    suppressClick = false;
    if (e.button !== 0 || editingProjId || q) return;
    projDragId = proj.id;
    startY = e.clientY;
    projDragMoved = false;
    projLastIdx = -1;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function projPointerMove(e: PointerEvent) {
    if (projDragId === null) return;
    if (!projDragMoved && Math.abs(e.clientY - startY) < 4) return;
    projDragMoved = true;
    // Insertion slot = how many *other* rows sit above the cursor's center.
    const others = Array.from(
      document.querySelectorAll<HTMLElement>(".proj-list .proj"),
    ).filter((el) => el.dataset.id !== projDragId);
    let idx = 0;
    for (const el of others) {
      const r = el.getBoundingClientRect();
      if (e.clientY > r.top + r.height / 2) idx++;
    }
    // Only reorder when the slot actually changes (avoids per-frame churn/lag).
    if (idx === projLastIdx) return;
    projLastIdx = idx;
    app.moveProjectToIndex(projDragId, idx);
  }
  // Workspace drag-reorder, per project. The primary is not draggable — workspacesOf
  // pins it to the top — so both the handle and the drop maths count BRANCHES only.
  let wsDragId = $state<string | null>(null);
  let wsDragMoved = $state(false);
  let wsStartY = 0;
  let wsLastIdx = -1;

  function wsPointerDown(e: PointerEvent, ws: Workspace) {
    suppressClick = false;
    if (e.button !== 0 || editingWsId || q || ws.primary) return;
    wsDragId = ws.id;
    wsStartY = e.clientY;
    wsDragMoved = false;
    wsLastIdx = -1;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function wsPointerMove(e: PointerEvent) {
    if (wsDragId === null) return;
    if (!wsDragMoved && Math.abs(e.clientY - wsStartY) < 4) return;
    wsDragMoved = true;
    const owner = app.workspaces.find((w) => w.id === wsDragId);
    if (!owner) return;
    // Only this project's rows, and only the ones that can move.
    const others = Array.from(
      document.querySelectorAll<HTMLElement>(`.ws-list[data-project="${owner.projectId}"] .ws`),
    ).filter((el) => el.dataset.id !== wsDragId && el.dataset.primary !== "true");
    let idx = 0;
    for (const el of others) {
      const r = el.getBoundingClientRect();
      if (e.clientY > r.top + r.height / 2) idx++;
    }
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

  function projPointerUp(e: PointerEvent) {
    if (projDragId === null) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be gone */
    }
    if (projDragMoved) suppressClick = true;
    projDragId = null;
    projDragMoved = false;
  }

  /**
   * A click selects the project (which opens a workspace inside it). Clicking the one
   * you are already on folds it — standard tree behaviour, and it makes the twisty a
   * shortcut rather than the only way to collapse something.
   */
  /** Select the workspace — unless the pointer was actually finishing a drag. */
  function wsClick(ws: Workspace) {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (editingWsId === ws.id) return;
    app.setActiveWorkspace(ws.id);
  }

  function projClick(proj: Project) {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (editingProjId === proj.id) return;
    if (proj.id === app.activeProjectId) {
      app.toggleProjectCollapsed(proj.id);
      return;
    }
    app.setActiveProject(proj.id);
    app.expandProject(proj.id);
  }

  // ---- keyboard: the rail behaves like a tree, not a stack of buttons ----
  let listEl = $state<HTMLElement | null>(null);

  /** Move focus to the previous/next visible row (projects and workspaces alike). */
  function moveFocus(delta: 1 | -1) {
    if (!listEl) return;
    const all = Array.from(listEl.querySelectorAll<HTMLElement>("[data-row]"));
    const at = all.indexOf(document.activeElement as HTMLElement);
    const next = all[at < 0 ? (delta === 1 ? 0 : all.length - 1) : at + delta];
    next?.focus();
  }

  function projKey(e: KeyboardEvent, proj: Project) {
    if (editingProjId === proj.id) return;
    switch (e.key) {
      case "Enter":
        e.preventDefault();
        app.setActiveProject(proj.id);
        break;
      case "ArrowRight":
        e.preventDefault();
        app.expandProject(proj.id);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (!app.projCollapsed[proj.id]) app.toggleProjectCollapsed(proj.id);
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

  function wsKey(e: KeyboardEvent, ws: Workspace) {
    if (editingWsId === ws.id) return;
    switch (e.key) {
      case "Enter":
        e.preventDefault();
        app.setActiveWorkspace(ws.id);
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
        listEl?.querySelector<HTMLElement>(`.proj[data-id="${ws.projectId}"]`)?.focus();
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
    const w = app.activeWorkspaceId;
    if (w && rows.some((r) => r.spaces.some((x) => x.id === w))) return w;
    const p = app.activeProjectId;
    if (p && rows.some((r) => r.proj.id === p)) return p;
    return rows[0]?.proj.id ?? null;
  });

  /**
   * Selection can change from anywhere — ⌘1–9, the tab bar, a terminal closing.
   * When it does, the rail follows it. `block: "nearest"` means an already-visible
   * row is left exactly where it is, so this never yanks the list under the pointer.
   */
  $effect(() => {
    const id = app.activeWorkspaceId ?? app.activeProjectId;
    if (!id || !listEl || projDragId) return;
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
  One tree: PROJECTS at the root, their workspaces nested underneath. Agents live
  one level further in — inside the open workspace's tab bar — and deliberately do
  not appear here: a rail that listed every agent of every workspace was a scroll,
  not a list, and it buried the two things you actually navigate by.

  Colour follows app.css's own rule. A hue is IDENTITY — exactly one mark per
  project (its glyph), inherited as a hairline by its workspaces' guide. Status
  colours keep their MEANING — a workspace only takes one when an agent inside it
  is working, done, or blocked. Selection is the IDE's own selected-row wash.
-->
<aside class="sidebar" bind:this={sidebarEl} style="width:{app.sidebarWidth}px">
  <section class="group">
    <header class="group-head">
      <button class="group-title" onclick={headerMenu} title="Projects panel">
        Projects
        <Icon name="chevronDown" size={13} />
      </button>
      <div class="head-actions">
        <button
          class="head-act"
          class:on={searching}
          title="Filter projects and workspaces"
          aria-label="Filter projects and workspaces"
          aria-pressed={searching}
          onclick={toggleSearch}
        >
          <Icon name="filter" size={14} />
        </button>
        <button
          class="head-act"
          title={allCollapsed ? "Expand all" : "Collapse all"}
          aria-label={allCollapsed ? "Expand all" : "Collapse all"}
          onclick={() => app.setAllProjectsCollapsed(!allCollapsed)}
        >
          <Icon name={allCollapsed ? "chevronsDown" : "chevronsUp"} size={14} />
        </button>
        <button class="head-act" title="New project" onclick={onNewProject} aria-label="New project">
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
          aria-label="Filter projects and workspaces"
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          onkeydown={searchKey}
        />
        {#if q}
          <span class="hits" title="{hits} workspace(s) shown">{hits}</span>
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

    <ul class="list proj-list" role="tree" aria-label="Projects" bind:this={listEl}>
      {#each rows as { proj, spaces } (proj.id)}
        {@const editing = editingProjId === proj.id}
        {@const missing = app.isPathMissing(proj.path)}
        {@const open = q ? true : !app.projCollapsed[proj.id]}
        {@const attention = app.projectAttentionCount(proj.id)}
        {@const working = app.projectWorkingCount(proj.id)}
        {@const selected = proj.id === app.activeProjectId}
        {@const holdsSelection = selected && spaces.some((w) => w.id === app.activeWorkspaceId)}
        <li class="node" class:holds-selection={holdsSelection} animate:flip={{ duration: 160 }}>
          <div
            class="proj"
            class:selected={selected && !holdsSelection}
            class:missing
            class:dragging={projDragId === proj.id && projDragMoved}
            title={missing ? `Folder not found: ${proj.path}` : proj.path}
            data-id={proj.id}
            data-row
            role="treeitem"
            aria-expanded={open}
            aria-selected={selected}
            tabindex={tabId === proj.id ? 0 : -1}
            onpointerdown={(e) => projPointerDown(e, proj)}
            onpointermove={projPointerMove}
            onpointerup={projPointerUp}
            onpointercancel={projPointerUp}
            onclick={() => projClick(proj)}
            ondblclick={() => startRenameProj(proj)}
            onkeydown={(e) => projKey(e, proj)}
            oncontextmenu={(e) => projMenu(e, proj)}
          >
            <!--
              One column, two marks. At rest it is the project's BADGE — a tinted
              tile carrying its initial, which is the fastest thing to scan down a
              rail of similar names, and the only place the hue lives. On hover it
              becomes the fold arrow, so the twisty costs no width of its own and
              the name keeps every pixel it can get.
            -->
            <span
              class="lead"
              role="button"
              tabindex="-1"
              title={open ? "Collapse" : "Expand"}
              onpointerdown={(e) => e.stopPropagation()}
              onclick={(e) => {
                e.stopPropagation();
                app.toggleProjectCollapsed(proj.id);
              }}
              onkeydown={(e) => e.stopPropagation()}
            >
              <span
                class="proj-icon"
                class:missing
                style={missing ? undefined : `--hue:${proj.color}`}
              >
                {#if missing}
                  <Icon name="alert" size={12} />
                {:else}
                  {initial(proj.name)}
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
                  editKey(e, () => commitProj(proj.id));
                }}
                onblur={() => commitProj(proj.id)}
              />
            {:else}
              {@const parts = hl(proj.name)}
              <span class="proj-name"
                >{#if parts}{parts[0]}<mark>{parts[1]}</mark>{parts[2]}{:else}{proj.name}{/if}</span
              >
              <!-- Folded, but not silent: a project with agents running says so,
                   otherwise a bare count reads as "nothing is happening in here". -->
              {#if !open && working > 0 && attention === 0}
                <span class="proj-working" title="{working} agent(s) working"></span>
              {/if}
              <!--
                A badge is only in the layout when there IS one. The attention pip
                counts agents across the WHOLE project, because agents are no longer
                rows here — folding a project must never hide one that needs you.
              -->
              {#if attention > 0}
                <span class="badge pip" title="{attention} agent(s) awaiting you">{attention}</span>
              {:else if !open && spaces.length > 0}
                <span class="badge count">{spaces.length}</span>
              {/if}
              <!--
                Hover actions OVERLAY the end of the row instead of reserving a
                column, so at a narrow rail the full name is what you see; the
                fade keeps the button legible over the text it covers.
              -->
              <span class="row-actions">
                <button
                  class="act"
                  title="New workspace in {proj.name}"
                  aria-label="New workspace in {proj.name}"
                  onpointerdown={(e) => e.stopPropagation()}
                  onclick={(e) => {
                    e.stopPropagation();
                    app.expandProject(proj.id);
                    onNewWorkspace(proj.id);
                  }}
                >
                  <Icon name="plus" size={14} />
                </button>
              </span>
            {/if}
          </div>

          {#if open && !editing}
            <!-- The guide inherits the project's hue at 22%: enough to tie a run of
                 workspaces to its parent, far too quiet to read as decoration. -->
            <ul class="ws-list" role="group" data-project={proj.id} style="--proj-hue:{proj.color}">
              {#each spaces as ws (ws.id)}
                {@const state = wsState(ws)}
                {@const meta = state ? STATE_META[state] : null}
                {@const wsEditing = editingWsId === ws.id}
                {@const isActive = ws.id === app.activeWorkspaceId}
                {@const wsMissing = app.isPathMissing(ws.path)}
                {@const count = app.countOf(ws.id)}
                <li animate:flip={{ duration: 160 }}>
                  <div
                    class="ws"
                    class:selected={isActive}
                    class:missing={wsMissing}
                    class:draggable={!ws.primary}
                    class:dragging={wsDragId === ws.id && wsDragMoved}
                    data-state={state ?? "none"}
                    data-id={ws.id}
                    data-primary={ws.primary ? "true" : "false"}
                    data-row
                    role="treeitem"
                    aria-selected={isActive}
                    tabindex={tabId === ws.id ? 0 : -1}
                    title={wsEditing
                      ? undefined
                      : wsMissing
                        ? `Folder not found: ${ws.path}`
                        : `${ws.name} — ${stateText(state)}`}
                    onpointerdown={(e) => wsPointerDown(e, ws)}
                    onpointermove={wsPointerMove}
                    onpointerup={wsPointerUp}
                    onpointercancel={wsPointerUp}
                    onclick={() => wsClick(ws)}
                    ondblclick={() => startRenameWs(ws)}
                    onkeydown={(e) => wsKey(e, ws)}
                    oncontextmenu={(e) => wsMenu(e, ws)}
                  >
                    <!-- The tree's only status colour. A workspace whose agents are
                         all idle (or which has none) stays colourless, so a coloured
                         glyph always means "something in here wants you". -->
                    <span
                      class="status"
                      style={meta ? `--state:${meta.color}` : undefined}
                      aria-label={meta?.label ?? "No agents"}
                    >
                      {#if state === "working"}
                        <span class="spinner"></span>
                      {:else if state === "done"}
                        <span class="tick">✓</span>
                      {:else if state === "blocked"}
                        <span class="bang">!</span>
                      {:else if ws.isWorktree}
                        <Icon name="branch" size={12} />
                      {:else}
                        <span class="idle-dot"></span>
                      {/if}
                    </span>

                    {#if wsEditing}
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
                      <span
                        class="ws-name"
                        class:attn={state === "blocked" || state === "done"}
                      >{#if parts}{parts[0]}<mark>{parts[1]}</mark>{parts[2]}{:else}{ws.name}{/if}</span>
                      <!-- How many agents are open inside — the thing the rail no
                           longer spells out row by row. -->
                      {#if count > 0}<span class="agents-n" title="{count} agent(s)">{count}</span>{/if}
                      <span class="row-actions">
                        <button
                          class="act"
                          title="New agent in {ws.name}"
                          aria-label="New agent in {ws.name}"
                          onpointerdown={(e) => e.stopPropagation()}
                          onclick={(e) => {
                            e.stopPropagation();
                            app.setActiveWorkspace(ws.id);
                            onNewAgent(ws.id);
                          }}
                        >
                          <Icon name="plus" size={14} />
                        </button>
                      </span>
                    {/if}
                  </div>
                </li>
              {/each}

              {#if spaces.length === 0}
                <li class="empty">
                  <button class="empty-btn" onclick={() => onNewWorkspace(proj.id)}>
                    <Icon name="plus" size={12} /> New workspace
                  </button>
                </li>
              {/if}
            </ul>
          {/if}
        </li>
      {/each}

      {#if rows.length === 0}
        <li class="hint">
          {q ? `No project or workspace matches “${query.trim()}”.` : "No projects. Click + to add one."}
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
    margin: 0 4px 6px;
    padding: 0 4px 0 7px;
    height: 28px;
    border: 1px solid transparent;
    border-radius: 7px;
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
  /* A break before the next project, none between a project and its own
     workspaces: whitespace does the grouping, so the indent can stay shallow and
     names keep their width. */
  .node + .node {
    margin-top: 4px;
  }

  /* ---- shared row shell ---- */
  .proj,
  .ws {
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
  .proj:focus-visible,
  .ws:focus-visible {
    outline: 1px solid var(--accent-line);
    outline-offset: -1px;
  }
  .proj:hover,
  .ws:hover {
    background: var(--surface-3);
  }
  /*
   * Exactly ONE row in the tree is filled. Nothing else takes a wash, so the fill
   * plus a full-contrast label is the whole selection signal — the parent branch
   * is marked in a different currency (see below) precisely so a second tinted
   * band never sits against this one and blurs which row is selected.
   */
  .proj.selected,
  .ws.selected {
    background: var(--accent-soft);
  }
  .proj.selected .proj-name,
  .ws.selected .ws-name {
    color: var(--text);
    font-weight: 600;
  }
  /*
   * The branch that CONTAINS the selection is marked in a different currency —
   * a lit guide line and a brighter label, no fill at all. Same information,
   * zero competition with the filled row. The guide brightens in the PROJECT's
   * own hue rather than switching to the accent: the line's colour is the
   * project's identity, and identity must not change because of focus.
   */
  .node.holds-selection .ws-list::before {
    background: color-mix(in srgb, var(--proj-hue) 55%, transparent);
  }
  .node.holds-selection > .proj .proj-name {
    color: var(--text);
  }

  /* ---- project row ---- */
  .proj {
    height: 28px;
    padding: 0 4px 0 6px;
    cursor: grab;
    touch-action: none;
    /* Pins to the top of the scroller while its own workspaces scroll past, so a
       long list never leaves you asking which project you are looking at.
       Needs an opaque fill — the rows below must not show through it. */
    position: sticky;
    top: 0;
    z-index: 3;
    background: var(--surface-1);
  }
  /* Sticky rows report their PINNED rect, which would poison the drop-slot maths
     (and pin the row you are dragging to the top). While a drag is live the whole
     list goes back to static flow. */
  .proj-list:has(.dragging) .proj {
    position: relative;
  }
  .proj.dragging {
    cursor: grabbing;
    background: var(--surface-4);
    box-shadow: var(--shadow-md);
    opacity: 0.95;
    z-index: 2;
  }
  .proj-name {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Folder gone from disk — nothing under it can launch, so the row reads broken. */
  .proj.missing .proj-name,
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
  .proj-icon {
    border-radius: 5px;
    font-size: 10px;
    font-weight: 700;
    line-height: 1;
    color: var(--hue);
    background: color-mix(in srgb, var(--hue) 16%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--hue) 28%, transparent);
  }
  .proj-icon.missing {
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
  .proj:hover .proj-icon,
  .proj:focus-visible .proj-icon {
    opacity: 0;
  }
  .proj:hover .twisty,
  .proj:focus-visible .twisty {
    opacity: 1;
  }

  /* ---- workspace rows ---- */
  .ws-list {
    position: relative;
    list-style: none;
    /* Sits a touch below its project row, and its own rows are spaced like the
       top-level ones — separate pills read as separate rows. */
    margin: 1px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  /* The guide is drawn, not bordered, so the rows themselves stay full-bleed. It
     carries the parent project's hue at 22% — enough to tie a run of workspaces to
     its parent, far too quiet to read as decoration. */
  .ws-list::before {
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
    background: color-mix(in srgb, var(--proj-hue) 22%, transparent);
  }
  .ws {
    height: 26px;
    /* Clears the pinned project header when a row is scrolled into view. */
    scroll-margin-top: 30px;
    scroll-margin-bottom: 4px;
    /* 30px = the project row's own glyph column (6 pad + 18 lead + 6 gap), so
       the status glyphs sit exactly under the project badges. */
    padding: 0 4px 0 30px;
    cursor: pointer;
  }
  /* Only a branch can be reordered; the primary is pinned, so it keeps the plain
     pointer rather than advertising a drag that does nothing. */
  .ws.draggable {
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
    font-size: 12.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Blocked / done — the two states a person must act on — get weight; the
     colour stays in the glyph. */
  .ws-name.attn {
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
  .proj,
  .ws {
    --row-bg: var(--surface-1);
  }
  .proj:hover,
  .ws:hover {
    --row-bg: var(--surface-3);
  }
  /* The wash colours are translucent, so the fade needs their opaque equivalent
     or the button sits on a visible seam. */
  .proj.selected,
  .ws.selected {
    --row-bg: color-mix(in srgb, var(--accent) 22%, var(--surface-1));
  }
  .proj.selected:hover,
  .ws.selected:hover {
    --row-bg: color-mix(in srgb, var(--accent) 22%, var(--surface-3));
  }
  .proj:hover .row-actions,
  .ws:hover .row-actions,
  .proj:focus-visible .row-actions,
  .ws:focus-visible .row-actions,
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
  /* How many agents are open inside a workspace. Plain digits, no chip: the rail
     no longer lists them, but it must still say how many there are. */
  .agents-n {
    flex: 0 0 auto;
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
    color: var(--text-ghost);
  }
  /* The filter hit, shown in the name itself — you can see WHY a row survived. */
  .proj-name :global(mark),
  .ws-name :global(mark) {
    background: color-mix(in srgb, var(--accent) 30%, transparent);
    color: var(--text);
    border-radius: 2px;
    padding: 0 1px;
  }

  /* Folded-project activity: the same ring the workspace rows use, shrunk to a hint. */
  /* Folded-project activity: the same mark the workspace rows use, shrunk to a hint. */
  .proj-working {
    flex: 0 0 auto;
    width: 7px;
    height: 7px;
    background: var(--accent);
    animation: morph 1.6s ease-in-out infinite;
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
    color: var(--text-ghost);
  }
  .idle-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: 1.5px solid var(--text-ghost);
  }
  .ws:hover .idle-dot {
    border-color: var(--text-faint);
  }
  /* working — one solid mark that rotates as it melts between a circle and a
     rounded square. No track and no stroke: at 16px a hairline arc is fighting
     antialiasing, whereas a filled shape stays crisp, and the silhouette
     change carries the motion even when the rotation itself is too small to
     read. The idle state is a hollow dot, so "working" is literally that dot
     filled in and alive. */
  .spinner {
    width: 9px;
    height: 9px;
    background: var(--state);
    animation: morph 1.6s ease-in-out infinite;
  }
  @keyframes morph {
    0%   { border-radius: 50%; transform: rotate(0deg)   scale(0.78); }
    50%  { border-radius: 16%; transform: rotate(180deg) scale(1); }
    100% { border-radius: 50%; transform: rotate(360deg) scale(0.78); }
  }
  /* Motion is decoration here — the filled mark already carries "working". */
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
      border-radius: 30%;
    }
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
  /* An expanded project with no workspaces offers the action instead of a dead end. */
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
