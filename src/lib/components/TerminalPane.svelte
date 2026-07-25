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
    showHeader,
    cwd,
  }: {
    agent: Agent;
    /** Where this pane sits in the split grid (fractions of the area). */
    rect: Rect | undefined;
    /** True when this pane is a leaf of the on-screen tab. */
    visible: boolean;
    /** True when this is the focused pane (⌘D target, keyboard focus). */
    focused: boolean;
    /** Only shown when the tab is split — a lone terminal needs no pane chrome. */
    showHeader: boolean;
    cwd: string | null;
  } = $props();

  let container: HTMLDivElement;
  let handle: TerminalHandle | undefined;
  let started = $state(false);
  let seeded = false;
  /**
   * Why the process could not start (most often: the workspace folder was moved or its
   * worktree deleted, so the PTY refuses a cwd that no longer exists). Shown in the
   * pane instead of leaving a blank terminal, and it also LATCHES the auto-start
   * effect off — without that, a failing spawn would be retried on every re-render.
   * Cleared by Retry, and on teardown so a later reopen tries again.
   */
  let error = $state<string | null>(null);
  /**
   * Bumped by every teardown. `start()` is async and can be in flight for a while
   * (it waits for the pane to be laid out before sizing the PTY), so a run whose
   * token is stale by the time it finishes must throw its terminal away instead of
   * installing it — otherwise closing or sleeping an agent mid-launch would leave an
   * orphan PTY nothing holds a handle to.
   */
  let runToken = 0;

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

  /**
   * Environment for this agent's shell.
   *
   * Claude Code keeps its typed-prompt history per PROJECT DIRECTORY, not per session, so
   * two agents in one workspace would offer each other's prompts on ↑ / ⌃R. Each Claude
   * agent therefore runs against its own config dir, assembled by the Rust side out of
   * symlinks to the real `~/.claude` (so credentials, settings, CLAUDE.md, commands,
   * skills and — crucially — the `projects/` transcripts `--resume` reads stay shared).
   *
   * Best effort by design: if the isolated home cannot be built the agent still launches,
   * just with the shared history it had before.
   */
  async function resolveEnv(): Promise<Record<string, string> | null> {
    if (agent.kind !== "claude") return null;
    try {
      return await invoke<Record<string, string>>("claude_agent_env", {
        agentId: agent.id,
        sessionId: agent.sessionId,
      });
    } catch (err) {
      console.warn("[Codesu] falling back to the shared Claude config dir", err);
      return null;
    }
  }

  async function start() {
    if (started) return;
    // An agent must run in a KNOWN directory. A null/blank cwd reaches the PTY as "no
    // cwd", which means $HOME — fine for the system terminal, but for an agent it is
    // the silent-relocation bug all over again (Claude Code then asks to trust `~`).
    // Refuse it here rather than pass it down. See AppState.cwdOf.
    if (!cwd?.trim()) {
      error = "No workspace folder set for this agent.";
      return;
    }
    started = true;
    const token = runToken;
    try {
      const run = await resolveRun();
      const env = await resolveEnv();
      const term = await createTerminal(container, agent.id, {
        run,
        cwd,
        env,
        onOutput: () => app.noteOutput(agent.id),
        onInput: (data) => {
          app.noteInput(agent.id, data);
          // Typing into the terminal counts as reviewing a finished agent.
          app.markReviewed(agent.id);
        },
      });
      if (token !== runToken) {
        term.dispose(); // torn down (closed / slept) while it was starting
        return;
      }
      handle = term;
      // Hand the activity monitor a window onto this terminal's live screen — that is
      // what working / blocked / done are read from (see AppState.tickMonitor).
      app.registerScreen(agent.id, (rows) => handle?.screen(rows) ?? "");
      app.markRunning(agent.id);
      // Pin the session to this exact directory so every later resume runs here —
      // `claude --resume` is cwd-scoped and would otherwise spawn an empty session.
      app.markSessionStarted(agent.id, cwd);
      // An auto-seeded first prompt is a turn the agent starts without a keystroke.
      if (seeded) app.beginTurn(agent.id);
      requestAnimationFrame(() => handle?.fit());
    } catch (err) {
      console.error("[Codesu] terminal failed to start", err);
      if (token === runToken) {
        // Surface it in the pane and allow a retry. A missing cwd is the common case:
        // the PTY rejects it rather than silently starting in $HOME (which used to make
        // Claude Code re-ask to trust the home directory on every open).
        error = String(err instanceof Error ? err.message : err) || "Failed to start";
        started = false;
        // The folder may have just disappeared — refresh the sidebar's flags too.
        void app.checkWorkspacePaths();
      }
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
      // `error` latches the auto-start off: a spawn that failed is retried only when
      // the user asks (Retry), never on every re-render of the pane.
      if (!started && !error) start();
      else if (started) requestAnimationFrame(() => handle?.fit());
    } else if (!launched) {
      if (started) {
        teardown();
        started = false;
        seeded = false;
      }
      // A fresh open (Resume click) should try again from scratch.
      error = null;
    }
  });

  /** Drop the terminal and invalidate any `start()` still in flight. */
  function teardown() {
    runToken++;
    // Drop the screen reader first: once the terminal is gone the monitor has no
    // ground truth, and it must leave this agent's state alone rather than guess.
    app.unregisterScreen(agent.id);
    handle?.dispose();
    handle = undefined;
  }

  // Give the keyboard to whichever pane is focused (⌘D target / clicked pane).
  $effect(() => {
    if (focused && visible && started) requestAnimationFrame(() => handle?.focus());
  });

  onDestroy(teardown);

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
<div class="pane" class:visible class:focused class:split={showHeader} {style} onpointerdown={focus}>
  <div class="card">
  {#if showHeader}
    <div class="head">
      <span class="dot" data-state={agent.state} style="--state:{meta.color}" title={meta.label}></span>
      <span class="pane-name">{agent.name}</span>
      <div class="actions">
        <button class="act" title="Split side by side (⌘D)" aria-label="Split side by side" onclick={(e) => { e.stopPropagation(); splitRow(); }}>
          <Icon name="columns" size={14} />
        </button>
        <button class="act" title="Split stacked (⌘⇧D)" aria-label="Split stacked" onclick={(e) => { e.stopPropagation(); splitCol(); }}>
          <Icon name="rows" size={14} />
        </button>
        <button class="act" title="Flip split direction (⌘⇧E)" aria-label="Flip split direction" onclick={(e) => { e.stopPropagation(); app.flipSplitOf(agent.id); }}>
          <Icon name="flip" size={14} />
        </button>
        <span class="sep"></span>
        <button class="act close" title="Close pane" aria-label="Close pane" onclick={(e) => { e.stopPropagation(); app.removeAgent(agent.id); }}>
          <Icon name="close" size={14} />
        </button>
      </div>
    </div>
  {/if}

  <div class="term-wrap">
    <div class="term" bind:this={container}></div>
    {#if visible && error}
      <!-- The process could not start. Say why, and name the folder — a moved workspace
           or a deleted worktree is by far the most common cause, and it is invisible
           otherwise. -->
      <div class="failed">
        <span class="fdot"></span>
        <span class="label">Couldn't start {agent.name}</span>
        <span class="reason">{error}</span>
        {#if app.isPathMissing(cwd)}
          <span class="hint">
            This workspace's folder no longer exists. Move it back, or remove the
            workspace from the sidebar.
          </span>
        {/if}
        <button class="retry" onclick={(e) => { e.stopPropagation(); error = null; }}>
          Retry
        </button>
      </div>
    {:else if visible && !started}
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
</div>

<style>
  .pane {
    position: absolute;
    box-sizing: border-box;
    display: none;
    min-width: 0;
    min-height: 0;
  }
  .pane.visible {
    display: block;
  }
  /* The visible surface is an inset, rounded card — so split panes read as
     distinct tiles with a little breathing room instead of edge-to-edge slabs.
     The inset also forms the gap between neighbouring panes, and the hairline
     border makes the radius legible against the near-black canvas. */
  .card {
    position: absolute;
    inset: 4px;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--term-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    transition: border-color 0.16s ease, box-shadow 0.16s ease;
  }
  /* The focused pane's card lifts with a brighter neutral border and a soft dark
     depth shadow — clear which pane ⌘D / the keyboard targets, without any color. */
  .pane.split.focused .card {
    border-color: var(--border-strong);
    box-shadow: 0 6px 22px -12px rgba(0, 0, 0, 0.55);
  }

  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    flex-shrink: 0;
    padding: 0 6px 0 11px;
    background: var(--surface-1);
    border-bottom: 1px solid var(--border);
    user-select: none;
    transition: background 0.14s ease;
  }
  /* The focused pane header lifts with a slightly brighter neutral surface — enough
     to read as active without competing with the card's focus border. */
  .pane.focused .head {
    background: var(--surface-3);
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--state, var(--text-faint));
    transition: box-shadow 0.14s ease;
  }
  .dot[data-state="working"],
  .dot[data-state="blocked"] {
    animation: dot-pulse 1s ease-in-out infinite;
  }
  .dot[data-state="done"] {
    box-shadow: 0 0 7px var(--state);
  }
  @keyframes dot-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.55; transform: scale(0.82); }
  }

  .pane-name {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.1px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: color 0.14s ease;
  }
  .pane.focused .pane-name {
    color: var(--text);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 1px;
    opacity: 0;
    transform: translateX(3px);
    transition: opacity 0.14s ease, transform 0.14s ease;
  }
  /* Reveal the controls on hover, and keep them faintly present on the focused pane
     so its affordances are always discoverable. */
  .head:hover .actions {
    opacity: 1;
    transform: none;
  }
  .pane.focused .actions {
    opacity: 0.75;
    transform: none;
  }
  .pane.focused .head:hover .actions {
    opacity: 1;
  }
  .act {
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text-muted);
    border-radius: 6px;
    cursor: pointer;
    transition: color 0.12s, background 0.12s;
  }
  .act:hover {
    color: var(--text);
    background: var(--surface-4);
  }
  .act:active {
    background: var(--surface-3);
  }
  .act.close:hover {
    color: var(--danger);
    background: rgba(255, 107, 107, 0.14);
  }
  /* Thin divider setting the destructive Close apart from the split controls. */
  .sep {
    width: 1px;
    height: 15px;
    margin: 0 3px;
    background: var(--border);
    flex-shrink: 0;
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

  /* Failed-to-start placeholder — same footprint as .resume, but not itself a button
     (it holds one), and the reason is selectable so a path can be copied out. */
  .failed {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 0 28px;
    text-align: center;
    background: var(--term-bg);
    color: var(--text-muted);
  }
  .failed .fdot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--danger, #ff6b6b);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--danger, #ff6b6b) 22%, transparent);
  }
  .failed .label {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-secondary);
  }
  .failed .reason {
    font-family: ui-monospace, monospace;
    font-size: 12px;
    color: var(--danger, #ff6b6b);
    user-select: text;
    overflow-wrap: anywhere;
  }
  .failed .hint {
    max-width: 46ch;
    font-size: 12px;
    line-height: 1.45;
    color: var(--text-faint);
  }
  .failed .retry {
    margin-top: 4px;
    padding: 5px 14px;
    font: inherit;
    font-size: 12.5px;
    color: var(--text-secondary);
    background: var(--surface-2);
    border: 1px solid var(--border-strong);
    border-radius: 7px;
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }
  .failed .retry:hover {
    color: var(--text);
    background: var(--surface-4);
  }
</style>
