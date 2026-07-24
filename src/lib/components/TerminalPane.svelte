<script lang="ts">
  import { onDestroy } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { createTerminal, type TerminalHandle } from "$lib/terminal/createTerminal";
  import { app, shellQuote, STATE_META, type Agent } from "$lib/store/app.svelte";
  import type { Rect } from "$lib/terminal/layout";
  import Icon from "./Icon.svelte";

  let {
    agent,
    rect,
    visible,
    focused,
    cwd,
  }: {
    agent: Agent;
    /** Where this pane sits in the split grid (fractions of the area). */
    rect: Rect | undefined;
    /** True when this pane is a leaf of the on-screen tab. */
    visible: boolean;
    /** True when this is the focused pane (⌘D target, keyboard focus). */
    focused: boolean;
    cwd: string | null;
  } = $props();

  let container: HTMLDivElement;
  let handle: TerminalHandle | undefined;
  let started = $state(false);
  let seeded = false;

  const meta = $derived(STATE_META[agent.state]);

  // Has the user explicitly opened this agent this run? Only then may its PTY /
  // Claude session start. A restored agent (app reopen) is NOT launched, so it
  // stays dormant — preventing many Claude processes from spawning at once — until
  // clicked. (Splitting or switching into a workspace launches the relevant panes.)
  let launched = $derived(app.isLaunched(agent.id));

  /**
   * Choose the exact Claude command by checking whether the session file really
   * exists — resume if it does, create it (by id) if it doesn't. This avoids the
   * "No conversation found" error from guessing wrong. A `||` fallback covers races.
   */
  async function resolveRun(): Promise<string | null> {
    if (agent.kind === "claude" && agent.sessionId) {
      const id = agent.sessionId;
      let exists = false;
      try {
        exists = await invoke<boolean>("claude_session_exists", { sessionId: id });
      } catch {
        /* fall through to create-first */
      }
      // Seed the task prompt only when creating a brand-new session (first launch).
      seeded = !exists && !agent.sessionStarted && !!agent.initialPrompt;
      const seed = seeded ? " " + shellQuote(agent.initialPrompt!) : "";
      return exists
        ? `claude --resume ${id} || claude --session-id ${id}`
        : `claude --session-id ${id}${seed} || claude --resume ${id}`;
    }
    return app.effectiveRun(agent);
  }

  async function start() {
    if (started) return;
    started = true;
    try {
      const run = await resolveRun();
      handle = await createTerminal(container, agent.id, {
        run,
        cwd,
        onOutput: (text) => app.noteOutput(agent.id, text),
        onInput: (data) => {
          app.noteInput(agent.id, data);
          // Typing into the terminal counts as reviewing a finished agent.
          app.markReviewed(agent.id);
        },
      });
      app.markRunning(agent.id);
      app.markSessionStarted(agent.id);
      // An auto-seeded first prompt is a turn the agent starts without a keystroke.
      if (seeded) app.beginTurn(agent.id);
      requestAnimationFrame(() => handle?.fit());
    } catch (err) {
      console.error("[Codesu] terminal failed to start", err);
    }
  }

  // Lazily start the PTY the first time this pane is on screen AND the user has
  // opened the agent; refit whenever it (re)appears or is resized (a divider drag
  // changes `rect`). Fit only — focus is handled separately so a resize can't steal
  // the keyboard from another pane. Gating on `launched` keeps a restored/inactive
  // agent's Claude session dormant until clicked.
  //
  // `launched` flips back to false when the idle-reaper sleeps an unused, off-screen
  // agent (see AppState.sleepAgent). We tear the PTY down then but keep the Claude
  // session — reopening resumes it via `claude --resume`, and the "Resume" placeholder
  // returns because `started` drops back to false.
  $effect(() => {
    // Reference rect so a resize re-runs this effect and refits the terminal.
    void rect;
    void visible;
    if (visible && launched) {
      if (!started) start();
      else requestAnimationFrame(() => handle?.fit());
    } else if (started && !launched) {
      handle?.dispose();
      handle = undefined;
      started = false;
      seeded = false;
    }
  });

  // Give the keyboard to whichever pane is focused (⌘D target / clicked pane).
  $effect(() => {
    if (focused && visible && started) requestAnimationFrame(() => handle?.focus());
  });

  onDestroy(() => handle?.dispose());

  function focus() {
    app.setActiveAgent(agent.id);
    app.markReviewed(agent.id);
  }
  function splitRow() {
    focus();
    app.splitFocused("row");
  }
  function splitCol() {
    focus();
    app.splitFocused("col");
  }

  // Absolute placement from the layout rect (percentages of the area).
  const style = $derived(
    visible && rect
      ? `left:${rect.x * 100}%;top:${rect.y * 100}%;width:${rect.w * 100}%;height:${rect.h * 100}%;`
      : "",
  );
</script>

<!-- Clicking into the pane focuses it and marks a finished (done) agent as reviewed
     → idle. Blocked agents are unaffected (they clear only when Claude resumes). -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="pane" class:visible class:focused {style} onpointerdown={focus}>
  <div class="head">
    <span class="dot" data-state={agent.state} style="--state:{meta.color}" title={meta.label}></span>
    <span class="pane-name">{agent.name}</span>
    <div class="actions">
      <button title="Split side by side (⌘D)" aria-label="Split side by side" onclick={(e) => { e.stopPropagation(); splitRow(); }}>
        <Icon name="columns" size={13} />
      </button>
      <button title="Split stacked (⌘⇧D)" aria-label="Split stacked" onclick={(e) => { e.stopPropagation(); splitCol(); }}>
        <Icon name="rows" size={13} />
      </button>
      <button title="Flip split direction (⌘⇧E)" aria-label="Flip split direction" onclick={(e) => { e.stopPropagation(); app.flipSplitOf(agent.id); }}>
        <Icon name="flip" size={13} />
      </button>
      <button class="close" title="Close pane" aria-label="Close pane" onclick={(e) => { e.stopPropagation(); app.removeAgent(agent.id); }}>
        <Icon name="close" size={13} />
      </button>
    </div>
  </div>

  <div class="term-wrap">
    <div class="term" bind:this={container}></div>
    {#if visible && !started}
      <!-- Agent is on screen but its process hasn't started this run (e.g. a restored
           pane after reopening the app). Start it only on an explicit click so many
           agents never spin up at once. -->
      <button class="resume" onclick={(e) => { e.stopPropagation(); app.launchAgent(agent.id); }}>
        <span class="rdot"></span>
        <span class="label">
          {agent.kind === "claude" ? "Resume Claude session" : "Start agent"}
        </span>
        <span class="hint">Click to start · dormant to save resources</span>
      </button>
    {/if}
  </div>
</div>

<style>
  .pane {
    position: absolute;
    box-sizing: border-box;
    display: none;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--term-bg);
    overflow: hidden;
  }
  .pane.visible {
    display: flex;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 26px;
    flex-shrink: 0;
    padding: 0 6px 0 10px;
    background: var(--surface-1);
    border-bottom: 1px solid var(--border);
    border-left: 2px solid transparent;
    user-select: none;
  }
  /* The focused pane is where ⌘D lands & the keyboard types — make it obvious. */
  .pane.focused .head {
    border-left-color: var(--accent, #6e8bff);
    background: color-mix(in srgb, var(--accent, #6e8bff) 10%, var(--surface-1));
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--state, var(--text-faint));
  }
  .dot[data-state="working"],
  .dot[data-state="blocked"] {
    animation: dot-pulse 1s ease-in-out infinite;
  }
  @keyframes dot-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.55; transform: scale(0.82); }
  }
  .pane-name {
    flex: 1;
    min-width: 0;
    font-size: 11.5px;
    font-weight: 600;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pane.focused .pane-name {
    color: var(--text-secondary);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 2px;
    opacity: 0;
    transition: opacity 0.12s ease;
  }
  .head:hover .actions,
  .pane.focused .actions {
    opacity: 1;
  }
  .actions button {
    width: 20px;
    height: 20px;
    display: grid;
    place-items: center;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text-faint);
    border-radius: 5px;
    cursor: pointer;
    transition: color 0.12s, background 0.12s;
  }
  .actions button:hover {
    color: var(--text);
    background: var(--surface-3);
  }
  .actions .close:hover {
    color: var(--danger);
    background: rgba(255, 107, 107, 0.12);
  }

  .term-wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    /*
     * xterm must mount into a padding-free element: the FitAddon measures the .term
     * element's height to pick the row count, so any padding there would shift the
     * canvas down and clip the bottom row. The padding lives on this wrapper.
     */
    padding: 6px 4px 6px 10px;
    box-sizing: border-box;
  }
  .term {
    width: 100%;
    height: 100%;
  }

  /* Dormant-agent placeholder: covers the (empty) terminal until the user starts it. */
  .resume {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background: var(--term-bg);
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    font: inherit;
    user-select: none;
  }
  .resume .rdot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--accent, #6e8bff);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent, #6e8bff) 22%, transparent);
  }
  .resume .label {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-secondary);
  }
  .resume .hint {
    font-size: 12px;
    color: var(--text-faint);
  }
  .resume:hover .label {
    color: var(--text);
  }
</style>
