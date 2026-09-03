<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import Icon from "./Icon.svelte";
  import {
    parseDiff,
    toSideBySide,
    diffSignature,
    type DiffFile,
  } from "$lib/code/diff";
  import { highlightLines } from "$lib/code/highlight";

  let {
    diff,
    loading = false,
    error = null,
    title = "",
    split = false,
    onToggleSplit,
    isViewed,
    onViewed,
    onSignatures,
    onEdit,
  }: {
    /** Raw `git diff` output. */
    diff: string;
    loading?: boolean;
    error?: string | null;
    title?: string;
    /** Side-by-side instead of unified. */
    split?: boolean;
    onToggleSplit?: () => void;
    /** Has this exact version of the file already been reviewed? */
    isViewed?: (path: string, signature: string) => boolean;
    onViewed?: (path: string, signature: string, viewed: boolean) => void;
    /** Reports the on-screen diffs' signatures, so stale ticks can be expired. */
    onSignatures?: (signatures: Map<string, string>) => void;
    /** Open the file in the editor (null hides the button, e.g. for a deleted file). */
    onEdit?: (() => void) | null;
  } = $props();

  const files = $derived<DiffFile[]>(diff ? parseDiff(diff) : []);
  const totals = $derived(
    files.reduce((acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }), {
      added: 0,
      removed: 0,
    }),
  );

  /** A one-file diff needs no per-file summary bar above its own header. */
  const solo = $derived(files.length === 1);

  /** Signature per file path, so "viewed" expires when the content changes again. */
  const signatures = $derived(new Map(files.map((f) => [f.path, diffSignature(f)])));

  const viewedCount = $derived(
    files.filter((f) => isViewed?.(f.path, signatures.get(f.path) ?? "")).length,
  );

  /** Files the user collapsed by hand, plus the ones auto-collapsed on tick. */
  const collapsed = new SvelteSet<string>();

  function toggleCollapsed(path: string) {
    if (collapsed.has(path)) collapsed.delete(path);
    else collapsed.add(path);
  }

  /**
   * Tick / untick a file. Marking it viewed folds it away, the way GitHub does — the
   * point of the tick is to shrink what is left to read.
   */
  function toggleViewed(f: DiffFile) {
    const sig = signatures.get(f.path) ?? "";
    const next = !isViewed?.(f.path, sig);
    onViewed?.(f.path, sig, next);
    if (next) collapsed.add(f.path);
    else collapsed.delete(f.path);
  }

  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      copied = path;
      setTimeout(() => (copied = copied === path ? null : copied), 1200);
    } catch {
      /* clipboard can be refused; the path is on screen either way */
    }
  }
  let copied = $state<string | null>(null);

  /**
   * GitHub's five-block diffstat: how much of the change is additions vs deletions,
   * at a glance and independent of the raw counts.
   */
  function statBlocks(f: DiffFile): ("add" | "del" | "none")[] {
    const total = f.added + f.removed;
    if (!total) return Array(5).fill("none");
    const green = Math.max(f.added ? 1 : 0, Math.round((f.added / total) * 5));
    const red = Math.max(f.removed ? 1 : 0, Math.min(5 - green, Math.round((f.removed / total) * 5)));
    return Array.from({ length: 5 }, (_, i) =>
      i < green ? "add" : i < green + red ? "del" : "none",
    );
  }

  /**
   * Syntax-highlighted markup per code row, keyed `<file path>:<row index>`.
   *
   * Filled asynchronously (the grammar for the file's language is imported on demand), so
   * the diff paints immediately as plain text and gains its colours a tick later rather
   * than blocking on a parser the user may not need.
   */
  let highlighted = $state<Record<string, string>>({});

  $effect(() => {
    onSignatures?.(signatures);
  });

  $effect(() => {
    const list = files;
    let cancelled = false;
    void (async () => {
      const next: Record<string, string> = {};
      for (const f of list) {
        // Hunk and meta rows are not code; only the +/-/context lines are parsed, and
        // their indices are kept so the result can be matched back to the row.
        const idx: number[] = [];
        const lines: string[] = [];
        for (const r of f.rows) {
          if (r.kind === "add" || r.kind === "del" || r.kind === "ctx") {
            idx.push(r.idx);
            lines.push(r.text);
          }
        }
        if (!lines.length) continue;
        const html = await highlightLines(f.path, lines);
        if (cancelled) return;
        if (!html) continue;
        html.forEach((h: string, n: number) => (next[`${f.path}:${idx[n]}`] = h));
      }
      if (!cancelled) highlighted = next;
    })();
    return () => {
      cancelled = true;
    };
  });

  /**
   * An empty line still needs to occupy a row, and `white-space: pre-wrap` collapses a
   * zero-length cell to nothing.
   */
  function display(text: string): string {
    return text.length ? text : " ";
  }

  /** `dir/sub/file.ts` → `["dir/sub/", "file.ts"]`, so the name can be emphasised. */
  function splitPath(path: string): [string, string] {
    const i = path.lastIndexOf("/");
    return i < 0 ? ["", path] : [path.slice(0, i + 1), path.slice(i + 1)];
  }
</script>

<div class="diff">
  <!-- Review-wide bar: what is being reviewed, how much of it is left, how to read it. -->
  <div class="head">
    <span class="title"><span class="name">{title || "Changes"}</span></span>
    {#if files.length > 1}
      <span class="progress" class:done={viewedCount === files.length}>
        {viewedCount}/{files.length} viewed
      </span>
    {/if}
    {#if files.length}
      <span class="stat add">+{totals.added}</span>
      <span class="stat del">−{totals.removed}</span>
    {/if}
    <span class="sp"></span>
    {#if onToggleSplit}
      <button
        class="ghost-btn"
        title={split ? "Switch to unified diff" : "Switch to side-by-side diff"}
        onclick={onToggleSplit}
      >
        <Icon name={split ? "rows" : "columns"} size={13} />
        {split ? "Split" : "Unified"}
      </button>
    {/if}
    {#if onEdit}
      <button class="ghost-btn" onclick={onEdit}>
        <Icon name="edit" size={13} /> Edit file
      </button>
    {/if}
  </div>

  {#if error}
    <div class="msg err"><Icon name="alert" size={15} />{error}</div>
  {:else if loading}
    <div class="msg">Loading diff…</div>
  {:else if !files.length}
    <div class="msg">No changes to show.</div>
  {:else}
    <div class="scroll">
      {#each files as f (f.path)}
        {@const sig = signatures.get(f.path) ?? ""}
        {@const viewed = isViewed?.(f.path, sig) ?? false}
        {@const shut = collapsed.has(f.path)}
        {@const [dir, name] = splitPath(f.path)}
        <section class="file" class:viewed>
          <div class="file-head" class:solo>
            <button
              class="chev"
              class:open={!shut}
              title={shut ? "Expand" : "Collapse"}
              onclick={() => toggleCollapsed(f.path)}
            >
              <Icon name="chevronDown" size={13} />
            </button>
            <span class="fh-path" title={f.path}>
              {#if f.oldPath && f.oldPath !== f.path}<span class="dir">{f.oldPath} → </span>{/if}
              <span class="dir">{dir}</span><span class="name">{name}</span>
            </span>
            <button
              class="icon-btn"
              title={copied === f.path ? "Copied" : "Copy path"}
              onclick={() => copyPath(f.path)}
            >
              <Icon name={copied === f.path ? "check" : "copy"} size={12} />
            </button>
            {#each f.notes as note (note)}<span class="chip">{note}</span>{/each}
            <span class="sp"></span>
            <span class="counts">
              {#if f.added}<span class="stat add">+{f.added}</span>{/if}
              {#if f.removed}<span class="stat del">−{f.removed}</span>{/if}
            </span>
            <span class="blocks" aria-hidden="true">
              {#each statBlocks(f) as b, i (i)}<span class="blk {b}"></span>{/each}
            </span>
            <button
              class="viewed-btn"
              class:on={viewed}
              title="Mark this file as reviewed"
              onclick={() => toggleViewed(f)}
            >
              <Icon name={viewed ? "checkSquare" : "square"} size={13} /> Viewed
            </button>
          </div>

          {#if !shut}
            {#if f.binary}
              <div class="msg">Binary file — no textual diff.</div>
            {:else if split}
              <!--
                Side by side. The old file's lines and the new file's lines are zipped by
                `toSideBySide`, so an edited line shows its before and after opposite each
                other instead of ten rows apart.
              -->
              <table class="split">
                <tbody>
                  {#each toSideBySide(f.rows) as sr, i (i)}
                    {#if sr.full}
                      <tr class={sr.full.kind}>
                        <td class="ln"></td>
                        <td class="txt" colspan="3">{display(sr.full.text)}</td>
                      </tr>
                    {:else}
                      <tr>
                        <td class="ln {sr.left ? sr.left.kind : 'pad'}">{sr.left?.oldNo ?? ""}</td>
                        <td class="txt half {sr.left ? sr.left.kind : 'pad'}">
                          {#if sr.left}{#if highlighted[`${f.path}:${sr.left.idx}`]}<!-- eslint-disable-next-line svelte/no-at-html-tags -->{@html highlighted[
                                `${f.path}:${sr.left.idx}`
                              ]}{:else}{display(sr.left.text)}{/if}{/if}
                        </td>
                        <td class="ln {sr.right ? sr.right.kind : 'pad'}">{sr.right?.newNo ?? ""}</td>
                        <td class="txt half {sr.right ? sr.right.kind : 'pad'}">
                          {#if sr.right}{#if highlighted[`${f.path}:${sr.right.idx}`]}<!-- eslint-disable-next-line svelte/no-at-html-tags -->{@html highlighted[
                                `${f.path}:${sr.right.idx}`
                              ]}{:else}{display(sr.right.text)}{/if}{/if}
                        </td>
                      </tr>
                    {/if}
                  {/each}
                </tbody>
              </table>
            {:else}
              <table>
                <tbody>
                  {#each f.rows as row (row.idx)}
                    <tr class={row.kind}>
                      <!--
                        A pure-addition file has no old-side numbering at all; rendering
                        the column anyway left a dead strip down the left of every new file.
                      -->
                      {#if f.hasOld}<td class="ln">{row.oldNo ?? ""}</td>{/if}
                      {#if f.hasNew}<td class="ln">{row.newNo ?? ""}</td>{/if}
                      <td class="txt"
                        >{#if highlighted[`${f.path}:${row.idx}`]}<!-- eslint-disable-next-line svelte/no-at-html-tags -->{@html highlighted[
                            `${f.path}:${row.idx}`
                          ]}{:else}{display(row.text)}{/if}</td
                      >
                    </tr>
                  {/each}
                </tbody>
              </table>
            {/if}
          {/if}
        </section>
      {/each}
    </div>
  {/if}
</div>

<style>
  .diff {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--term-bg);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 32px;
    padding: 0 10px;
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    flex-shrink: 0;
  }
  .title {
    font-family: var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dir {
    color: var(--text-faint);
  }
  .name {
    color: var(--text);
    font-weight: 600;
  }
  .progress {
    flex-shrink: 0;
    font-size: 10.5px;
    font-weight: 700;
    color: var(--text-muted);
    background: var(--surface-4);
    border-radius: 9px;
    padding: 2px 7px;
  }
  .progress.done {
    color: var(--ok);
    background: rgba(89, 168, 105, 0.16);
  }
  .head .sp,
  .file-head .sp {
    flex: 1;
  }
  .stat {
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-weight: 700;
    flex-shrink: 0;
  }
  .stat.add {
    color: var(--ok);
  }
  .stat.del {
    color: var(--danger);
  }
  .ghost-btn {
    display: flex;
    align-items: center;
    gap: 5px;
    border: 1px solid var(--border-strong);
    background: var(--surface-3);
    color: var(--text-secondary);
    font-size: 11.5px;
    font-weight: 600;
    padding: 3px 8px;
    border-radius: 6px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .ghost-btn:hover {
    background: var(--surface-4);
    color: var(--accent-bright);
    border-color: var(--accent);
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .msg {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 16px;
    color: var(--text-faint);
    font-size: 12.5px;
  }
  .msg.err {
    color: var(--danger);
  }

  /* ---- per-file section ---- */
  .file {
    border-bottom: 1px solid var(--border);
  }
  .file-head {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 10px 6px 4px;
    background: var(--surface-1);
    border-bottom: 1px solid var(--border);
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-secondary);
    position: sticky;
    top: 0;
    z-index: 1;
  }
  /* A reviewed file recedes — the ones still to read should be what catches the eye. */
  .file.viewed > .file-head {
    opacity: 0.55;
  }
  .file.viewed > .file-head:hover {
    opacity: 1;
  }
  .chev {
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    color: var(--text-faint);
    padding: 2px;
    border-radius: 4px;
    cursor: pointer;
    transform: rotate(-90deg);
    transition: transform var(--t-fast);
  }
  .chev.open {
    transform: rotate(0deg);
  }
  .chev:hover {
    color: var(--text);
  }
  .fh-path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .icon-btn {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    border: none;
    background: transparent;
    color: var(--text-ghost);
    padding: 3px;
    border-radius: 4px;
    cursor: pointer;
  }
  .icon-btn:hover {
    background: var(--surface-3);
    color: var(--text);
  }
  .chip {
    flex-shrink: 0;
    font-family: var(--font-sans);
    font-size: 9.5px;
    font-weight: 800;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    color: var(--accent-bright);
    background: var(--accent-soft);
    border-radius: 4px;
    padding: 2px 5px;
  }
  .counts {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }
  /* Proportion of the change that is additions vs deletions, at a glance. */
  .blocks {
    display: flex;
    gap: 2px;
    flex-shrink: 0;
  }
  .blk {
    width: 8px;
    height: 8px;
    border-radius: 2px;
    background: var(--surface-4);
  }
  .blk.add {
    background: var(--ok);
  }
  .blk.del {
    background: var(--danger);
  }
  .viewed-btn {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-shrink: 0;
    border: 1px solid var(--border-strong);
    background: var(--surface-3);
    color: var(--text-muted);
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 700;
    padding: 3px 8px;
    border-radius: 6px;
    cursor: pointer;
  }
  .viewed-btn:hover {
    background: var(--surface-4);
    color: var(--text);
  }
  .viewed-btn.on {
    color: var(--ok);
    border-color: rgba(89, 168, 105, 0.42);
    background: rgba(89, 168, 105, 0.14);
  }

  /* ---- diff body ---- */
  table {
    border-collapse: collapse;
    width: 100%;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.55;
  }
  td {
    vertical-align: top;
  }
  /*
    Line numbers sit in as narrow a column as their digits allow (`width: 1%` on a
    full-width table), rather than a fixed strip that is mostly empty.
  */
  td.ln {
    width: 1%;
    min-width: 26px;
    padding: 0 8px;
    text-align: right;
    color: var(--text-ghost);
    user-select: none;
    background: var(--bg);
    white-space: nowrap;
  }
  td.txt {
    /*
      The +/− marker is a 2px colour bar rather than a glyph column: it reads at a
      glance, survives copy/paste of the code, and costs no horizontal room.
    */
    padding: 0 10px 0 9px;
    border-left: 2px solid transparent;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text);
  }
  /* Side-by-side: each half takes an equal share of whatever is left after the gutters. */
  td.txt.half {
    width: 50%;
  }
  table.split td.txt.half + td.ln {
    border-left: 1px solid var(--border);
  }
  /*
    Added/removed lines are marked by the ROW — a faint tint, a solid edge bar and a
    coloured line number — and never by recolouring the code itself. Green text on a
    green ground is the least readable thing a diff can do, and in an all-additions file
    (a new file) it turns the entire pane into one flat colour.
  */
  tr.add td.txt,
  td.txt.add {
    background: rgba(89, 168, 105, 0.13);
    border-left-color: var(--ok);
  }
  tr.add td.ln,
  td.ln.add {
    color: rgba(137, 199, 150, 0.85);
    background: rgba(89, 168, 105, 0.1);
  }
  tr.del td.txt,
  td.txt.del {
    background: rgba(247, 84, 100, 0.13);
    border-left-color: var(--danger);
  }
  tr.del td.ln,
  td.ln.del {
    color: rgba(229, 138, 148, 0.85);
    background: rgba(247, 84, 100, 0.1);
  }
  /* The blank opposite an unpaired add/del in split view. */
  td.txt.pad,
  td.ln.pad {
    background: repeating-linear-gradient(
      45deg,
      transparent,
      transparent 6px,
      rgba(255, 255, 255, 0.018) 6px,
      rgba(255, 255, 255, 0.018) 12px
    );
  }
  tr.hunk td {
    background: var(--surface-2);
    color: var(--text-faint);
    font-size: 11px;
    padding-top: 3px;
    padding-bottom: 3px;
    border-top: 1px solid var(--border-muted);
    border-bottom: 1px solid var(--border-muted);
  }
  tr.hunk td.ln {
    background: var(--surface-2);
  }
  tr.meta td {
    color: var(--text-ghost);
    font-size: 11px;
    padding: 0 10px;
  }

  /*
    Token colours, matched to `codesuHighlight` in $lib/code/editor so a file looks the
    same whether you are reading it in the editor or in a diff. See $lib/code/highlight
    for why the diff carries its own class names instead of CodeMirror's.
  */
  td.txt :global(.tok-comment) {
    color: #7a7e85;
  }
  td.txt :global(.tok-keyword) {
    color: #cf8e6d;
  }
  td.txt :global(.tok-string) {
    color: #6aab73;
  }
  td.txt :global(.tok-number) {
    color: #2aacb8;
  }
  td.txt :global(.tok-fn) {
    color: #56a8f5;
  }
  td.txt :global(.tok-prop) {
    color: #c77dbb;
  }
  td.txt :global(.tok-type) {
    color: #bcbec4;
  }
  td.txt :global(.tok-tag) {
    color: #e8bf6a;
  }
  td.txt :global(.tok-punct) {
    color: #bcbec4;
  }
  td.txt :global(.tok-heading) {
    color: #56a8f5;
    font-weight: 700;
  }
  td.txt :global(.tok-link) {
    color: #548af7;
    text-decoration: underline;
  }
  td.txt :global(.tok-invalid) {
    color: #f75464;
  }
</style>
