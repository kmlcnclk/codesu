<script lang="ts">
  import Self from "./FileTree.svelte";
  import Icon from "./Icon.svelte";
  import { listDir, type DirEntry } from "$lib/code/api";

  let {
    root,
    dir,
    depth = 0,
    expanded,
    showHidden = false,
    activePath = null,
    changed,
    onOpen,
  }: {
    /** Workspace root — every fs call is scoped to it (see `fsx` on the Rust side). */
    root: string;
    /** Absolute path of the directory this level lists. */
    dir: string;
    depth?: number;
    /**
     * Absolute paths of every expanded directory, shared by the whole tree so a branch
     * that scrolls out of view (and unmounts) comes back open.
     */
    expanded: Set<string>;
    showHidden?: boolean;
    activePath?: string | null;
    /** Absolute paths git reports as changed — dotted in the tree. */
    changed: Set<string>;
    onOpen: (path: string) => void;
  } = $props();

  let entries = $state<DirEntry[] | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    // Re-read whenever the directory changes. A manual refresh remounts the whole tree
    // (the parent keys it), so there is nothing else to invalidate here.
    const d = dir;
    let cancelled = false;
    listDir(root, d)
      .then((list) => {
        if (cancelled) return;
        entries = list;
        error = null;
      })
      .catch((e) => {
        if (cancelled) return;
        error = String(e);
        entries = [];
      });
    return () => {
      cancelled = true;
    };
  });

  const visible = $derived((entries ?? []).filter((e) => showHidden || !e.hidden));

  function toggle(entry: DirEntry) {
    // The parent hands down a SvelteSet, so mutating it is what notifies every level —
    // a plain Set would need reassignment, which a non-bindable prop does not allow.
    if (expanded.has(entry.path)) expanded.delete(entry.path);
    else expanded.add(entry.path);
  }
</script>

{#if error}
  <div class="tree-error" style:padding-left="{depth * 12 + 10}px">{error}</div>
{:else if entries === null}
  <div class="tree-loading" style:padding-left="{depth * 12 + 10}px">Loading…</div>
{:else}
  {#each visible as entry (entry.path)}
    {@const open = entry.isDir && expanded.has(entry.path)}
    <button
      class="row"
      class:dir={entry.isDir}
      class:active={!entry.isDir && entry.path === activePath}
      class:heavy={entry.heavy}
      style:padding-left="{depth * 12 + 8}px"
      title={entry.path}
      onclick={() => (entry.isDir ? toggle(entry) : onOpen(entry.path))}
    >
      {#if entry.isDir}
        <span class="chev" class:open><Icon name="chevronDown" size={12} /></span>
      {:else}
        <span class="chev spacer"></span>
      {/if}
      <span class="ico" class:open><Icon name={entry.isDir ? "folder" : "file"} size={13} /></span>
      <span class="name">{entry.name}</span>
      {#if changed.has(entry.path)}<span class="dot" title="Modified"></span>{/if}
    </button>
    {#if open}
      <Self
        {root}
        dir={entry.path}
        depth={depth + 1}
        {expanded}
        {showHidden}
        {activePath}
        {changed}
        {onOpen}
      />
    {/if}
  {/each}
  {#if visible.length === 0}
    <div class="tree-empty" style:padding-left="{depth * 12 + 10}px">empty</div>
  {/if}
{/if}

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 5px;
    width: 100%;
    height: 24px;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    font-size: 12.5px;
    font-family: var(--font-sans);
    text-align: left;
    padding: 0 8px;
    cursor: pointer;
    border-radius: 5px;
    white-space: nowrap;
  }
  .row:hover {
    background: var(--surface-3);
    color: var(--text);
  }
  .row.active {
    background: var(--accent-soft);
    color: var(--accent-bright);
    box-shadow: inset 0 0 0 1px var(--accent-softer);
  }
  .row.dir {
    color: var(--text);
    font-weight: 600;
  }
  /* An expanded folder is where you are; a collapsed one is somewhere you could go. */
  .ico.open {
    color: var(--accent-bright);
  }
  .row.heavy {
    color: var(--text-faint);
    font-weight: 500;
  }
  .chev {
    display: grid;
    place-items: center;
    width: 12px;
    color: var(--text-faint);
    transform: rotate(-90deg);
    transition: transform var(--t-fast);
  }
  .chev.open {
    transform: rotate(0deg);
  }
  .chev.spacer {
    transform: none;
  }
  .ico {
    display: grid;
    place-items: center;
    color: var(--text-faint);
  }
  .row.dir .ico {
    color: var(--accent-dim);
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--warn);
    margin-left: auto;
    flex-shrink: 0;
  }
  .tree-error,
  .tree-loading,
  .tree-empty {
    font-size: 11px;
    color: var(--text-ghost);
    padding: 2px 8px;
  }
  .tree-error {
    color: var(--danger);
  }
</style>
