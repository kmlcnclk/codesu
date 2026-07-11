<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { createTerminal, type TerminalHandle } from "$lib/terminal/createTerminal";
  import Icon from "./Icon.svelte";

  let { onClose }: { onClose: () => void } = $props();

  let container = $state<HTMLDivElement | null>(null);
  let terminal: TerminalHandle | null = null;
  let error = $state<string | null>(null);

  onMount(async () => {
    if (!container) return;
    try {
      terminal = await createTerminal(container, "system-terminal", {
        shell: null,
        cwd: null,
        run: null,
      });
      terminal.focus();
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
      console.error("[Codesu] Failed to create terminal:", e);
    }
  });

  onDestroy(() => {
    terminal?.dispose();
  });

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onClose();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="modal-overlay">
  <div class="modal" role="dialog" aria-label="System terminal">
    <div class="header">
      <h2>Terminal</h2>
      <button class="close-btn" title="Close (⌘Esc)" onclick={onClose}>
        <Icon name="close" size={16} />
      </button>
    </div>
    <div class="terminal-container" bind:this={container}>
      {#if error}
        <div class="error">{error}</div>
      {/if}
    </div>
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 20px;
  }

  .modal {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 900px;
    height: 80vh;
    max-height: 600px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
    overflow: hidden;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
    background: linear-gradient(180deg, var(--surface-2), var(--surface-1));
  }

  h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }

  .close-btn {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: 6px;
    transition: background 0.13s, color 0.13s;
  }

  .close-btn:hover {
    background: var(--surface-3);
    color: var(--text);
  }

  .terminal-container {
    flex: 1;
    min-height: 0;
    overflow: hidden;
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
