<script lang="ts">
  import { fade } from "svelte/transition";

  export interface MenuItem {
    label: string;
    onSelect?: () => void;
    danger?: boolean;
    checked?: boolean;
    /** Small color swatch shown before the label (e.g. task status). */
    color?: string;
    /** Raw inline SVG markup shown before the label (e.g. an editor logo). */
    iconSvg?: string;
    separatorBefore?: boolean;
    disabled?: boolean;
  }

  let {
    x,
    y,
    items,
    onClose,
  }: { x: number; y: number; items: MenuItem[]; onClose: () => void } = $props();

  // Clamp within viewport.
  const left = $derived(Math.min(x, window.innerWidth - 210));
  const top = $derived(Math.min(y, window.innerHeight - items.length * 32 - 12));

  function choose(item: MenuItem) {
    if (item.disabled) return;
    item.onSelect?.();
    onClose();
  }
</script>

<svelte:window
  onkeydown={(e) => e.key === "Escape" && onClose()}
  onmousedown={onClose}
  onblur={onClose}
/>

<div
  class="menu"
  style="left:{left}px; top:{top}px"
  transition:fade={{ duration: 90 }}
  role="menu"
  tabindex="-1"
  onmousedown={(e) => e.stopPropagation()}
>
  {#each items as item}
    {#if item.separatorBefore}
      <div class="sep"></div>
    {/if}
    <button
      class="item"
      class:danger={item.danger}
      class:disabled={item.disabled}
      role="menuitem"
      onclick={() => choose(item)}
    >
      {#if item.iconSvg}
        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
        <span class="menu-icon">{@html item.iconSvg}</span>
      {:else if item.color}
        <span class="swatch" style="background:{item.color}"></span>
      {:else if item.checked !== undefined}
        <span class="check">{item.checked ? "✓" : ""}</span>
      {/if}
      <span class="label">{item.label}</span>
      {#if item.color && item.checked}
        <span class="tick">✓</span>
      {/if}
    </button>
  {/each}
</div>

<style>
  .menu {
    position: fixed;
    z-index: 200;
    min-width: 196px;
    padding: 4px;
    background: var(--surface-float);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55);
  }
  .item {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 7px 10px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
    transition: background 0.12s ease, color 0.12s ease;
  }
  .item:hover {
    background: var(--surface-4);
    color: var(--text);
  }
  .item.danger {
    color: var(--danger);
  }
  .item.danger:hover {
    background: rgba(255, 107, 107, 0.14);
  }
  .item.disabled {
    color: var(--text-faint);
    cursor: default;
  }
  .item.disabled:hover {
    background: transparent;
  }
  .swatch {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .menu-icon {
    display: grid;
    place-items: center;
    flex-shrink: 0;
  }
  .menu-icon :global(svg) {
    display: block;
    width: 16px;
    height: 16px;
  }
  .check {
    width: 12px;
    text-align: center;
    color: var(--accent);
    font-size: 11px;
  }
  .label {
    flex: 1;
  }
  .tick {
    color: var(--accent);
    font-size: 11px;
    flex-shrink: 0;
  }
  .sep {
    height: 1px;
    margin: 4px 6px;
    background: var(--border);
  }
</style>
