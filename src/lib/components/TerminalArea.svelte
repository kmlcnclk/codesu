<script lang="ts">
  import { app } from "$lib/store/app.svelte";
  import TerminalPane from "./TerminalPane.svelte";
  import Icon from "./Icon.svelte";
  import { computeLayout, GUTTER_PX, type Gutter } from "$lib/terminal/layout";

  function cwdFor(workspaceId: string, agentCwd: string | null): string | null {
    if (agentCwd) return agentCwd;
    return app.workspaces.find((w) => w.id === workspaceId)?.path ?? null;
  }

  let areaEl: HTMLDivElement;

  // The on-screen tab's panes (as fractional rects) and its draggable dividers.
  const layout = $derived.by(() => {
    const l = app.visibleLayout;
    return l ? computeLayout(l) : { rects: {}, gutters: [] };
  });
  const rects = $derived(layout.rects);
  const gutters = $derived(layout.gutters);
  const activeGroup = $derived(app.activeGroup);

  // ---- divider drag-to-resize ----
  let drag: { g: Gutter; last: number; containerPx: number } | null = null;

  function onGutterDown(e: PointerEvent, g: Gutter) {
    e.preventDefault();
    e.stopPropagation();
    const r = areaEl.getBoundingClientRect();
    drag = {
      g,
      last: g.dir === "row" ? e.clientX : e.clientY,
      containerPx: g.dir === "row" ? r.width : r.height,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onGutterMove(e: PointerEvent) {
    if (!drag || !activeGroup) return;
    const cur = drag.g.dir === "row" ? e.clientX : e.clientY;
    // Convert the incremental pixel move into a fraction of THIS split's own axis
    // extent (its share of the container), then hand it to the store.
    const splitPx = drag.containerPx * drag.g.spanFrac;
    if (splitPx > 0) {
      app.resizePane(activeGroup, drag.g.path, drag.g.index, (cur - drag.last) / splitPx);
    }
    drag.last = cur;
  }
  function onGutterUp(e: PointerEvent) {
    if (!drag) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be gone */
    }
    drag = null;
  }

  function gutterStyle(g: Gutter): string {
    if (g.dir === "row") {
      return `left:calc(${g.x * 100}% - ${GUTTER_PX}px);top:${g.y * 100}%;width:${GUTTER_PX * 2}px;height:${g.h * 100}%;`;
    }
    return `left:${g.x * 100}%;top:calc(${g.y * 100}% - ${GUTTER_PX}px);width:${g.w * 100}%;height:${GUTTER_PX * 2}px;`;
  }
</script>

<div class="area" bind:this={areaEl}>
  {#if app.mountedAgents.length === 0}
    <div class="empty">
      {#if app.liveWorkspaces.length === 0}
        <div class="glyph"><Icon name="folder" size={34} stroke={1.4} /></div>
        <h2>No workspaces yet</h2>
        <p>Create a workspace from the left to start running agents.</p>
      {:else}
        <div class="glyph"><Icon name="terminal" size={34} stroke={1.4} /></div>
        <h2>No agents in this workspace</h2>
        <p>Press <kbd>⌘</kbd><kbd>T</kbd> or use the + tab to launch a Claude agent.</p>
      {/if}
    </div>
  {:else}
    {#each app.mountedAgents as agent (agent.id)}
      <TerminalPane
        {agent}
        rect={rects[agent.id]}
        visible={!!rects[agent.id]}
        focused={agent.id === app.activeAgent?.id}
        cwd={cwdFor(agent.workspaceId, agent.cwd)}
      />
    {/each}

    <!-- Draggable dividers between split panes. -->
    {#each gutters as g (g.path.join(".") + ":" + g.dir + g.index)}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="gutter {g.dir}"
        style={gutterStyle(g)}
        onpointerdown={(e) => onGutterDown(e, g)}
        onpointermove={onGutterMove}
        onpointerup={onGutterUp}
        onpointercancel={onGutterUp}
      ></div>
    {/each}

    {#if !app.activeAgent}
      <div class="empty overlay">
        <div class="glyph"><Icon name="terminal" size={34} stroke={1.4} /></div>
        <h2>No open agent</h2>
        <p>Press <kbd>⌘</kbd><kbd>T</kbd> or pick a tab above.</p>
      </div>
    {/if}
  {/if}
</div>

<style>
  .area {
    position: relative;
    flex: 1;
    min-height: 0;
    background: var(--term-bg);
    overflow: hidden;
  }
  /* Divider handles sit on the seam between panes, above the terminals. */
  .gutter {
    position: absolute;
    z-index: 5;
    background: transparent;
    touch-action: none;
  }
  .gutter.row {
    cursor: col-resize;
  }
  .gutter.col {
    cursor: row-resize;
  }
  .gutter::after {
    content: "";
    position: absolute;
    background: var(--border);
    transition: background 0.12s ease;
  }
  .gutter.row::after {
    left: 50%;
    top: 0;
    transform: translateX(-50%);
    width: 1px;
    height: 100%;
  }
  .gutter.col::after {
    top: 50%;
    left: 0;
    transform: translateY(-50%);
    height: 1px;
    width: 100%;
  }
  .gutter:hover::after {
    background: var(--accent, #6e8bff);
  }
  .gutter.row:hover::after {
    width: 2px;
  }
  .gutter.col:hover::after {
    height: 2px;
  }

  .empty {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: var(--text-faint);
    user-select: none;
    text-align: center;
    padding: 0 24px;
  }
  .empty.overlay {
    background: var(--term-bg);
    z-index: 6;
  }
  .empty .glyph {
    display: grid;
    place-items: center;
    width: 76px;
    height: 76px;
    margin-bottom: 2px;
    border-radius: 50%;
    background: var(--surface-1);
    border: 1px solid var(--border);
    color: var(--text-muted);
  }
  .empty h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--text-muted);
  }
  .empty p {
    margin: 0;
    font-size: 12.5px;
  }
  kbd {
    display: inline-block;
    padding: 1px 6px;
    margin: 0 1px;
    font-size: 11px;
    font-family: ui-monospace, monospace;
    color: var(--text-secondary);
    background: var(--border);
    border: 1px solid var(--border-strong);
    border-radius: 5px;
  }
</style>
