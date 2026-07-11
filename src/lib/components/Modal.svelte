<script lang="ts">
  import { fade, scale } from "svelte/transition";
  import type { Snippet } from "svelte";

  let {
    title,
    onClose,
    children,
    width = 440,
  }: { title: string; onClose: () => void; children: Snippet; width?: number } = $props();

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") onClose();
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="backdrop" transition:fade={{ duration: 100 }} onclick={onClose} role="presentation">
  <div
    class="modal"
    style="width:{width}px"
    transition:scale={{ duration: 140, start: 0.95 }}
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
  >
    <header class="head">
      <h3>{title}</h3>
      <button class="x" onclick={onClose} aria-label="Close">×</button>
    </header>
    <div class="body">
      {@render children()}
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(3, 6, 11, 0.6);
    backdrop-filter: blur(3px);
    display: grid;
    place-items: center;
    z-index: 100;
  }
  .modal {
    max-width: calc(100vw - 40px);
    max-height: calc(100vh - 48px);
    display: flex;
    flex-direction: column;
    background: var(--surface-float);
    border: 1px solid var(--border-strong);
    border-radius: 12px;
    box-shadow: var(--shadow-xl);
    overflow: hidden;
  }
  .head {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 18px;
    border-bottom: 1px solid var(--border);
  }
  .head h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }
  .x {
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 24px;
    line-height: 1;
    cursor: pointer;
    padding: 0;
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border-radius: 6px;
    transition: background 0.12s ease, color 0.12s ease;
  }
  .x:hover {
    background: var(--surface-3);
    color: var(--text);
  }
  .body {
    padding: 16px;
    overflow-y: auto;
  }
</style>
