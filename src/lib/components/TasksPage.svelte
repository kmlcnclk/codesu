<script lang="ts">
  import { flip } from "svelte/animate";
  import { app, TASK_META, TASK_STATUSES, type Agent } from "$lib/store/app.svelte";
  import Icon from "./Icon.svelte";

  let { onOpenAgent }: { onOpenAgent: (agentId: string) => void } = $props();

  // Pointer-based drag reorder — HTML5 DnD is unreliable/janky in the webview
  // (same reason TabBar.svelte uses pointers). We track the drag manually and
  // only mutate state when the target slot actually changes, so hovering doesn't
  // churn reactivity every frame.
  let dragId = $state<string | null>(null);
  let dragMoved = $state(false);
  let dragLane = $state<string | null>(null);
  let dropLane = $state<string | null>(null);
  let dropIndex = $state<number>(-1);
  let startX = 0;
  let startY = 0;
  let suppressClick = false;

  function onPointerDown(e: PointerEvent, agentId: string, laneId: string) {
    if (e.button !== 0) return;
    dragId = agentId;
    dragLane = laneId;
    dropLane = laneId;
    dragMoved = false;
    startX = e.clientX;
    startY = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (dragId === null) return;
    if (!dragMoved && Math.abs(e.clientX - startX) < 4 && Math.abs(e.clientY - startY) < 4) return;
    dragMoved = true;

    // Which column is the cursor over?
    const col = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>(
      ".col-body",
    );
    const lane = col?.dataset.lane ?? null;
    if (!lane) return;

    // Insertion slot = how many cards sit above the cursor's center.
    const cards = Array.from(col!.querySelectorAll<HTMLElement>(".agent-card")).filter(
      (el) => el.dataset.id !== dragId,
    );
    let idx = 0;
    for (const el of cards) {
      const r = el.getBoundingClientRect();
      if (e.clientY > r.top + r.height / 2) idx++;
    }

    // Only write state when the slot actually changes — avoids per-frame churn.
    if (lane === dropLane && idx === dropIndex) return;
    dropLane = lane;
    dropIndex = idx;
  }

  function onPointerUp(e: PointerEvent) {
    if (dragId === null) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be gone */
    }
    if (dragMoved && dropLane) {
      commitDrag(dragId, dragLane!, dropLane, dropIndex);
      suppressClick = true;
    }
    dragId = null;
    dragMoved = false;
    dragLane = null;
    dropLane = null;
    dropIndex = -1;
  }

  function commitDrag(agentId: string, fromLane: string, toLane: string, toIndex: number) {
    const agent = app.agents.find((a) => a.id === agentId);
    if (!agent) return;

    // Moving to a different lane changes the agent's status.
    if (fromLane !== toLane) {
      if (agent.taskId) {
        const task = app.tasks.find((t) => t.id === agent.taskId);
        if (task && task.status !== "idea") app.updateTask(task.id, { status: toLane as any });
      } else {
        app.setAgentLane(agent.id, toLane as any);
      }
    }

    // Reindex the destination lane so order reflects the new position.
    const laneAgents = (agentsByLane[toLane] || []).filter((a) => a.id !== agentId);
    laneAgents.splice(Math.min(toIndex, laneAgents.length), 0, agent);
    for (let i = 0; i < laneAgents.length; i++) laneAgents[i].order = i;
    app.persist();
  }

  function onCardClick(agent: Agent) {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    openAgent(agent);
  }

  // Pre-compute archived workspace IDs for faster lookup
  const archivedWsIds = $derived.by(() => {
    return new Set(app.workspaces.filter((w) => w.archived).map((w) => w.id));
  });

  // Agents shown in kanban by their lane status (excluding agents from archived workspaces and agents linked to ideas)
  const agentsByLane = $derived.by(() => {
    const grouped: Record<string, Agent[]> = {
      backlog: [],
      "in-progress": [],
      testing: [],
      done: [],
    };

    for (const agent of app.agents) {
      // Skip agents from archived workspaces (fast set lookup)
      if (agent.workspaceId && archivedWsIds.has(agent.workspaceId)) continue;

      // Skip agents linked to idea tasks (check map first)
      if (agent.taskId && taskMap.get(agent.taskId)) {
        const task = app.tasks.find((t) => t.id === agent.taskId);
        if (task?.status === "idea") continue;
      }

      const lane = app.effectiveLane(agent);
      if (lane in grouped) {
        grouped[lane].push(agent);
      }
    }

    // Sort each lane's agents by order field (single pass). This list spans all
    // workspaces, where `order` is only unique *within* a workspace, so two agents
    // from different workspaces can share an order — tie-break on createdAt (then id)
    // to keep the arrangement deterministic and stable across app restarts.
    Object.keys(grouped).forEach((lane) => {
      grouped[lane].sort(
        (a, b) => a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
      );
    });

    return grouped;
  });

  // Cache workspace lookups
  const workspaceMap = $derived.by(() => {
    const map = new Map();
    for (const ws of app.workspaces) {
      map.set(ws.id, ws.name);
    }
    return map;
  });

  function getWorkspaceName(wsId: string | null): string {
    if (!wsId) return "No workspace";
    return workspaceMap.get(wsId) ?? "Unknown";
  }

  // Cache task lookups
  const taskMap = $derived.by(() => {
    const map = new Map();
    for (const t of app.tasks) {
      map.set(t.id, t.title);
    }
    return map;
  });

  function getTaskTitle(taskId: string | null): string {
    if (!taskId) return "Not assigned";
    return taskMap.get(taskId) ?? "Unknown task";
  }

  function fmtDate(ts: number): string {
    try {
      return new Date(ts).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  }

  function openAgent(agent: Agent) {
    onOpenAgent(agent.id);
  }

  const totalAgents = $derived(
    TASK_STATUSES.reduce((n, s) => n + (agentsByLane[s]?.length ?? 0), 0),
  );
</script>

<div class="page">
  <header class="page-head">
    <div class="titles">
      <h1>Tasks</h1>
      <p>Your agents on a board — drag a card to change its status.</p>
    </div>
    {#if totalAgents > 0}
      <span class="total">{totalAgents} agent{totalAgents === 1 ? "" : "s"}</span>
    {/if}
  </header>

  {#if totalAgents === 0}
    <div class="board-empty">
      <div class="glyph"><Icon name="tasks" size={38} stroke={1.3} /></div>
      <h2>No agents to track yet</h2>
      <p>Start an agent from the Agents view — it'll appear here so you can move it across Backlog, In progress, Testing and Done.</p>
    </div>
  {:else}
  <div class="board">
    {#each TASK_STATUSES as status (status)}
      {@const meta = TASK_META[status]}
      {@const agents = agentsByLane[status]}
      <section class="column" style="--accent:{meta.color}" role="list">
        <header class="col-head">
          <span class="col-dot"></span>
          <span class="col-title">{meta.label}</span>
          <span class="col-count">{agents.length}</span>
        </header>

        <div class="col-body" role="list" data-lane={status}>
          {#each agents as agent, i (agent.id)}
            {@const taskTitle = getTaskTitle(agent.taskId)}
            {@const wsName = getWorkspaceName(agent.workspaceId)}
            <button
              class="agent-card"
              class:dragging={dragId === agent.id && dragMoved}
              class:drop-before={dragMoved && dropLane === status && dropIndex === i}
              class:drop-after={dragMoved && dropLane === status && dropIndex >= agents.length && i === agents.length - 1}
              style="--status-color:{meta.color}"
              data-id={agent.id}
              animate:flip={{ duration: 200 }}
              onpointerdown={(e) => onPointerDown(e, agent.id, status)}
              onpointermove={onPointerMove}
              onpointerup={onPointerUp}
              onpointercancel={onPointerUp}
              onclick={() => onCardClick(agent)}
              title="Open agent"
            >
              <div class="agent-header">
                <div class="agent-name">{agent.name}</div>
                <div class="agent-kind">{agent.kind}</div>
              </div>
              <div class="agent-info">
                <div class="info-row">
                  <span class="info-label">Workspace:</span>
                  <span class="info-value">{wsName}</span>
                </div>
                <div class="info-row">
                  <span class="info-label">Task:</span>
                  <span class="info-value">{taskTitle}</span>
                </div>
              </div>
              <div class="agent-meta">
                <span class="meta-date">{fmtDate(agent.lastUsedAt)}</span>
              </div>
            </button>
          {/each}
          {#if agents.length === 0}
            <div
              class="empty-slot"
              class:drop-active={dragMoved && dropLane === status}
              style="--status-color:{meta.color}"
            >
              <Icon name="plus" size={16} />
              <span>Drop here</span>
            </div>
          {/if}
        </div>
      </section>
    {/each}
  </div>
  {/if}
</div>

<style>
  .page {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }

  /* Page header — matches History / Report / Settings. */
  .page-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    padding: 20px 24px 16px;
    border-bottom: 1px solid var(--border-muted);
  }
  .titles h1 {
    margin: 0;
    font-size: 20px;
    font-weight: 700;
    color: var(--text);
  }
  .titles p {
    margin: 3px 0 0;
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .total {
    flex-shrink: 0;
    font-size: 12px;
    font-weight: 700;
    color: var(--text-secondary);
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 4px 12px;
  }

  /* Whole-board empty state. */
  .board-empty {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    text-align: center;
    padding: 0 24px;
    color: var(--text-faint);
  }
  .board-empty .glyph {
    display: grid;
    place-items: center;
    width: 82px;
    height: 82px;
    border-radius: 50%;
    background: var(--surface-1);
    border: 1px solid var(--border);
    color: var(--text-muted);
  }
  .board-empty h2 {
    margin: 4px 0 0;
    font-size: 16px;
    color: var(--text-muted);
  }
  .board-empty p {
    margin: 0;
    font-size: 13px;
    max-width: 420px;
    line-height: 1.55;
  }

  .board {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 12px;
    padding: 16px;
    overflow-y: auto;
    background: var(--bg);
  }

  .column {
    flex: 0 0 320px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  }

  .col-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 14px 16px;
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .col-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
  }

  .col-title {
    font-weight: 600;
    font-size: 13px;
    color: var(--text);
    flex: 1;
  }

  .col-count {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
    background: color-mix(in srgb, var(--accent) 20%, transparent);
    padding: 2px 6px;
    border-radius: var(--r-xs);
  }

  .col-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    overflow-y: auto;
  }

  /* Placeholder shown in an empty column; highlights as a drop target. */
  .empty-slot {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 18px 12px;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-ghost);
    border: 1.5px dashed var(--border-strong);
    border-radius: 6px;
    transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
  }
  .empty-slot.drop-active {
    color: var(--status-color);
    border-color: var(--status-color);
    background: color-mix(in srgb, var(--status-color) 12%, transparent);
    animation: empty-pulse 1s ease-in-out infinite;
  }

  @keyframes empty-pulse {
    0%, 100% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--status-color) 40%, transparent);
    }
    50% {
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--status-color) 18%, transparent);
    }
  }

  .agent-card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    background: color-mix(in srgb, var(--status-color) 10%, var(--surface-2));
    border: 1px solid color-mix(in srgb, var(--status-color) 35%, var(--border));
    border-left: 4px solid var(--status-color);
    border-radius: 6px;
    cursor: grab;
    text-align: left;
    transition: background 0.12s ease, border-color 0.12s ease, transform 0.12s ease;
    width: 100%;
    touch-action: none;
  }

  .agent-card:hover {
    background: color-mix(in srgb, var(--status-color) 18%, var(--surface-3));
    border-color: color-mix(in srgb, var(--status-color) 55%, var(--border));
  }

  .agent-card:active {
    transform: scale(0.98);
  }

  .agent-card.dragging {
    opacity: 0.55;
    cursor: grabbing;
    transform: scale(1.03) rotate(-0.6deg);
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35);
    transition: none;
  }

  /* Insertion indicator shown between cards while dragging. */
  .agent-card.drop-before::before,
  .agent-card.drop-after::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    height: 3px;
    border-radius: 2px;
    background: var(--status-color);
    box-shadow: 0 0 6px color-mix(in srgb, var(--status-color) 70%, transparent);
    animation: drop-line-in 0.15s ease;
  }
  .agent-card.drop-before::before {
    top: -6px;
  }
  .agent-card.drop-after::after {
    bottom: -6px;
  }

  @keyframes drop-line-in {
    from {
      opacity: 0;
      transform: scaleX(0.6);
    }
    to {
      opacity: 1;
      transform: scaleX(1);
    }
  }

  .agent-header {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .agent-name {
    font-weight: 600;
    font-size: 13px;
    color: var(--text);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .agent-kind {
    font-size: 11px;
    font-weight: 600;
    color: var(--status-color);
    background: color-mix(in srgb, var(--status-color) 20%, transparent);
    padding: 2px 6px;
    border-radius: var(--r-xs);
    text-transform: capitalize;
    flex-shrink: 0;
    border: 1px solid color-mix(in srgb, var(--status-color) 40%, transparent);
  }

  .agent-info {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .info-row {
    display: flex;
    gap: 8px;
    font-size: 11px;
  }

  .info-label {
    color: var(--text-secondary);
    font-weight: 600;
    flex-shrink: 0;
  }

  .info-value {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .agent-meta {
    display: flex;
    justify-content: flex-end;
  }

  .meta-date {
    font-size: 10px;
    color: var(--text-ghost);
  }
</style>
