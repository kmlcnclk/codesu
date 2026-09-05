<script lang="ts">
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import Icon from "./Icon.svelte";
  import {
    parseDiff,
    toSideBySide,
    diffSignature,
    type DiffFile,
    type DiffRow,
  } from "$lib/code/diff";
  import { highlightLines } from "$lib/code/highlight";
  import type { ReviewComment } from "$lib/store/app.svelte";

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
    onOpenPath,
    loadFile,
    comments = [],
    onAddComment,
    onUpdateComment,
    onDeleteComment,
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
    /** Open one file of a multi-file diff in the editor, by repo-relative path. */
    onOpenPath?: (path: string) => void;
    /**
     * Read the CURRENT text of a repo-relative path, split into lines.
     *
     * Only used by the hunk "expand context" buttons: the diff itself carries no
     * unchanged lines outside its hunks, so the surrounding code has to come from disk.
     * Returning null (unreadable, deleted, binary) simply leaves the buttons inert.
     */
    loadFile?: (path: string) => Promise<string[] | null>;
    /** Notes already written against lines of this diff. */
    comments?: ReviewComment[];
    /** Write a new note against one line (omitted = the diff is read-only). */
    onAddComment?: (input: {
      path: string;
      line: number | null;
      side: "old" | "new";
      code: string;
      kind: "add" | "del" | "ctx";
      body: string;
    }) => void;
    onUpdateComment?: (id: string, body: string) => void;
    onDeleteComment?: (id: string) => void;
  } = $props();

  // ---------- line comments ----------
  /** Anchor of a comment: the one line it hangs under. */
  const anchorKey = (path: string, side: "old" | "new", line: number | null) =>
    `${path}\u0000${side}\u0000${line ?? ""}`;

  const commentsAt = $derived.by(() => {
    const map = new Map<string, ReviewComment[]>();
    for (const c of comments) {
      const k = anchorKey(c.path, c.side, c.line);
      const list = map.get(k);
      if (list) list.push(c);
      else map.set(k, [c]);
    }
    return map;
  });

  /** The anchor whose composer is open, or null. */
  let composeAt = $state<string | null>(null);
  /** The comment being edited, or null while writing a new one. */
  let editingId = $state<string | null>(null);
  /** Text in whichever box is open. */
  let draft = $state("");

  function startComment(
    path: string,
    side: "old" | "new",
    line: number | null,
    code: string,
    kind: "add" | "del" | "ctx",
  ) {
    composeAt = anchorKey(path, side, line);
    pendingAnchor = { path, side, line, code, kind };
    editingId = null;
    draft = "";
  }
  /** What `commit` will attach a new comment to. */
  let pendingAnchor: {
    path: string;
    side: "old" | "new";
    line: number | null;
    code: string;
    kind: "add" | "del" | "ctx";
  } | null = null;

  function startEdit(c: ReviewComment) {
    composeAt = null;
    editingId = c.id;
    draft = c.body;
  }

  function cancelDraft() {
    composeAt = null;
    editingId = null;
    draft = "";
  }

  /** Save whatever box is open: an edit of an existing note, or a brand-new one. */
  function commit() {
    const body = draft.trim();
    if (!body) return cancelDraft();
    if (editingId) {
      onUpdateComment?.(editingId, body);
    } else if (pendingAnchor) {
      onAddComment?.({ ...pendingAnchor, body });
    }
    cancelDraft();
  }

  /**
   * Enter adds the comment; Shift-Enter (and ⌘/Ctrl-Enter) writes a newline.
   *
   * These notes are one or two sentences aimed at an agent, so the common keystroke
   * should be the one that finishes them — the same bargain a chat box makes.
   */
  function draftKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancelDraft();
    } else if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      commit();
    }
  }

  function focusOnMount(node: HTMLTextAreaElement) {
    node.focus();
  }

  const files = $derived<DiffFile[]>(diff ? parseDiff(diff) : []);
  const totals = $derived(
    files.reduce((acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }), {
      added: 0,
      removed: 0,
    }),
  );

  /** Signature per file path, so "viewed" expires when the content changes again. */
  const signatures = $derived(new Map(files.map((f) => [f.path, diffSignature(f)])));

  const viewedCount = $derived(
    files.filter((f) => isViewed?.(f.path, signatures.get(f.path) ?? "")).length,
  );
  /** Fraction of the review that is ticked off, for the progress ring. */
  const viewedFrac = $derived(files.length ? viewedCount / files.length : 0);

  /** Files the user collapsed by hand, plus the ones auto-collapsed on tick. */
  const collapsed = new SvelteSet<string>();
  /** Per-file override of the global unified/split choice. */
  const fileSplit = new SvelteMap<string, boolean>();
  /** Which file's `…` menu is open, if any. */
  let menuFor = $state<string | null>(null);
  /**
   * Where to paint that menu, in viewport coordinates.
   *
   * The file card clips its own overflow (that is what keeps the diff's corners rounded
   * and its header sticky inside the card), which would swallow a menu dropped out of a
   * collapsed file's header. Positioning it against the viewport instead sidesteps the
   * clip entirely.
   */
  let menuPos = $state<{ top: number; right: number }>({ top: 0, right: 0 });

  function openMenu(path: string, e: MouseEvent) {
    if (menuFor === path) {
      menuFor = null;
      return;
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    menuPos = { top: r.bottom + 5, right: Math.max(6, window.innerWidth - r.right) };
    menuFor = path;
  }

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

  // ---------- context expansion ----------

  /** How many extra unchanged lines are shown above each hunk, keyed `<path>:<hunk #>`. */
  const expandedAbove = new SvelteMap<string, number>();
  /** Extra lines shown after a file's last hunk, keyed by path. */
  const expandedTail = new SvelteMap<string, number>();
  /** Current text of a file, once an expand button has needed it. */
  const fileText = new SvelteMap<string, string[]>();
  /** Paths whose expansion is blocked (unreadable file) — the buttons go quiet. */
  const noText = new SvelteSet<string>();

  /** GitHub's step: one click reveals twenty lines. */
  const STEP = 20;

  /**
   * Where each hunk sits relative to the one before it.
   *
   * `avail` is the number of unchanged lines between the previous hunk's last line and
   * this hunk's first — i.e. exactly what the expand button can still reveal, before
   * subtracting whatever has already been revealed.
   */
  interface HunkGap {
    key: string;
    avail: number;
    newStart: number;
    oldStart: number;
  }

  const gaps = $derived.by(() => {
    const byPath = new Map<string, { rows: Map<number, HunkGap>; tailFrom: number }>();
    for (const f of files) {
      const rows = new Map<number, HunkGap>();
      let prevEnd = 0;
      let n = 0;
      for (const r of f.rows) {
        if (r.kind !== "hunk") continue;
        const newStart = r.hunkNew ?? 1;
        rows.set(r.idx, {
          key: `${f.path}:${n}`,
          avail: Math.max(0, newStart - 1 - prevEnd),
          newStart,
          oldStart: r.hunkOld ?? 1,
        });
        prevEnd = newStart + (r.hunkNewLen ?? 0) - 1;
        n++;
      }
      byPath.set(f.path, { rows, tailFrom: prevEnd });
    }
    return byPath;
  });

  /** Lines still hidden above a hunk (0 when there is nothing left to reveal). */
  function remainingAbove(f: DiffFile, row: DiffRow): number {
    if (!loadFile || noText.has(f.path) || f.binary) return 0;
    const g = gaps.get(f.path)?.rows.get(row.idx);
    if (!g) return 0;
    return Math.max(0, g.avail - (expandedAbove.get(g.key) ?? 0));
  }

  /**
   * Lines still hidden after the last hunk.
   *
   * Only once the file has actually been read — until then there is no way to know
   * whether the diff already runs to the end of the file, and a bar at the foot of every
   * file that turns out to reveal nothing is worse than no bar. The header's "expand
   * all" reaches the tail without needing it.
   */
  function remainingTail(f: DiffFile): number {
    if (!loadFile || noText.has(f.path) || f.binary) return 0;
    const lines = fileText.get(f.path);
    if (!lines) return 0;
    const from = gaps.get(f.path)?.tailFrom ?? 0;
    return Math.max(0, lines.length - from - (expandedTail.get(f.path) ?? 0));
  }

  /** Read a file once, remembering both the text and a failure to read it. */
  async function ensureText(path: string): Promise<string[] | null> {
    const have = fileText.get(path);
    if (have) return have;
    if (noText.has(path) || !loadFile) return null;
    const lines = await loadFile(path).catch(() => null);
    if (!lines) {
      noText.add(path);
      return null;
    }
    fileText.set(path, lines);
    return lines;
  }

  /** Reveal `count` more unchanged lines above a hunk (Infinity = the whole gap). */
  async function expandAbove(f: DiffFile, row: DiffRow, count: number) {
    const g = gaps.get(f.path)?.rows.get(row.idx);
    if (!g || !(await ensureText(f.path))) return;
    const shown = expandedAbove.get(g.key) ?? 0;
    expandedAbove.set(g.key, Math.min(g.avail, shown + count));
  }

  async function expandTail(f: DiffFile, count: number) {
    const lines = await ensureText(f.path);
    if (!lines) return;
    const from = gaps.get(f.path)?.tailFrom ?? 0;
    const shown = expandedTail.get(f.path) ?? 0;
    expandedTail.set(f.path, Math.min(Math.max(0, lines.length - from), shown + count));
  }

  /** The `…` menu's "expand all": every gap in the file at once. */
  async function expandWholeFile(f: DiffFile) {
    if (!(await ensureText(f.path))) return;
    const g = gaps.get(f.path);
    if (!g) return;
    for (const gap of g.rows.values()) expandedAbove.set(gap.key, gap.avail);
    await expandTail(f, Number.POSITIVE_INFINITY);
  }

  /**
   * The rows to render for one file: its parsed rows, with the revealed context lines
   * spliced in around the hunks.
   *
   * Synthetic rows carry a negative `idx` (`-newNo`) so they can never be confused with
   * a parsed row, including when the split view reorders everything.
   */
  function viewRows(f: DiffFile): DiffRow[] {
    const lines = fileText.get(f.path);
    if (!lines) return f.rows;
    const meta = gaps.get(f.path);
    if (!meta) return f.rows;
    const out: DiffRow[] = [];
    for (const r of f.rows) {
      if (r.kind === "hunk") {
        const g = meta.rows.get(r.idx);
        const n = g ? Math.min(g.avail, expandedAbove.get(g.key) ?? 0) : 0;
        out.push(r);
        for (let k = n; k >= 1; k--) {
          const newNo = (g as HunkGap).newStart - k;
          if (newNo < 1) continue;
          out.push({
            kind: "ctx",
            text: lines[newNo - 1] ?? "",
            oldNo: (g as HunkGap).oldStart - k,
            newNo,
            idx: -newNo,
          });
        }
        continue;
      }
      out.push(r);
    }
    const tail = expandedTail.get(f.path) ?? 0;
    for (let k = 0; k < tail; k++) {
      const newNo = meta.tailFrom + 1 + k;
      if (newNo > lines.length) break;
      out.push({ kind: "ctx", text: lines[newNo - 1] ?? "", oldNo: null, newNo, idx: -newNo });
    }
    return out;
  }

  /** Key under which a row's syntax-highlighted markup is stored. */
  function rowKey(path: string, row: DiffRow): string {
    return row.idx < 0 ? `${path}:x${row.newNo}` : `${path}:${row.idx}`;
  }

  /**
   * Syntax-highlighted markup per code row, keyed by {@link rowKey}.
   *
   * Filled asynchronously (the grammar for the file's language is imported on demand), so
   * the diff paints immediately as plain text and gains its colours a tick later rather
   * than blocking on a parser the user may not need.
   */
  let highlighted = $state<Record<string, string>>({});

  $effect(() => {
    onSignatures?.(signatures);
  });

  /**
   * A new diff invalidates every expansion: the line numbers it was expressed in belong
   * to the version that has just been replaced.
   */
  $effect(() => {
    void diff;
    expandedAbove.clear();
    expandedTail.clear();
    fileText.clear();
    noText.clear();
    fileSplit.clear();
    menuFor = null;
  });

  $effect(() => {
    // Re-runs when a file is expanded too — the revealed lines want colouring as well.
    const list = files.map((f) => ({ f, rows: viewRows(f) }));
    let cancelled = false;
    void (async () => {
      const next: Record<string, string> = {};
      for (const { f, rows } of list) {
        // Hunk and meta rows are not code; only the +/-/context lines are parsed, and
        // their keys are kept so the result can be matched back to the row.
        const keys: string[] = [];
        const lines: string[] = [];
        for (const r of rows) {
          if (r.kind === "add" || r.kind === "del" || r.kind === "ctx") {
            keys.push(rowKey(f.path, r));
            lines.push(r.text);
          }
        }
        if (!lines.length) continue;
        const html = await highlightLines(f.path, lines);
        if (cancelled) return;
        if (!html) continue;
        html.forEach((h: string, n: number) => (next[keys[n]] = h));
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

  /** The +/− glyph shown in its own narrow column, as GitHub does. */
  function marker(kind: string): string {
    return kind === "add" ? "+" : kind === "del" ? "−" : " ";
  }

  /** `dir/sub/file.ts` → `["dir/sub/", "file.ts"]`, so the name can be emphasised. */
  function splitPath(path: string): [string, string] {
    const i = path.lastIndexOf("/");
    return i < 0 ? ["", path] : [path.slice(0, i + 1), path.slice(i + 1)];
  }

  /** Absolute-path-free "open this file", used by the per-file menu. */
  function openInEditor(f: DiffFile) {
    menuFor = null;
    if (files.length === 1 && onEdit) onEdit();
    else onOpenPath?.(f.path);
  }

  function canOpen(f: DiffFile): boolean {
    return files.length === 1 ? !!onEdit : !!onOpenPath && !f.notes.includes("deleted");
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape") menuFor = null;
  }}
/>

<!--
  One line's comment thread, plus the box for writing a new one. Rendered as an extra
  table row under the line it belongs to, which is what makes a comment read as being
  attached to that line rather than to the file.
-->
{#snippet thread(path: string, side: "old" | "new", line: number | null, span: number)}
  {@const key = anchorKey(path, side, line)}
  {@const list = commentsAt.get(key) ?? []}
  {#if list.length || composeAt === key}
    <tr class="cmt-row">
      <td class="cmt-cell" colspan={span}>
        <div class="cmt-box">
          {#each list as c (c.id)}
            {#if editingId === c.id}
              <div class="cmt writing">
                <textarea
                  bind:value={draft}
                  use:focusOnMount
                  onkeydown={draftKey}
                  spellcheck="false"
                  rows="2"
                ></textarea>
                <div class="cmt-actions">
                  <span class="cmt-hint">⏎ save · ⇧⏎ newline · Esc cancel</span>
                  <button class="cmt-btn" onclick={cancelDraft}>Cancel</button>
                  <button class="cmt-btn pri" onclick={commit}>Save</button>
                </div>
              </div>
            {:else}
              <div class="cmt">
                <span class="cmt-at" title="Comment on {path}{line != null ? `:${line}` : ''}"
                  >{line ?? "file"}</span
                >
                <div class="cmt-body">{c.body}</div>
                <div class="cmt-tools">
                  <button class="icon-btn" title="Edit comment" onclick={() => startEdit(c)}>
                    <Icon name="edit" size={11} />
                  </button>
                  <button
                    class="icon-btn"
                    title="Delete comment"
                    onclick={() => onDeleteComment?.(c.id)}
                  >
                    <Icon name="trash" size={11} />
                  </button>
                </div>
              </div>
            {/if}
          {/each}
          {#if composeAt === key}
            <div class="cmt writing">
              <textarea
                bind:value={draft}
                use:focusOnMount
                onkeydown={draftKey}
                spellcheck="false"
                rows="2"
                placeholder="Note for Claude on line {line ?? '—'}…"
              ></textarea>
              <div class="cmt-actions">
                <span class="cmt-hint">⏎ add · ⇧⏎ newline · Esc cancel</span>
                <button class="cmt-btn" onclick={cancelDraft}>Cancel</button>
                <button class="cmt-btn pri" onclick={commit}>Add</button>
              </div>
            </div>
          {/if}
        </div>
      </td>
    </tr>
  {/if}
{/snippet}

<div class="diff">
  <!-- Review-wide bar: what is being reviewed, how much of it is left, how to read it. -->
  <div class="head">
    <span class="title"><span class="name">{title || "Changes"}</span></span>
    {#if files.length}
      <span class="stat add">+{totals.added}</span>
      <span class="stat del">−{totals.removed}</span>
    {/if}
    <span class="sp"></span>
    {#if files.length}
      <!-- GitHub's review meter: a ring that fills as files are ticked off. -->
      <span class="progress" class:done={viewedCount === files.length} title="Files reviewed">
        <span
          class="ring"
          style:background="conic-gradient(currentColor {viewedFrac * 360}deg, var(--surface-4) 0)"
        ></span>
        {viewedCount} / {files.length} viewed
      </span>
    {/if}
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
        {@const asSplit = fileSplit.get(f.path) ?? split}
        {@const rows = viewRows(f)}
        {@const gutters = (f.hasOld ? 1 : 0) + (f.hasNew ? 1 : 0)}
        <section class="file" class:viewed class:shut>
          <div class="file-head">
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
            {#if !shut && loadFile && !f.binary}
              <button
                class="icon-btn"
                title="Expand all unchanged lines"
                onclick={() => expandWholeFile(f)}
              >
                <Icon name="unfold" size={12} />
              </button>
            {/if}
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
              class="icon-btn box"
              title={asSplit ? "Show this file unified" : "Show this file side by side"}
              onclick={() => fileSplit.set(f.path, !asSplit)}
            >
              <Icon name={asSplit ? "rows" : "columns"} size={12} />
            </button>
            <button
              class="viewed-btn"
              class:on={viewed}
              title="Mark this file as reviewed"
              onclick={() => toggleViewed(f)}
            >
              <Icon name={viewed ? "checkSquare" : "square"} size={13} /> Viewed
            </button>
            <div class="menu-wrap">
              <button class="icon-btn box" title="More" onclick={(e) => openMenu(f.path, e)}>
                <Icon name="ellipsis" size={12} />
              </button>
              {#if menuFor === f.path}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div class="menu-back" role="presentation" onclick={() => (menuFor = null)}></div>
                <div class="menu" style:top="{menuPos.top}px" style:right="{menuPos.right}px">
                  {#if canOpen(f)}
                    <button onclick={() => openInEditor(f)}
                      ><Icon name="edit" size={12} /> Open in editor</button
                    >
                  {/if}
                  <button
                    onclick={() => {
                      menuFor = null;
                      void copyPath(f.path);
                    }}><Icon name="copy" size={12} /> Copy path</button
                  >
                  {#if loadFile && !f.binary}
                    <button
                      onclick={() => {
                        menuFor = null;
                        void expandWholeFile(f);
                      }}><Icon name="unfold" size={12} /> Expand all context</button
                    >
                  {/if}
                  <button
                    onclick={() => {
                      menuFor = null;
                      fileSplit.set(f.path, !asSplit);
                    }}
                    ><Icon name={asSplit ? "rows" : "columns"} size={12} />
                    {asSplit ? "Unified view" : "Side-by-side view"}</button
                  >
                  <button
                    onclick={() => {
                      menuFor = null;
                      toggleCollapsed(f.path);
                    }}
                    ><Icon name="chevronDown" size={12} />
                    {shut ? "Expand file" : "Collapse file"}</button
                  >
                  <button
                    onclick={() => {
                      menuFor = null;
                      toggleViewed(f);
                    }}
                    ><Icon name={viewed ? "square" : "checkSquare"} size={12} />
                    {viewed ? "Mark as not viewed" : "Mark as viewed"}</button
                  >
                </div>
              {/if}
            </div>
          </div>

          {#if !shut}
            {#if f.binary}
              <div class="msg">Binary file — no textual diff.</div>
            {:else if asSplit}
              <!--
                Side by side. The old file's lines and the new file's lines are zipped by
                `toSideBySide`, so an edited line shows its before and after opposite each
                other instead of ten rows apart.
              -->
              <table class="split">
                <tbody>
                  {#each toSideBySide(rows) as sr, i (i)}
                    {#if sr.full}
                      {@const left = sr.full.kind === "hunk" ? remainingAbove(f, sr.full) : 0}
                      <tr class={sr.full.kind}>
                        <td class="ln exp">
                          {#if left > 0}
                            <button
                              class="unfold"
                              title="Expand {Math.min(STEP, left)} lines above ({left} hidden)"
                              onclick={() => expandAbove(f, sr.full as DiffRow, STEP)}
                            >
                              <Icon name="chevronsUp" size={12} />
                            </button>
                          {/if}
                        </td>
                        <td class="txt" colspan="5">{display(sr.full.text)}</td>
                      </tr>
                    {:else}
                      <tr>
                        <td class="ln {sr.left ? sr.left.kind : 'pad'}">{sr.left?.oldNo ?? ""}</td>
                        <td class="mk {sr.left ? sr.left.kind : 'pad'}"
                          >{sr.left ? marker(sr.left.kind) : ""}</td
                        >
                        <td class="txt half {sr.left ? sr.left.kind : 'pad'}">
                          {#if sr.left}{#if highlighted[rowKey(f.path, sr.left)]}<!-- eslint-disable-next-line svelte/no-at-html-tags -->{@html highlighted[
                                rowKey(f.path, sr.left)
                              ]}{:else}{display(sr.left.text)}{/if}{/if}
                        </td>
                        <td class="ln {sr.right ? sr.right.kind : 'pad'}">{sr.right?.newNo ?? ""}</td>
                        <td class="mk {sr.right ? sr.right.kind : 'pad'}">
                          {sr.right ? marker(sr.right.kind) : ""}
                          {#if onAddComment && sr.right}
                            <button
                              class="add-c"
                              title="Comment on this line"
                              aria-label="Comment on this line"
                              onclick={() =>
                                startComment(
                                  f.path,
                                  sr.right!.newNo != null ? "new" : "old",
                                  sr.right!.newNo ?? sr.right!.oldNo ?? null,
                                  sr.right!.text,
                                  sr.right!.kind === "add" || sr.right!.kind === "del"
                                    ? sr.right!.kind
                                    : "ctx",
                                )}><Icon name="plus" size={11} /></button
                            >
                          {/if}
                        </td>
                        <td class="txt half {sr.right ? sr.right.kind : 'pad'}">
                          {#if sr.right}{#if highlighted[rowKey(f.path, sr.right)]}<!-- eslint-disable-next-line svelte/no-at-html-tags -->{@html highlighted[
                                rowKey(f.path, sr.right)
                              ]}{:else}{display(sr.right.text)}{/if}{/if}
                        </td>
                      </tr>
                      {#if sr.right}
                        {@render thread(
                          f.path,
                          sr.right.newNo != null ? "new" : "old",
                          sr.right.newNo ?? sr.right.oldNo ?? null,
                          6,
                        )}
                      {/if}
                    {/if}
                  {/each}
                  {#if remainingTail(f) > 0}
                    <tr class="hunk tail">
                      <td class="ln exp">
                        <button
                          class="unfold"
                          title="Expand the lines below"
                          onclick={() => expandTail(f, STEP)}
                        >
                          <Icon name="chevronsDown" size={12} />
                        </button>
                      </td>
                      <td class="txt" colspan="5"></td>
                    </tr>
                  {/if}
                </tbody>
              </table>
            {:else}
              <table>
                <tbody>
                  {#each rows as row (row.idx)}
                    {@const left = row.kind === "hunk" ? remainingAbove(f, row) : 0}
                    <tr class={row.kind}>
                      {#if row.kind === "hunk"}
                        <td class="ln exp" colspan={gutters || 1}>
                          {#if left > 0}
                            <button
                              class="unfold"
                              title="Expand {Math.min(STEP, left)} lines above ({left} hidden)"
                              onclick={() => expandAbove(f, row, STEP)}
                            >
                              <Icon name="chevronsUp" size={12} />
                            </button>
                          {/if}
                        </td>
                        <td class="txt" colspan="2">{display(row.text)}</td>
                      {:else}
                        <!--
                          A pure-addition file has no old-side numbering at all; rendering
                          the column anyway left a dead strip down the left of every new file.
                        -->
                        {#if f.hasOld}<td class="ln">{row.oldNo ?? ""}</td>{/if}
                        {#if f.hasNew}<td class="ln">{row.newNo ?? ""}</td>{/if}
                        <td class="mk">
                          {marker(row.kind)}
                          {#if onAddComment}
                            <button
                              class="add-c"
                              title="Comment on this line"
                              aria-label="Comment on this line"
                              onclick={() =>
                                startComment(
                                  f.path,
                                  row.newNo != null ? "new" : "old",
                                  row.newNo ?? row.oldNo ?? null,
                                  row.text,
                                  row.kind === "add" || row.kind === "del" ? row.kind : "ctx",
                                )}><Icon name="plus" size={11} /></button
                            >
                          {/if}
                        </td>
                        <td class="txt"
                          >{#if highlighted[rowKey(f.path, row)]}<!-- eslint-disable-next-line svelte/no-at-html-tags -->{@html highlighted[
                              rowKey(f.path, row)
                            ]}{:else}{display(row.text)}{/if}</td
                        >
                      {/if}
                    </tr>
                    {#if row.kind !== "hunk"}
                      {@render thread(
                        f.path,
                        row.newNo != null ? "new" : "old",
                        row.newNo ?? row.oldNo ?? null,
                        (gutters || 1) + 2,
                      )}
                    {/if}
                  {/each}
                  {#if remainingTail(f) > 0}
                    <tr class="hunk tail">
                      <td class="ln exp" colspan={gutters || 1}>
                        <button
                          class="unfold"
                          title="Expand the lines below"
                          onclick={() => expandTail(f, STEP)}
                        >
                          <Icon name="chevronsDown" size={12} />
                        </button>
                      </td>
                      <td class="txt" colspan="2"></td>
                    </tr>
                  {/if}
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
    background: var(--bg);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 34px;
    padding: 0 12px;
    background: var(--surface-1);
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
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
  }
  /* The ring itself is the fill; the inner disc punches it back to a 2px band. */
  .ring {
    width: 13px;
    height: 13px;
    border-radius: 50%;
    flex-shrink: 0;
    -webkit-mask: radial-gradient(circle, transparent 3.6px, #000 4.2px);
    mask: radial-gradient(circle, transparent 3.6px, #000 4.2px);
  }
  .progress.done {
    color: var(--ok);
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
    padding: 10px 12px 24px;
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

  /* ---- per-file card ---- */
  /*
    Each file is its own bordered card with air around it, the way a pull request reads:
    the boundary between "the end of this file" and "the start of the next" is the thing
    a long review needs most, and a hairline between flush sections never gave it.
  */
  .file {
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--term-bg);
    margin-bottom: 12px;
    overflow: hidden;
  }
  .file.shut {
    background: var(--surface-1);
  }
  .file-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 10px 7px 4px;
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-secondary);
    position: sticky;
    top: 0;
    z-index: 2;
  }
  .file.shut > .file-head {
    border-bottom-color: transparent;
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
    font-size: 12px;
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
  /* The right-hand cluster's buttons are chrome, matching the Viewed control's weight. */
  .icon-btn.box {
    border: 1px solid var(--border-strong);
    background: var(--surface-3);
    color: var(--text-muted);
    padding: 4px;
  }
  .icon-btn.box:hover {
    background: var(--surface-4);
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

  /* ---- per-file menu ---- */
  .menu-wrap {
    position: relative;
    flex-shrink: 0;
  }
  /* Catches the click that dismisses the menu, without stealing the rest of the page. */
  .menu-back {
    position: fixed;
    inset: 0;
    z-index: 40;
  }
  .menu {
    position: fixed;
    z-index: 41;
    min-width: 186px;
    padding: 4px;
    background: var(--surface-float);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-sm);
    box-shadow: var(--shadow-md);
    display: flex;
    flex-direction: column;
  }
  .menu button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    font-family: var(--font-sans);
    font-size: 12px;
    text-align: left;
    padding: 6px 8px;
    border-radius: 5px;
    cursor: pointer;
    white-space: nowrap;
  }
  .menu button:hover {
    background: var(--surface-3);
    color: var(--text);
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
    background: var(--surface-1);
    white-space: nowrap;
  }
  /* The +/− glyph, in its own column so it reads like GitHub without joining a copy. */
  td.mk {
    position: relative;
    width: 1%;
    padding: 0 0 0 6px;
    user-select: none;
    color: var(--text-ghost);
    white-space: pre;
  }

  /* ---- line comments ---- */
  /*
    The ✎ affordance sits in the marker column and appears on approach: a permanent
    button on every one of a thousand rows would out-shout the diff it annotates.
  */
  .add-c {
    position: absolute;
    left: -2px;
    top: 50%;
    transform: translateY(-50%);
    display: none;
    place-items: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: var(--accent);
    color: #fff;
    cursor: pointer;
    z-index: 2;
  }
  tr:hover .add-c {
    display: grid;
  }
  .add-c:hover {
    background: var(--accent-bright, var(--accent));
  }
  .cmt-cell {
    padding: 5px 10px 5px 30px;
    background: color-mix(in srgb, var(--accent) 4%, var(--surface-1));
    border-top: 1px solid var(--border-muted);
    border-bottom: 1px solid var(--border-muted);
  }
  .cmt-box {
    display: flex;
    flex-direction: column;
    gap: 5px;
    max-width: 620px;
  }
  /* A written note reads as one line of prose with its line number in front. */
  .cmt {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 5px 7px 5px 8px;
    border: 1px solid var(--border);
    border-left: 2px solid var(--accent);
    border-radius: 6px;
    background: var(--surface-2);
  }
  .cmt-at {
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 700;
    color: var(--text-ghost);
  }
  .cmt-body {
    flex: 1;
    min-width: 0;
    font-family: var(--font-sans);
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .cmt-tools {
    display: flex;
    gap: 2px;
    flex-shrink: 0;
    opacity: 0;
    transition: opacity var(--t-fast);
  }
  .cmt:hover .cmt-tools {
    opacity: 1;
  }
  /* The composer: a box that starts two lines tall and grows, not a dialog. */
  .cmt.writing {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
    padding: 7px;
  }
  .cmt textarea {
    width: 100%;
    min-height: 42px;
    resize: vertical;
    border: 1px solid var(--border-strong);
    border-radius: 5px;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-sans);
    font-size: 12.5px;
    line-height: 1.45;
    padding: 5px 7px;
    outline: none;
  }
  .cmt textarea:focus {
    border-color: var(--accent);
  }
  .cmt-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .cmt-hint {
    flex: 1;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-ghost);
  }
  .cmt-btn {
    border: 1px solid var(--border-strong);
    background: transparent;
    color: var(--text-muted);
    font-family: var(--font-sans);
    font-size: 11.5px;
    font-weight: 700;
    padding: 3px 9px;
    border-radius: 5px;
    cursor: pointer;
  }
  .cmt-btn:hover {
    color: var(--text);
    background: var(--surface-4);
  }
  .cmt-btn.pri {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .cmt-btn.pri:hover {
    background: var(--accent-bright, var(--accent));
  }
  td.txt {
    /*
      The +/− column is backed up by a 2px colour bar on the row: the tint and the bar
      are what read at a glance, the glyph is what makes it unambiguous.
    */
    padding: 0 10px 0 5px;
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
  tr.add td.mk,
  td.txt.add,
  td.mk.add {
    background: rgba(89, 168, 105, 0.13);
  }
  tr.add td.txt,
  td.txt.add {
    border-left-color: var(--ok);
  }
  tr.add td.mk,
  td.mk.add {
    color: var(--ok);
  }
  tr.add td.ln,
  td.ln.add {
    color: rgba(137, 199, 150, 0.85);
    background: rgba(89, 168, 105, 0.1);
  }
  tr.del td.txt,
  tr.del td.mk,
  td.txt.del,
  td.mk.del {
    background: rgba(247, 84, 100, 0.13);
  }
  tr.del td.txt,
  td.txt.del {
    border-left-color: var(--danger);
  }
  tr.del td.mk,
  td.mk.del {
    color: var(--danger);
  }
  tr.del td.ln,
  td.ln.del {
    color: rgba(229, 138, 148, 0.85);
    background: rgba(247, 84, 100, 0.1);
  }
  /* The blank opposite an unpaired add/del in split view. */
  td.txt.pad,
  td.mk.pad,
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
  tr.hunk.tail td {
    height: 22px;
  }
  /*
    The hunk gutter doubles as the "show me what is between these hunks" control — the
    one place in a review where the missing lines are obviously missing.
  */
  tr.hunk td.ln.exp {
    background: var(--accent-softer);
    padding: 0;
    text-align: center;
  }
  .unfold {
    display: grid;
    place-items: center;
    width: 100%;
    min-height: 20px;
    border: none;
    background: transparent;
    color: var(--accent-bright);
    cursor: pointer;
    padding: 2px 0;
  }
  .unfold:hover {
    background: var(--accent-soft);
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
  td.txt :global(.tok-doc) {
    color: #5f826b;
  }
  td.txt :global(.tok-meta) {
    color: #b3ae60;
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
