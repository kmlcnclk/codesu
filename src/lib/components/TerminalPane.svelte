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
  let started = false;
  let seeded = false;

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

  // Lazily start the PTY the first time this pane becomes active; refit on re-activation.
  $effect(() => {
    if (active) {
      if (!started) start();
      else requestAnimationFrame(reveal);
    }
  });

  onDestroy(() => handle?.dispose());
</script>

<!-- Clicking into the terminal marks a finished (done) agent as reviewed → idle.
     Blocked agents are unaffected (they clear only when Claude resumes). -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="pane" class:active onpointerdown={() => app.markReviewed(agent.id)}>
  <div class="term" bind:this={container}></div>
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
</style>
