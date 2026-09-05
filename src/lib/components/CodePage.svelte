<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import { tick, untrack } from "svelte";
  import { app } from "$lib/store/app.svelte";
  import Icon from "./Icon.svelte";
  import FileTree from "./FileTree.svelte";
  import CodeEditor from "./CodeEditor.svelte";
  import RunPanel from "./RunPanel.svelte";
  import SearchPalette from "./SearchPalette.svelte";
  import {
    gitStatus,
    isGitRepo,
    resolveTestCommand,
    invalidateSearchIndex,
    warmSearchIndex,
    baseName,
    type Script,
  } from "$lib/code/api";
  import type { TestTarget } from "$lib/code/tests";
  import { fileBadge } from "$lib/code/fileIcons";

  const ws = $derived(app.activeWorkspace);
  const root = $derived(ws?.path ?? "");

  // ---------- file tree ----------
  /** Expanded directories, shared by every level of the tree (see FileTree). */
  const expanded = new SvelteSet<string>();
  /** Bumped to make the tree re-read every mounted level. */
  let treeToken = $state(0);

  /**
   * Collapse every open folder back to the workspace root.
   *
   * The tree reads its open state straight out of `expanded`, so emptying the set is the
   * whole operation — no level has to be remounted, and nothing about the open tabs or the
   * scroll position changes.
   */
  function collapseAll() {
    expanded.clear();
  }

  // ---------- changed-file markers ----------
  /**
   * Absolute paths git reports as changed, for the file tree's markers only.
   *
   * Reading a diff belongs to the Review page; all the editor wants to know is which
   * files in the tree an agent has touched.
   */
  let changedPaths = $state<Set<string>>(new Set());

  // ---------- open editor tabs ----------
  const openPaths = $derived(ws ? app.codeOpenPaths(ws.id) : []);
  const activePath = $derived(ws ? app.codeActivePath(ws.id) : null);
  /** Paths with unsaved edits, reported by the editor. */
  const dirtyPaths = new SvelteSet<string>();

  /** The editor's exported handle (see the `export function`s in CodeEditor). */
  let editor = $state<{
    save: (force?: boolean) => Promise<boolean>;
    forget: (path: string) => void;
    isDirty: (path: string) => boolean;
  } | null>(null);

  // ---------- search ----------
  /** The search palette's mode while it is open, or null when it is closed. */
  let searchMode = $state<"file" | "symbol" | "text" | null>(null);
  /** The line a search hit asked the editor to scroll to (see CodeEditor's `revealAt`). */
  let revealAt = $state<{ path: string; line: number; token: number } | null>(null);
  let revealToken = 0;

  /** Open a search hit: its file, and the line it was found on. */
  function openHit(path: string, line: number) {
    openFile(path);
    revealAt = line > 0 ? { path, line, token: ++revealToken } : null;
  }

  /** The Run panel's handle, for running a test the editor's gutter picked. */
  let runPanel = $state<{ runScript: (script: Script) => void } | null>(null);
  /** Why the last gutter click couldn't run (no build tool found, unknown language). */
  let testError = $state<string | null>(null);

  /**
   * Run one test from the editor gutter — the ▶ next to a `@Test`, or ⌘⇧R.
   *
   * Saves first, because every runner here compiles from DISK: running the arrow next to a
   * method you just edited and watching the old code pass is the one outcome that would
   * make the feature untrustworthy. Then the Run panel is opened (it is where the output,
   * the input and Ctrl-C live) and handed the resolved command.
   */
  async function runTest(target: TestTarget, path: string) {
    if (!ws) return;
    testError = null;
    if (dirtyPaths.has(path) && !(await editor?.save())) return; // conflict bar has it
    let script: Script;
    try {
      script = await resolveTestCommand(root, path, target);
    } catch (e) {
      testError = String(e);
      return;
    }
    const panel = await openRunPanel();
    if (!panel) {
      testError = "The Run panel did not open.";
      return;
    }
    panel.runScript(script);
  }

  /**
   * Show the Run panel and wait for it to actually exist.
   *
   * It is rendered only while it has a height, so opening it and calling into it in the
   * same tick would find nothing bound. A few frames of grace covers the mount; the guard
   * is a bounded loop rather than a fixed delay so the common case (already open) is
   * instant.
   */
  async function openRunPanel() {
    if (app.codeRunHeight <= 0) {
      app.codeRunHeight = 300;
      app.persist();
    }
    for (let i = 0; i < 30 && !runPanel; i++) await tick();
    return runPanel;
  }

  function onDirty(path: string, dirty: boolean) {
    if (dirty) dirtyPaths.add(path);
    else dirtyPaths.delete(path);
  }

  function openFile(path: string) {
    if (!ws) return;
    app.openCodeFile(ws.id, path);
  }

  function closeTab(path: string) {
    if (!ws) return;
    if (dirtyPaths.has(path)) {
      const ok = confirm(`${baseName(path)} has unsaved changes. Close it anyway?`);
      if (!ok) return;
      dirtyPaths.delete(path);
    }
    editor?.forget(path);
    app.closeCodeFile(ws.id, path);
  }

  // ---------- git ----------
  /** Re-read which files git considers changed, for the tree's markers. */
  async function refreshChanged() {
    if (!root) return;
    try {
      if (!(await isGitRepo(root))) {
        changedPaths = new Set();
        return;
      }
      const st = await gitStatus(root);
      changedPaths = new Set(st.changes.map((c) => c.absPath).filter(Boolean));
    } catch {
      changedPaths = new Set();
    }
  }

  function refreshAll() {
    treeToken++;
    void refreshChanged();
    // The search index is otherwise trusted for a few seconds; the refresh button is the
    // user saying the tree changed, so a search right after it must see the change.
    if (root) void invalidateSearchIndex(root).catch(() => {});
  }

  // ---------- visibility ----------
  let pageEl = $state<HTMLDivElement | null>(null);
  const isShown = () => !!pageEl && pageEl.clientWidth > 0 && pageEl.clientHeight > 0;

  /**
   * The Code view stays mounted (hidden) so the run shell survives switching away, so
   * "the user is looking at it" has to be observed rather than assumed. The tree's
   * changed-file markers are re-read on every show and then polled while visible — an
   * agent committing or editing in the background is the normal case here.
   */
  $effect(() => {
    const el = pageEl;
    const r = root;
    if (!el || !r) return;
    let visible = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const stopPoll = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const sync = () => {
      const now = isShown();
      if (now === visible) return;
      visible = now;
      if (now) {
        void refreshChanged();
        // Fire-and-forget: a failure here only means the first search pays for the walk.
        void warmSearchIndex(r).catch(() => {});
        timer = setInterval(() => void refreshChanged(), 5000);
      } else {
        stopPoll();
      }
    };
    const observer = new MutationObserver(sync);
    for (let node: HTMLElement | null = el; node; node = node.parentElement) {
      observer.observe(node, { attributes: true, attributeFilter: ["style", "class", "hidden"] });
    }
    untrack(sync);

    return () => {
      observer.disconnect();
      stopPoll();
    };
  });

  /**
   * ⌘P / ⌘⇧O / ⌘⇧F open the palette on files, symbols or text.
   *
   * Registered in the CAPTURE phase, and here rather than with the app's other global
   * shortcuts, for the same reason: the focus is usually inside CodeMirror, which is
   * `contenteditable` — the global handler deliberately ignores editable targets, and
   * CodeMirror's own keymap would otherwise swallow the chord first.
   */
  $effect(() => {
    const el = pageEl;
    if (!el) return;
    const onKeydown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || !isShown()) return;
      const key = e.key.toLowerCase();
      const mode =
        key === "p" && !e.shiftKey
          ? "file"
          : key === "o" && e.shiftKey
            ? "symbol"
            : key === "f" && e.shiftKey
              ? "text"
              : null;
      if (!mode) return;
      e.preventDefault();
      e.stopPropagation();
      searchMode = mode;
    };
    window.addEventListener("keydown", onKeydown, true);
    return () => window.removeEventListener("keydown", onKeydown, true);
  });

  // ---------- resizing ----------
  function dragRail(e: PointerEvent) {
    const startX = e.clientX;
    const startW = app.codeTreeWidth;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      app.codeTreeWidth = Math.max(170, Math.min(560, startW + ev.clientX - startX));
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      app.persist();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  }

  function dragRun(e: PointerEvent) {
    const startY = e.clientY;
    const startH = app.codeRunHeight || 240;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      app.codeRunHeight = Math.max(0, Math.min(900, startH + startY - ev.clientY));
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      app.persist();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  }

  function toggleRun() {
    app.codeRunHeight = app.codeRunHeight > 0 ? 0 : 260;
    app.persist();
  }

  function toggleHidden() {
    app.codeShowHidden = !app.codeShowHidden;
    app.persist();
  }
</script>

<div class="code-page" bind:this={pageEl}>
  {#if !ws}
    <div class="no-ws">
      <Icon name="folder" size={26} />
      <p>Open a workspace to browse, edit and run its code.</p>
    </div>
  {:else}
    <aside class="rail" style:width="{app.codeTreeWidth}px">
      <div class="rail-tabs">
        <span class="rail-title"><Icon name="folder" size={13} /> Files</span>
        <button
          class="rail-search"
          title="Search files, symbols and text (⌘P)"
          aria-label="Search workspace"
          onclick={() => (searchMode = "file")}><Icon name="search" size={13} /></button
        >
      </div>

      <div class="rail-head">
        <span class="ws-name" title={root}>{ws.name}</span>
        <button
          class="mini"
          class:on={app.codeShowHidden}
          title="Show hidden files"
          onclick={toggleHidden}><Icon name="eye" size={13} /></button
        >
        <button
          class="mini"
          title="Collapse all folders"
          aria-label="Collapse all folders"
          disabled={expanded.size === 0}
          onclick={collapseAll}><Icon name="fold" size={13} /></button
        >
        <button class="mini" title="Refresh" onclick={refreshAll}
          ><Icon name="restore" size={13} /></button
        >
      </div>
      <div class="rail-body">
        {#key `${root}:${treeToken}`}
          <FileTree
            {root}
            dir={root}
            {expanded}
            showHidden={app.codeShowHidden}
            {activePath}
            changed={changedPaths}
            onOpen={openFile}
          />
        {/key}
      </div>
    </aside>

    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="gutter-v"
      role="separator"
      aria-orientation="vertical"
      onpointerdown={dragRail}
    ></div>

    <div class="center">
      <div class="tabs">
        {#each openPaths as p (p)}
          {@const badge = fileBadge(baseName(p))}
          {@const isDirty = dirtyPaths.has(p)}
          <div class="tab" class:on={p === activePath} class:dirty={isDirty}>
            <button class="tab-main" onclick={() => app.setActiveCodeFile(ws.id, p)} title={p}>
              <span class="tab-badge" style:color={badge.color}>{badge.label}</span>
              <span class="tab-name">{baseName(p)}</span>
            </button>
            <button
              class="tab-x"
              title={isDirty ? "Close (unsaved changes)" : "Close"}
              onclick={() => closeTab(p)}
            >
              <!-- The unsaved dot lives where the ✕ does and swaps to it on approach, so
                   a tab never carries two competing marks at its right edge. -->
              {#if isDirty}<span class="dot"></span>{/if}
              <Icon name="close" size={11} />
            </button>
          </div>
        {/each}
        <span class="tabs-sp"></span>
        <button
          class="run-toggle"
          class:on={app.codeRunHeight > 0}
          title="Run panel"
          onclick={toggleRun}><Icon name="panelBottom" size={13} /> Run</button
        >
      </div>

      {#if testError}
        <div class="test-err">
          <Icon name="alert" size={13} />
          <span>{testError}</span>
          <button title="Dismiss" onclick={() => (testError = null)}
            ><Icon name="close" size={11} /></button
          >
        </div>
      {/if}

      <div class="stack">
        <CodeEditor
          bind:this={editor}
          {root}
          path={activePath}
          {onDirty}
          onRunTest={runTest}
          {revealAt}
        />
      </div>

      {#if app.codeRunHeight > 0}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
          class="gutter-h"
          role="separator"
          aria-orientation="horizontal"
          onpointerdown={dragRun}
        ></div>
        <div class="run" style:height="{app.codeRunHeight}px">
          <RunPanel bind:this={runPanel} workspaceId={ws.id} {root} />
        </div>
      {/if}
    </div>
  {/if}

  {#if searchMode && root}
    <SearchPalette
      {root}
      requestedMode={searchMode}
      onOpen={openHit}
      onClose={() => (searchMode = null)}
    />
  {/if}
</div>

<style>
  .code-page {
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: flex;
    background: var(--bg);
  }
  .no-ws {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: var(--text-faint);
    font-size: 13px;
  }
  .no-ws p {
    margin: 0;
  }

  /* ---- left rail ---- */
  .rail {
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: var(--surface-1);
    border-right: 1px solid var(--border);
  }
  /* Height matches .tabs so the rail and the editor share one horizontal rule. */
  .rail-tabs {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 6px 0 10px;
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .rail-title {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text);
    font-size: 12px;
    font-weight: 700;
  }
  .rail-tabs button {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 11.5px;
    font-weight: 700;
    padding: 4px 6px;
    border-radius: 6px;
    cursor: pointer;
  }
  .rail-tabs button:hover {
    background: var(--surface-3);
    color: var(--text);
  }
  .rail-head {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 6px 0 9px;
    border-bottom: 1px solid var(--border-muted);
    flex-shrink: 0;
  }
  .ws-name {
    flex: 1;
    font-size: 10.5px;
    font-weight: 800;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mini {
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    color: var(--text-faint);
    padding: 3px;
    border-radius: 5px;
    cursor: pointer;
  }
  .mini:hover {
    background: var(--surface-3);
    color: var(--text);
  }
  .mini.on {
    color: var(--accent-bright);
  }
  /* Nothing is expanded: the button stays in place, but reads as unavailable. */
  .mini:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .mini:disabled:hover {
    background: transparent;
    color: var(--text-faint);
  }
  .rail-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 4px;
  }

  /* ---- gutters ---- */
  .test-err {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 5px 10px;
    font-size: 11.5px;
    color: var(--danger);
    background: var(--danger-bg);
    border-bottom: 1px solid var(--border);
  }
  .test-err span {
    flex: 1;
    min-width: 0;
  }
  .test-err button {
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    display: flex;
    padding: 2px;
  }

  .rail-search {
    flex: 0 0 auto !important;
    padding: 0 8px !important;
    color: var(--text-faint) !important;
  }
  .rail-search:hover {
    color: var(--accent-bright) !important;
  }

  .gutter-v {
    width: 4px;
    cursor: col-resize;
    background: transparent;
    flex-shrink: 0;
  }
  .gutter-v:hover {
    background: var(--accent-line);
  }
  .gutter-h {
    height: 4px;
    cursor: row-resize;
    background: transparent;
    flex-shrink: 0;
  }
  .gutter-h:hover {
    background: var(--accent-line);
  }

  /* ---- centre ---- */
  .center {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .tabs {
    display: flex;
    align-items: stretch;
    gap: 2px;
    height: 32px;
    padding: 0 6px;
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    flex-shrink: 0;
  }
  .tabs::-webkit-scrollbar {
    height: 0;
  }
  /*
    Tabs are as wide as their filename, up to a generous cap: `CancelZigzagPendingRe…`
    tells you nothing that `CancelZigzag…Runner.kt` does not, and in a file tree of
    same-prefix names the truncated head is the least useful half.
  */
  .tab {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    max-width: 320px;
    border-radius: 6px 6px 0 0;
    color: var(--text-muted);
  }
  .tab:hover {
    background: var(--surface-3);
    color: var(--text);
  }
  .tab.on:hover {
    background: var(--term-bg);
  }
  /*
    The selected tab is the one joined to the canvas below it: same background as the
    editor, ordinary text colour, and a single accent underline along the seam. The blue
    label and the focus ring it used to wear turned one tab into the loudest thing on
    screen — selection needs to be legible, not shouted.
  */
  .tab.on {
    background: var(--term-bg);
    color: var(--text);
    box-shadow: inset 0 -2px 0 var(--accent);
  }
  .tab.on .tab-name {
    font-weight: 600;
  }
  .tab.on .tab-x {
    color: var(--text-faint);
  }
  /* Clicking a tab already says which tab it is; the ring only adds noise. */
  .tab-main:focus-visible,
  .tab-x:focus-visible {
    box-shadow: none;
  }
  /*
    The diff tab reads as a diff through its icon alone. It was briefly given its own
    amber accent, which just put two competing highlight colours side by side in one
    tab strip — the distinction was never worth the clash.
  */
  .tab-badge {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 15px;
    height: 15px;
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: 8.5px;
    font-weight: 800;
    letter-spacing: -0.2px;
    background: color-mix(in srgb, currentColor 15%, transparent);
  }
  .tab-main {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    border: none;
    background: transparent;
    color: inherit;
    font-size: 12px;
    font-weight: 600;
    font-family: var(--font-sans);
    padding: 0 4px 0 9px;
    height: 100%;
    cursor: pointer;
  }
  .tab-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tab .dot {
    position: absolute;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--warn);
  }
  .tab-x {
    position: relative;
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    color: var(--text-ghost);
    padding: 3px;
    margin-right: 5px;
    border-radius: 4px;
    cursor: pointer;
  }
  /* An unsaved tab shows its dot until you reach for the ✕. */
  .tab.dirty .tab-x :global(svg) {
    opacity: 0;
  }
  .tab.dirty:hover .tab-x :global(svg) {
    opacity: 1;
  }
  .tab.dirty:hover .tab-x .dot {
    opacity: 0;
  }
  .tab-x:hover {
    background: var(--surface-4);
    color: var(--danger);
  }
  .tabs-sp {
    flex: 1;
    min-width: 8px;
  }
  .run-toggle {
    display: flex;
    align-items: center;
    gap: 5px;
    align-self: center;
    flex-shrink: 0;
    position: sticky;
    right: 0;
    border: 1px solid var(--border-strong);
    background: var(--surface-3);
    color: var(--text-muted);
    font-size: 11.5px;
    font-weight: 700;
    padding: 3px 8px;
    border-radius: 6px;
    cursor: pointer;
  }
  .run-toggle:hover {
    background: var(--surface-4);
    color: var(--text);
  }
  .run-toggle.on {
    background: var(--accent-soft);
    color: var(--accent-bright);
    border-color: var(--accent);
  }
  .stack {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .run {
    flex-shrink: 0;
    min-height: 0;
    border-top: 1px solid var(--border);
  }
</style>
