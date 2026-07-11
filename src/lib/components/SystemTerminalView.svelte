<script lang="ts">
  import { onMount } from "svelte";
  import { createTerminal, type TerminalHandle } from "$lib/terminal/createTerminal";
  import { app } from "$lib/store/app.svelte";

  let container = $state<HTMLDivElement | null>(null);
  let terminal: TerminalHandle | null = null;
  let error = $state<string | null>(null);
  let isVisible = $state(true);

  onMount(async () => {
    if (!container) return;
    try {
      terminal = await createTerminal(container, "system-terminal", {
        shell: null,
        cwd: null,
        run: null,
      });
      // Restore scroll position after terminal is initialized
      if (app.terminalScrollPos > 0 && terminal) {
        terminal.setScrollPosition(app.terminalScrollPos);
      }
      terminal.focus();
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
      console.error("[Codesu] Failed to create terminal:", e);
    }
  });

  // Separate effect to setup visibility monitoring
  $effect(() => {
    if (!container?.parentElement || !terminal) return;

    const observer = new MutationObserver(() => {
      const newVisible = container?.parentElement?.style.display !== "none";
      if (newVisible && !isVisible) {
        // Terminal became visible - refit and restore scroll
        setTimeout(() => {
          terminal?.fit();
          if (app.terminalScrollPos > 0) {
            terminal?.setScrollPosition(app.terminalScrollPos);
          }
          terminal?.focus();
        }, 100);
      } else if (!newVisible && isVisible) {
        // Terminal became hidden - save scroll position
        if (terminal) {
          app.terminalScrollPos = terminal.getScrollPosition();
          app.persist();
        }
      }
      isVisible = newVisible;
    });

    observer.observe(container.parentElement, {
      attributes: true,
      attributeFilter: ["style"],
    });

    return () => {
      observer.disconnect();
      // Save scroll position when component is truly destroyed
      if (terminal) {
        app.terminalScrollPos = terminal.getScrollPosition();
        app.persist();
      }
      terminal?.dispose();
    };
  });
</script>

<div class="view">
  <div class="terminal-container" bind:this={container}>
    {#if error}
      <div class="error">{error}</div>
    {/if}
  </div>
</div>

<style>
  .view {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    background: var(--term-bg);
  }

  .terminal-container {
    position: absolute;
    inset: 0;
    background: var(--term-bg);
  }

  .error {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--danger);
    font-size: 13px;
    padding: 20px;
    text-align: center;
  }
</style>
