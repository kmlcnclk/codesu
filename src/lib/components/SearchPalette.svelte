<script lang="ts">
  /**
   * Search the workspace — files by name, symbols by declaration, or plain text.
   *
   * One palette with three modes rather than three separate UIs: the question changes
   * ("where is that file" / "where is that function" / "where does this string appear")
   * but the gesture is identical, and switching modes mid-search keeps what you typed.
   * Ranking, indexing and the actual matching live in Rust (`src-tauri/src/search.rs`).
   */
  import { onMount, untrack } from "svelte";
  import Icon from "./Icon.svelte";
  import { searchWorkspace, type SearchHit } from "$lib/code/api";

  let {
    root,
    requestedMode = "file",
    onOpen,
    onClose,
  }: {
    root: string;
    /**
     * The mode to show. Reactive, not just initial: pressing ⌘⇧F while the palette is
     * already open on Files has to switch it, not be ignored.
     */
    requestedMode?: Mode;
    /** Open a hit: `line` is 0 for a file, otherwise the line to jump to. */
    onOpen: (path: string, line: number) => void;
    onClose: () => void;
  } = $props();

  type Mode = "file" | "symbol" | "text";

  /** One hue per mode — the magnifier and the active chip take it. */
  const MODE_HUE: Record<Mode, string> = {
    file: "--hue-blue",
    symbol: "--hue-violet",
    text: "--hue-teal",
  };

  const MODES: { id: Mode; label: string; icon: string; hint: string; key: string }[] = [
    { id: "file", label: "Files", icon: "file", hint: "Search files by name or path", key: "⌘P" },
    { id: "symbol", label: "Symbols", icon: "code2", hint: "Search functions, classes and types", key: "⌘⇧O" },
    { id: "text", label: "Text", icon: "search", hint: "Search inside files", key: "⌘⇧F" },
  ];

  // svelte-ignore state_referenced_locally
  // Deliberate: the prop seeds the mode, and the effect below keeps it in step after.
  let mode = $state<Mode>(requestedMode);
  $effect(() => {
    const next = requestedMode;
    untrack(() => setMode(next));
  });
  let query = $state("");
  let hits = $state<SearchHit[]>([]);
  let selected = $state(0);
  let loading = $state(false);
  let error = $state<string | null>(null);
  /** Set once a query has actually run, so "no matches" isn't shown before the first. */
  let searched = $state(false);
  let input = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLDivElement | null>(null);

  /**
   * Only the newest query may write to `hits`.
   *
   * Text search over a monorepo can take a moment, so a slow query started three
   * keystrokes ago must not land on top of the fast one the user is now looking at.
   */
  let latest = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function run() {
    const q = query.trim();
    const token = ++latest;
    if (!q) {
      hits = [];
      searched = false;
      loading = false;
      return;
    }
    loading = true;
    void searchWorkspace(root, q, mode)
      .then((found) => {
        if (token !== latest) return;
        hits = found;
        selected = 0;
        searched = true;
        error = null;
      })
      .catch((e) => {
        if (token !== latest) return;
        error = String(e);
        hits = [];
      })
      .finally(() => {
        if (token === latest) loading = false;
      });
  }

  /** Debounced: typing shouldn't launch a search per character. */
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, 130);
  }

  function setMode(next: Mode) {
    if (next === mode) return;
    mode = next;
    input?.focus();
    if (query.trim()) run(); // re-ask the same question of the new mode, immediately
    else hits = [];
  }

  function choose(hit: SearchHit) {
    onOpen(hit.path, hit.line);
    onClose();
  }

  function move(delta: number) {
    if (!hits.length) return;
    selected = (selected + delta + hits.length) % hits.length;
    // Keep the cursor inside the scroll box — arrowing past the fold should follow.
    listEl?.querySelectorAll(".hit")[selected]?.scrollIntoView({ block: "nearest" });
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (hits[selected]) choose(hits[selected]);
    } else if (e.key === "Tab") {
      // Tab cycles modes: the same query, asked a different way.
      e.preventDefault();
      const i = MODES.findIndex((m) => m.id === mode);
      setMode(MODES[(i + (e.shiftKey ? -1 : 1) + MODES.length) % MODES.length].id);
    }
  }

  /**
   * Split `text` into matched/unmatched runs for the same subsequence Rust matched on, so
   * the row shows WHY it is a hit. Only for names — a text hit is already the line.
   */
  function marks(text: string, q: string): { s: string; on: boolean }[] {
    const needle = q.trim().toLowerCase();
    if (!needle) return [{ s: text, on: false }];
    const out: { s: string; on: boolean }[] = [];
    let i = 0;
    for (const ch of text) {
      const on = i < needle.length && ch.toLowerCase() === needle[i];
      if (on) i++;
      const last = out[out.length - 1];
      if (last && last.on === on) last.s += ch;
      else out.push({ s: ch, on });
    }
    // Not a subsequence of this field (it matched the path instead) — don't fake it.
    return i === needle.length ? out : [{ s: text, on: false }];
  }

  onMount(() => {
    input?.focus();
    return () => {
      if (timer) clearTimeout(timer);
    };
  });

  const placeholder = $derived(MODES.find((m) => m.id === mode)!.hint + "…");
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="scrim" onclick={onClose} role="presentation"></div>

<div class="palette" role="dialog" aria-label="Search workspace">
  <div class="modes">
    {#each MODES as m (m.id)}
      <button
        class="mode"
        class:on={mode === m.id}
        style:--hue="var({MODE_HUE[m.id]})"
        onclick={() => setMode(m.id)}
        title="{m.hint} ({m.key})"
      >
        <Icon name={m.icon} size={13} />{m.label}
        <span class="kbd-hint">{m.key}</span>
      </button>
    {/each}
    <span class="sp"></span>
    <span class="tabhint">Tab to switch · ↑↓ to move · ⏎ to open</span>
  </div>

  <div class="field-wrap">
    <div class="field" class:busy={loading}>
      <span class="lead" style:color="var({MODE_HUE[mode]})"><Icon name="search" size={15} /></span>
      <input
        bind:this={input}
        bind:value={query}
        oninput={schedule}
        onkeydown={onKeydown}
        {placeholder}
        spellcheck="false"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
      />
      {#if loading}<span class="spin"></span>{/if}
      {#if query}
        <button
          class="clear"
          title="Clear"
          onclick={() => {
            query = "";
            hits = [];
            searched = false;
            input?.focus();
          }}><Icon name="close" size={12} /></button
        >
      {/if}
      <kbd>esc</kbd>
    </div>
  </div>

  {#if error}
    <div class="msg err"><Icon name="alert" size={13} />{error}</div>
  {/if}

  <div class="list" bind:this={listEl}>
    {#each hits as hit, i (hit.kind + hit.path + hit.line + hit.name)}
      <button
        class="hit"
        class:sel={i === selected}
        onclick={() => choose(hit)}
        onmousemove={() => (selected = i)}
        title={hit.line ? `${hit.rel}:${hit.line}` : hit.rel}
      >
        {#if hit.kind === "symbol"}
          <span class="kw">{hit.detail}</span>
        {:else}
          <Icon name={hit.kind === "file" ? "file" : "search"} size={13} class="ic" />
        {/if}
        <span class="name" class:mono={hit.kind === "text"}>
          {#if hit.kind === "text"}
            {hit.name}
          {:else}
            {#each marks(hit.name, query) as part}
              {#if part.on}<b>{part.s}</b>{:else}{part.s}{/if}
            {/each}
          {/if}
        </span>
        <span class="where">
          {hit.kind === "file" ? hit.detail : hit.rel}{hit.line ? `:${hit.line}` : ""}
        </span>
      </button>
    {/each}

    {#if !query.trim()}
      <div class="msg">{MODES.find((m) => m.id === mode)!.hint} — start typing.</div>
    {:else if searched && !hits.length && !loading}
      <div class="msg">No matches for “{query.trim()}”.</div>
    {/if}
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    z-index: 60;
  }
  .palette {
    position: fixed;
    top: 11vh;
    left: 50%;
    transform: translateX(-50%);
    width: min(760px, 92vw);
    max-height: 68vh;
    z-index: 61;
    display: flex;
    flex-direction: column;
    background: var(--surface-float);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-xl);
    overflow: hidden;
  }
  .modes {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
  }
  .mode {
    display: flex;
    align-items: center;
    gap: 5px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 11.5px;
    font-weight: 600;
    padding: 4px 9px;
    border-radius: 6px;
    cursor: pointer;
  }
  .mode:hover {
    background: var(--surface-3);
    color: var(--text-secondary);
  }
  .mode.on {
    background: color-mix(in srgb, var(--hue) 18%, transparent);
    color: var(--hue);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--hue) 35%, transparent);
  }
  /* The shortcut only shows on the mode you are not in — it's an invitation, not a label. */
  .kbd-hint {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-ghost);
    letter-spacing: 0.3px;
  }
  .mode.on .kbd-hint {
    display: none;
  }
  .modes .sp {
    flex: 1;
  }
  .tabhint {
    font-size: 10.5px;
    color: var(--text-ghost);
    white-space: nowrap;
  }
  /*
    The input is a control, not a bare field: an inset well with its own border, which
    takes the accent on focus. Without this the app's global :focus-visible ring lands on
    the raw <input> and draws a blue rectangle across the palette.
  */
  .field-wrap {
    padding: 10px 10px 11px;
    border-bottom: 1px solid var(--border);
  }
  .field {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 0 10px;
    height: 38px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    transition: border-color var(--t-fast), box-shadow var(--t-fast);
  }
  .field:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-softer);
  }
  .field.busy {
    border-color: var(--border-strong);
  }
  .lead {
    display: flex;
    flex-shrink: 0;
  }
  .field input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    color: var(--text);
    font-family: inherit;
    font-size: 14.5px;
    padding: 0;
    outline: none;
  }
  /* The global ring belongs to buttons and rows, not to a field with its own focus state. */
  .field input:focus-visible {
    box-shadow: none;
  }
  .field input::placeholder {
    color: var(--text-ghost);
  }
  kbd {
    flex-shrink: 0;
    font-family: var(--font-sans);
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    color: var(--text-ghost);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-bottom-width: 2px;
    border-radius: 5px;
    padding: 2px 5px;
  }
  .clear {
    border: none;
    background: transparent;
    color: var(--text-faint);
    cursor: pointer;
    display: flex;
    padding: 2px;
  }
  .clear:hover {
    color: var(--text);
  }
  .spin {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    border: 2px solid var(--border-strong);
    border-top-color: var(--accent);
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .list {
    overflow: auto;
    padding: 5px;
    min-height: 0;
  }
  .hit {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    border: none;
    background: transparent;
    padding: 6px 8px;
    border-radius: 6px;
    cursor: pointer;
    color: var(--text-secondary);
  }
  .hit.sel {
    background: var(--accent-soft);
  }
  .hit :global(.ic) {
    color: var(--text-faint);
    flex-shrink: 0;
  }
  .kw {
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 700;
    color: var(--accent-bright);
    background: var(--accent-softer);
    border-radius: 4px;
    padding: 1px 5px;
    min-width: 42px;
    text-align: center;
  }
  .name {
    font-size: 13px;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex-shrink: 0;
    max-width: 55%;
  }
  .name.mono {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-secondary);
    max-width: none;
    flex: 1;
  }
  .name b {
    color: var(--accent-bright);
    font-weight: 700;
  }
  .where {
    flex: 1;
    min-width: 0;
    font-size: 11px;
    color: var(--text-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: right;
    direction: rtl; /* clip long paths at the START, keeping the filename visible */
  }
  .msg {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 22px 12px;
    font-size: 12.5px;
    color: var(--text-faint);
    text-align: center;
  }
  .msg.err {
    color: var(--danger);
    padding: 10px 12px;
    justify-content: flex-start;
  }
</style>
