<script lang="ts">
  import { flip } from "svelte/animate";
  import {
    app,
    TASK_STATUSES,
    TASK_META,
    STATE_META,
    STATE_RANK,
    type Agent,
    type AgentState,
  } from "$lib/store/app.svelte";
  import ContextMenu, { type MenuItem } from "./ContextMenu.svelte";
  import Icon from "./Icon.svelte";

  let { onNewAgent }: { onNewAgent: () => void } = $props();

  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);

  /** The representative pane of a tab: the focused one if it's here, else the first. */
  function repOf(agents: Agent[]): Agent {
    return agents.find((a) => a.id === app.activeAgent?.id) ?? agents[0];
  }
  /** The tab's aggregate live state = its highest-priority pane (blocked→done→…). */
  function tabState(agents: Agent[]): AgentState {
    return agents.reduce<AgentState>(
      (best, a) => (STATE_RANK[a.state] < STATE_RANK[best] ? a.state : best),
      "exited",
    );
  }

  // Inline rename (double-click a tab, or "Rename" from its menu) — renames the rep.
  let editingId = $state<string | null>(null);
  let editValue = $state("");
  function startRename(agent: Agent) {
    editingId = agent.id;
    editValue = agent.name;
  }
  function commit(id: string) {
    app.renameAgent(id, editValue);
    editingId = null;
  }
  function editKey(e: KeyboardEvent, id: string) {
    if (e.key === "Enter") {
      e.preventDefault();
      commit(id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      editingId = null;
    }
  }
  function selectOnMount(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  // ---- pointer-based drag reorder (reliable in the webview; HTML5 DnD is not) ----
  let dragId = $state<string | null>(null); // the dragged tab's groupId
  let dragMoved = $state(false);
  let startX = 0;
  let lastIdx = -1;
  let suppressClick = false;

  function onPointerDown(e: PointerEvent, groupId: string) {
    if (e.button !== 0 || editingId) return;
    dragId = groupId;
    startX = e.clientX;
    dragMoved = false;
    lastIdx = -1;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: PointerEvent) {
    if (dragId === null) return;
    if (!dragMoved && Math.abs(e.clientX - startX) < 4) return;
    dragMoved = true;
    const others = Array.from(
      document.querySelectorAll<HTMLElement>(".tabs .tab"),
    ).filter((el) => el.dataset.gid !== dragId);
    let idx = 0;
    for (const el of others) {
      const r = el.getBoundingClientRect();
      if (e.clientX > r.left + r.width / 2) idx++;
    }
    if (idx === lastIdx) return;
    lastIdx = idx;
    app.moveTabToIndex(dragId, idx);
  }
  function onPointerUp(e: PointerEvent) {
    if (dragId === null) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be gone */
    }
    if (dragMoved) suppressClick = true;
    dragId = null;
    dragMoved = false;
  }
  function onTabClick(groupId: string) {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (editingId === null) app.setActiveTab(groupId);
  }

  function openMenu(e: MouseEvent, groupId: string, rep: Agent, paneCount: number) {
    e.preventDefault();
    const items: MenuItem[] = [
      { label: "Rename tab", onSelect: () => startRename(rep) },
    ];
    TASK_STATUSES.forEach((s, idx) =>
      items.push({
        label: TASK_META[s].label,
        color: TASK_META[s].color,
        checked: app.effectiveLane(rep) === s,
        separatorBefore: idx === 0,
        onSelect: () => app.setGroupLane(groupId, s),
      }),
    );
    items.push({
      label: paneCount > 1 ? `Close tab (${paneCount} panes)` : "Close tab",
      danger: true,
      separatorBefore: true,
      onSelect: () => app.closeTab(groupId),
    });
    menu = { x: e.clientX, y: e.clientY, items };
  }
</script>

<div class="tabbar">
  <div class="tabs">
    {#each app.activeTabGroups as group, i (group.groupId)}
      {@const rep = repOf(group.agents)}
      {@const st = tabState(group.agents)}
      {@const meta = STATE_META[st]}
      {@const taskMeta = TASK_META[app.effectiveLane(rep)]}
      {@const editing = editingId === rep.id}
      {@const panes = group.agents.length}
      <div
        class="tab"
        class:active={group.groupId === app.activeGroup}
        class:dragging={dragId === group.groupId && dragMoved}
        data-gid={group.groupId}
        data-state={st}
        data-task={app.effectiveLane(rep)}
        style="--state:{meta.color}; --tint:{taskMeta.color}"
        role="tab"
        tabindex="0"
        animate:flip={{ duration: 160 }}
        onpointerdown={(e) => onPointerDown(e, group.groupId)}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
        onclick={() => onTabClick(group.groupId)}
        ondblclick={() => startRename(rep)}
        oncontextmenu={(e) => openMenu(e, group.groupId, rep, panes)}
        onkeydown={(e) => e.key === "Enter" && !editing && app.setActiveTab(group.groupId)}
      >
        <span class="state-dot" data-state={st} title={meta.label}></span>
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
              editKey(e, rep.id);
            }}
            onblur={() => commit(rep.id)}
          />
        {:else}
          <span class="name">{rep.name}</span>
          {#if panes > 1}<span class="panes" title="{panes} panes"><Icon name="columns" size={11} />{panes}</span>{/if}
          {#if i < 9}<span class="hint">⌘{i + 1}</span>{/if}
          <button
            class="close"
            title={panes > 1 ? `Close tab (${panes} panes)` : "Close"}
            aria-label="Close tab"
            onpointerdown={(e) => e.stopPropagation()}
            onclick={(e) => {
              e.stopPropagation();
              app.closeTab(group.groupId);
            }}><Icon name="close" size={13} /></button
          >
        {/if}
      </div>
    {/each}

    <button class="new-tab" title="New agent (⌘T)" onclick={onNewAgent} aria-label="New agent">
      <Icon name="plus" size={16} />
    </button>
  </div>
</div>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => (menu = null)} />
{/if}

<style>
  .tabbar {
    height: 38px;
    flex-shrink: 0;
    display: flex;
    align-items: stretch;
    background: var(--surface-1);
    border-bottom: 1px solid var(--border);
    overflow: hidden;
  }
  .tabs {
    display: flex;
    align-items: stretch;
    gap: 4px;
    padding: 5px 6px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tabs::-webkit-scrollbar {
    display: none;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 8px 0 10px;
    height: 28px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: var(--surface-2);
    color: var(--text-secondary);
    font-size: 12.5px;
    cursor: grab;
    white-space: nowrap;
    touch-action: none;
    transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
  }
  .tab:hover {
    background: var(--surface-3);
    color: var(--text);
  }
  /* Selected tab is tinted by the agent's task status color. */
  .tab.active {
    background: color-mix(in srgb, var(--tint) 14%, var(--surface-2));
    border-color: color-mix(in srgb, var(--tint) 55%, transparent);
    color: var(--text);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.04),
      0 0 0 3px color-mix(in srgb, var(--tint) 13%, transparent);
  }
  /* Every tab's label is tinted by its task status. */
  .tab[data-task="in-progress"] .name,
  .tab[data-task="testing"] .name,
  .tab[data-task="done"] .name {
    color: color-mix(in srgb, var(--tint) 62%, var(--text));
  }
  .tab.dragging {
    cursor: grabbing;
    opacity: 0.9;
    border-color: color-mix(in srgb, var(--tint) 55%, transparent);
    box-shadow: var(--shadow-md);
    z-index: 2;
  }

  /* Dot color = task status; pulse = live activity (working/blocked). */
  .state-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--tint, var(--text-faint));
  }
  .state-dot[data-state="working"] {
    animation: dot-pulse 1s ease-in-out infinite;
  }
  .state-dot[data-state="done"] {
    box-shadow: 0 0 6px var(--ok-glow);
  }
  .state-dot[data-state="blocked"] {
    animation: dot-pulse 0.9s ease-in-out infinite;
  }
  @keyframes dot-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.55; transform: scale(0.82); }
  }

  .name {
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Small badge showing how many panes a split tab holds. */
  .panes {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    font-size: 10px;
    font-weight: 700;
    color: var(--text-muted);
    background: var(--surface-4);
    padding: 1px 5px 1px 4px;
    border-radius: 6px;
  }
  .hint {
    font-size: 9.5px;
    color: var(--text-faint);
    font-family: ui-monospace, monospace;
  }

  .rename-input {
    width: 130px;
    font-size: 12.5px;
    font-family: inherit;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--accent);
    border-radius: 5px;
    padding: 1px 5px;
    outline: none;
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
    transition: color 0.13s, background 0.13s, opacity 0.13s;
  }
  .tab:hover .close,
  .tab.active .close {
    opacity: 1;
  }
  .close:hover {
    color: var(--danger);
    background: rgba(255, 107, 107, 0.12);
  }

  .new-tab {
    width: 28px;
    height: 28px;
    padding: 0;
    display: grid;
    place-items: center;
    border: 1px dashed var(--border-strong);
    border-radius: 8px;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    flex-shrink: 0;
    transition: color 0.13s, background 0.13s, border-color 0.13s;
  }
  .new-tab:hover {
    border-color: var(--accent);
    color: var(--accent-bright);
    border-style: solid;
    background: var(--surface-2);
  }
</style>
