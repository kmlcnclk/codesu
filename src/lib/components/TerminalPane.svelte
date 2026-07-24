<script lang="ts">
  import { onDestroy } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { createTerminal, type TerminalHandle } from "$lib/terminal/createTerminal";
  import { app, shellQuote, type Agent } from "$lib/store/app.svelte";

  let {
    agent,
    active,
    cwd,
  }: { agent: Agent; active: boolean; cwd: string | null } = $props();

  let container: HTMLDivElement;
  let handle: TerminalHandle | undefined;
  let started = $state(false);
  let seeded = false;

  // Has the user explicitly opened this agent this run? Only then may its PTY /
  // Claude session start. A restored-active agent (app reopen) is NOT launched, so
  // it stays dormant — preventing many Claude processes from spawning at once —
  // until clicked. (Switching into a workspace does launch its active agent.)
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
      if (active) requestAnimationFrame(reveal);
    } catch (err) {
      console.error("[Codesu] terminal failed to start", err);
    }
  }

  function reveal() {
    handle?.fit();
    handle?.focus();
  }

  // Lazily start the PTY the first time this pane becomes active AND the user has
  // opened the agent; refit on re-activation. Gating on `launched` is what keeps a
  // restored/inactive agent's Claude session dormant until the user clicks it.
  //
  // `launched` also flips back to false when the idle-reaper puts an unused,
  // off-screen agent to sleep (see AppState.sleepAgent). We tear the PTY down here
  // but keep the Claude session — reopening resumes it via `claude --resume`, and
  // the "Resume" placeholder returns because `started` drops back to false.
  $effect(() => {
    if (active && launched) {
      if (!started) start();
      else requestAnimationFrame(reveal);
    } else if (started && !launched) {
      handle?.dispose();
      handle = undefined;
      started = false;
      seeded = false;
    }
  });

  onDestroy(() => handle?.dispose());
</script>

<!-- Clicking into the terminal marks a finished (done) agent as reviewed → idle.
     Blocked agents are unaffected (they clear only when Claude resumes). -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="pane" class:active onpointerdown={() => app.markReviewed(agent.id)}>
  <div class="term" bind:this={container}></div>
  {#if active && !started}
    <!-- Agent is on screen but its process hasn't been started this run (e.g. the
         restored-active agent right after reopening the app). Start it only on an
         explicit click so many agents never spin up at once. -->
    <button class="resume" onclick={() => app.launchAgent(agent.id)}>
      <span class="dot"></span>
      <span class="label">
        {agent.kind === "claude" ? "Resume Claude session" : "Start agent"}
      </span>
      <span class="hint">Click to start · dormant to save resources</span>
    </button>
  {/if}
</div>

<style>
  .pane {
    position: absolute;
    inset: 0;
    padding: 8px 6px 8px 12px;
    box-sizing: border-box;
    display: none;
  }
  .pane.active {
    display: block;
  }
  /*
   * xterm must mount into a padding-free element: the FitAddon measures this
   * element's height to pick the row count, so any padding here would shift the
   * canvas down and clip the bottom row. The padding lives on .pane instead.
   */
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
  .resume .dot {
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
