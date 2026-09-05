<script lang="ts">
  import Icon from "./Icon.svelte";

  let {
    view,
    search,
    onClose,
  }: {
    /** The live CodeMirror EditorView this bar drives. */
    view: any;
    /** The `@codemirror/search` module (loaded on demand by the editor). */
    search: any;
    onClose: () => void;
  } = $props();

  let query = $state("");
  let replacement = $state("");
  /** The replace row, revealed by the chevron or by ⌘⌥F (see `focusInput`). */
  let showReplace = $state(false);
  let caseSensitive = $state(false);
  let wholeWord = $state(false);
  let regexp = $state(false);

  /** Total matches in the document, and which one the cursor is on (1-based, 0 = none). */
  let total = $state(0);
  let index = $state(0);
  /** More matches than we are willing to count — the number becomes "999+". */
  let over = $state(false);
  /** A regexp the user is still halfway through typing. */
  let bad = $state(false);

  let input = $state<HTMLInputElement | null>(null);

  /** Counting every match in a huge file is not worth a frame; past this it is "lots". */
  const COUNT_LIMIT = 999;

  function makeQuery() {
    return new search.SearchQuery({
      search: query,
      caseSensitive,
      regexp,
      wholeWord,
      replace: replacement,
    });
  }

  /**
   * Push the query into the editor: it drives the match highlighting, the find/replace
   * commands, and the counter below.
   *
   * The built-in search panel is opened alongside (empty and hidden — see
   * `createPanel` where the editor is configured), because CodeMirror only highlights
   * matches while it considers a panel to be open.
   */
  function apply() {
    if (!view || !search) return;
    const q = makeQuery();
    if (!search.searchPanelOpen(view.state)) search.openSearchPanel(view);
    view.dispatch({ effects: search.setSearchQuery.of(q) });
    recount(q);
  }

  function recount(q = makeQuery()) {
    if (!view) return;
    if (!q.valid) {
      // An invalid query is either empty (nothing to say) or a broken regexp (worth
      // saying, since the input looks like it simply found nothing).
      bad = regexp && query.length > 0;
      total = 0;
      index = 0;
      over = false;
      return;
    }
    bad = false;
    // `getCursor` is the query's public iterator over its matches; counting stops at the
    // limit so a one-character query in a huge file cannot stall a keystroke.
    const cursor = q.getCursor(view.state);
    const sel = view.state.selection.main;
    let n = 0;
    let at = 0;
    over = false;
    for (let r = cursor.next(); !r.done; r = cursor.next()) {
      n++;
      if (r.value.from === sel.from && r.value.to === sel.to) at = n;
      if (n >= COUNT_LIMIT) {
        over = !cursor.next().done;
        break;
      }
    }
    total = n;
    index = at;
  }

  function next() {
    if (!view || !query) return;
    search.findNext(view);
    recount();
    input?.focus();
  }

  function prev() {
    if (!view || !query) return;
    search.findPrevious(view);
    recount();
    input?.focus();
  }

  function replaceOne() {
    if (!view || !query) return;
    search.replaceNext(view);
    recount();
    input?.focus();
  }

  function replaceEvery() {
    if (!view || !query) return;
    search.replaceAll(view);
    recount();
    input?.focus();
  }

  function close() {
    if (view && search.searchPanelOpen(view.state)) search.closeSearchPanel(view);
    onClose();
    view?.focus();
  }

  /**
   * Open (or re-open) the bar on `seed` — the editor's selection when ⌘F was pressed.
   *
   * Selecting the text as well as focusing is what makes a second ⌘F replace the query
   * by typing, the way every editor's find behaves.
   */
  export function focusInput(seed?: string, withReplace = false) {
    if (seed) query = seed;
    if (withReplace) showReplace = true;
    queueMicrotask(() => {
      input?.focus();
      input?.select();
    });
  }

  /** Re-push the query — the editor swapped in another file's state (see CodeEditor). */
  export function reapply() {
    apply();
  }

  export function findNext() {
    next();
  }
  export function findPrev() {
    prev();
  }

  // The query, its flags and the file on screen all feed the same push into the editor.
  $effect(() => {
    void [query, replacement, caseSensitive, wholeWord, regexp, view];
    apply();
  });

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) prev();
      else next();
    }
  }
</script>

<div class="find" class:with-replace={showReplace}>
  <button
    class="disclose"
    class:open={showReplace}
    title={showReplace ? "Hide replace" : "Show replace"}
    onclick={() => (showReplace = !showReplace)}
  >
    <Icon name="chevronDown" size={13} />
  </button>

  <div class="rows">
    <div class="row">
      <!-- One rounded field holding the input and its modifiers, IntelliJ-style. -->
      <div class="field" class:bad>
        <span class="lead"><Icon name="search" size={13} /></span>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          bind:this={input}
          bind:value={query}
          placeholder="Search"
          spellcheck="false"
          autocomplete="off"
          autofocus
          onkeydown={onKeydown}
        />
        <button
          class="flag"
          class:on={caseSensitive}
          title="Match case"
          onclick={() => (caseSensitive = !caseSensitive)}>Cc</button
        >
        <button
          class="flag"
          class:on={wholeWord}
          title="Words"
          onclick={() => (wholeWord = !wholeWord)}>W</button
        >
        <button class="flag" class:on={regexp} title="Regex" onclick={() => (regexp = !regexp)}
          >.*</button
        >
      </div>

      <span class="count" class:none={query.length > 0 && total === 0}>
        {#if bad}
          Bad pattern
        {:else if !query}
          &nbsp;
        {:else if total === 0}
          No results
        {:else if over}
          {COUNT_LIMIT}+ results
        {:else if index > 0}
          {index} of {total}
        {:else}
          {total} result{total === 1 ? "" : "s"}
        {/if}
      </span>

      <button class="nav" title="Previous match (⇧⏎)" onclick={prev} disabled={!total}
        ><Icon name="arrowUp" size={14} /></button
      >
      <button class="nav" title="Next match (⏎)" onclick={next} disabled={!total}
        ><Icon name="arrowDown" size={14} /></button
      >
      <span class="sp"></span>
      <button class="nav close" title="Close (Esc)" onclick={close}
        ><Icon name="close" size={14} /></button
      >
    </div>

    {#if showReplace}
      <div class="row">
        <div class="field">
          <span class="lead"><Icon name="edit" size={12} /></span>
          <input
            bind:value={replacement}
            placeholder="Replace"
            spellcheck="false"
            autocomplete="off"
            onkeydown={(e) => {
              if (e.key === "Escape") close();
              else if (e.key === "Enter") replaceOne();
            }}
          />
        </div>
        <button class="act" onclick={replaceOne} disabled={!total}>Replace</button>
        <button class="act" onclick={replaceEvery} disabled={!total}>Replace all</button>
        <span class="sp"></span>
      </div>
    {/if}
  </div>
</div>

<style>
  .find {
    display: flex;
    align-items: flex-start;
    gap: 2px;
    padding: 6px 8px;
    background: var(--surface-1);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .rows {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .disclose {
    display: grid;
    place-items: center;
    height: 30px;
    width: 20px;
    border: none;
    background: transparent;
    color: var(--text-faint);
    cursor: pointer;
    transform: rotate(-90deg);
    transition: transform var(--t-fast);
  }
  .disclose.open {
    transform: rotate(0deg);
  }
  .disclose:hover {
    color: var(--text);
  }
  /*
    The input and its modifiers share ONE bordered field, so the flags read as part of
    the query rather than as three more buttons competing with next/previous.
  */
  .field {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 0 1 460px;
    min-width: 180px;
    height: 30px;
    padding: 0 6px 0 8px;
    background: var(--surface-2);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    color: var(--text-faint);
  }
  .field:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .field.bad {
    border-color: var(--danger);
    box-shadow: none;
  }
  .lead {
    display: grid;
    place-items: center;
    flex-shrink: 0;
  }
  .field input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    outline: none;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 12.5px;
  }
  .field input::placeholder {
    color: var(--text-ghost);
    font-family: var(--font-sans);
  }
  .flag {
    display: grid;
    place-items: center;
    min-width: 22px;
    height: 22px;
    padding: 0 4px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-weight: 700;
    cursor: pointer;
    flex-shrink: 0;
  }
  .flag:hover {
    background: var(--surface-3);
    color: var(--text);
  }
  .flag.on {
    color: var(--accent-bright);
    background: var(--accent-softer);
    border-color: var(--accent-line);
  }
  .count {
    font-size: 11.5px;
    color: var(--text-faint);
    white-space: nowrap;
    flex-shrink: 0;
    min-width: 62px;
  }
  .count.none {
    color: var(--danger);
  }
  .nav {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    flex-shrink: 0;
  }
  .nav:hover:not(:disabled) {
    background: var(--surface-3);
    color: var(--text);
  }
  .nav:disabled {
    color: var(--text-ghost);
    cursor: default;
  }
  .nav.close:hover {
    color: var(--danger);
  }
  .sp {
    flex: 1;
  }
  .act {
    height: 26px;
    padding: 0 10px;
    border: 1px solid var(--border-strong);
    border-radius: 5px;
    background: var(--surface-3);
    color: var(--text-secondary);
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
    flex-shrink: 0;
  }
  .act:hover:not(:disabled) {
    background: var(--surface-4);
    color: var(--text);
  }
  .act:disabled {
    color: var(--text-ghost);
    cursor: default;
  }
</style>
