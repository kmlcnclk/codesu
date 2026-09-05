<script lang="ts">
  import Self from "./FileTree.svelte";
  import Icon from "./Icon.svelte";
  import { listDir, type DirEntry } from "$lib/code/api";
  import { fileBadge } from "$lib/code/fileIcons";

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

  /**
   * Collapsed folder chains, by the chain's FIRST directory: IntelliJ's "compact middle
   * packages".
   *
   * `src/main/kotlin/com/hiccup/aboutyou` is six clicks and six rows of indentation to
   * say one thing — the package. A directory whose only child is another directory
   * carries no choice, so the whole run is drawn as a single row and expanding it lands
   * on the first folder that actually branches.
   */
  let chains = $state<Record<string, { path: string; label: string }>>({});

  /** Past this, a listing is a directory of directories, not a package chain. */
  const MAX_CHAIN_PROBES = 60;
  /** A pathological symlink loop must not become an infinite walk. */
  const MAX_CHAIN_DEPTH = 12;

  async function resolveChain(entry: DirEntry): Promise<{ path: string; label: string }> {
    let path = entry.path;
    let label = entry.name;
    for (let i = 0; i < MAX_CHAIN_DEPTH; i++) {
      const list = (await listDir(root, path)).filter((e) => showHidden || !e.hidden);
      if (list.length !== 1 || !list[0].isDir || list[0].heavy) break;
      path = list[0].path;
      label += `/${list[0].name}`;
    }
    return { path, label };
  }

  $effect(() => {
    const list = visible;
    const dirs = list.filter((e) => e.isDir && !e.heavy);
    // Probing costs one directory read per folder shown; a wide listing (node_modules,
    // a package registry) is never a chain, so it is left alone rather than walked.
    if (!dirs.length || dirs.length > MAX_CHAIN_PROBES) return;
    let cancelled = false;
    void (async () => {
      const resolved = await Promise.all(
        dirs.map((e) => resolveChain(e).catch(() => ({ path: e.path, label: e.name }))),
      );
      if (cancelled) return;
      const next: Record<string, { path: string; label: string }> = {};
      dirs.forEach((e, i) => {
        // Only chains worth compacting are recorded; the rest render as plain rows.
        if (resolved[i].path !== e.path) next[e.path] = resolved[i];
      });
      chains = next;
    })();
    return () => {
      cancelled = true;
    };
  });

  /** The directory a row actually opens: the end of its chain, or the folder itself. */
  function targetOf(entry: DirEntry): string {
    return chains[entry.path]?.path ?? entry.path;
  }

  function labelOf(entry: DirEntry): string {
    return chains[entry.path]?.label ?? entry.name;
  }

  function toggle(entry: DirEntry) {
    // The parent hands down a SvelteSet, so mutating it is what notifies every level —
    // a plain Set would need reassignment, which a non-bindable prop does not allow.
    const path = targetOf(entry);
    if (expanded.has(path)) expanded.delete(path);
    else expanded.add(path);
  }
</script>

{#if error}
  <div class="tree-error" style:padding-left="{depth * 12 + 10}px">{error}</div>
{:else if entries === null}
  <div class="tree-loading" style:padding-left="{depth * 12 + 10}px">Loading…</div>
{:else}
  {#each visible as entry (entry.path)}
    {@const target = targetOf(entry)}
    {@const open = entry.isDir && expanded.has(target)}
    <button
      class="row"
      class:dir={entry.isDir}
      class:active={!entry.isDir && entry.path === activePath}
      class:heavy={entry.heavy}
      title={target}
      onclick={() => (entry.isDir ? toggle(entry) : onOpen(entry.path))}
    >
      <!-- One guide line per level of nesting, so a deep branch stays readable. -->
      <span class="ind" style:width="{depth * 12}px"></span>
      {#if entry.isDir}
        <span class="chev" class:open><Icon name="chevronDown" size={12} /></span>
      {:else}
        <span class="chev spacer"></span>
      {/if}
      {#if entry.isDir}
        <span class="ico" class:open><Icon name="folder" size={13} /></span>
      {:else}
        {@const badge = fileBadge(entry.name)}
        <span class="badge" style:color={badge.color}>{badge.label}</span>
      {/if}
      <span class="name">{entry.isDir ? labelOf(entry) : entry.name}</span>
      {#if changed.has(entry.path)}<span class="dot" title="Modified"></span>{/if}
    </button>
    {#if open}
      <Self
        {root}
        dir={target}
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
  /* The file-type badge: the extension's shorthand in the language's colour. */
  .badge {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: 9px;
    font-weight: 800;
    letter-spacing: -0.2px;
    background: color-mix(in srgb, currentColor 15%, transparent);
  }
  .ind {
    flex-shrink: 0;
    align-self: stretch;
    background-image: repeating-linear-gradient(
      to right,
      var(--border-muted) 0 1px,
      transparent 1px 12px
    );
    background-position: 6px 0;
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
