<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import { tick, untrack } from "svelte";
  import { app } from "$lib/store/app.svelte";
  import Icon from "./Icon.svelte";
  import FileTree from "./FileTree.svelte";
  import CodeEditor from "./CodeEditor.svelte";
  import DiffView from "./DiffView.svelte";
  import RunPanel from "./RunPanel.svelte";
  import SearchPalette from "./SearchPalette.svelte";
  import {
    gitStatus,
    gitDiffFile,
    gitDiffAll,
    gitStageFile,
    isGitRepo,
    resolveTestCommand,
    invalidateSearchIndex,
    warmSearchIndex,
    changeBadge,
    baseName,
    type FileChange,
    type RepoStatus,
    type Script,
  } from "$lib/code/api";
  import type { TestTarget } from "$lib/code/tests";

  const ws = $derived(app.activeWorkspace);
  const root = $derived(ws?.path ?? "");

  /** Editor tabs vs. the diff of a reviewed change — what the centre pane shows. */
  let mode = $state<"edit" | "diff">("edit");

  // ---------- file tree ----------
  /** Expanded directories, shared by every level of the tree (see FileTree). */
  const expanded = new SvelteSet<string>();
  /** Bumped to make the tree re-read every mounted level. */
  let treeToken = $state(0);

  // ---------- review ----------
  let status = $state<RepoStatus | null>(null);
  let statusError = $state<string | null>(null);
  let notARepo = $state(false);
  let selectedChange = $state<FileChange | null>(null);
  /** True while the "everything at once" diff is selected instead of one file. */
  let wholeDiff = $state(false);
  let diffText = $state("");
  let diffLoading = $state(false);
  let diffError = $state<string | null>(null);

  const changedPaths = $derived(
    new Set((status?.changes ?? []).map((c) => c.absPath).filter(Boolean)),
  );

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
    mode = "edit";
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
  async function refreshStatus() {
    if (!root) return;
    try {
      if (!(await isGitRepo(root))) {
        notARepo = true;
        status = null;
        return;
      }
      notARepo = false;
      status = await gitStatus(root);
      statusError = null;
      // A file that stopped being changed (committed, reverted) should not keep an
      // open diff on screen claiming otherwise.
      if (selectedChange && !status.changes.some((c) => c.path === selectedChange!.path)) {
        selectedChange = null;
        if (!wholeDiff) diffText = "";
      }
    } catch (e) {
      statusError = String(e);
      status = null;
    }
  }

  async function showDiff(change: FileChange) {
    if (!root) return;
    selectedChange = change;
    wholeDiff = false;
    mode = "diff";
    diffLoading = true;
    diffError = null;
    try {
      // Prefer the unstaged diff; a fully-staged file has none, so fall back to the
      // index diff rather than showing the user an empty panel.
      let text = await gitDiffFile(root, change.path, false, change.untracked);
      if (!text.trim() && change.staged) {
        text = await gitDiffFile(root, change.path, true, false);
      }
      diffText = text;
    } catch (e) {
      diffError = String(e);
      diffText = "";
    } finally {
      diffLoading = false;
    }
  }

  async function showAllDiff() {
    if (!root) return;
    wholeDiff = true;
    selectedChange = null;
    mode = "diff";
    diffLoading = true;
    diffError = null;
    try {
      const [unstaged, staged] = await Promise.all([
        gitDiffAll(root, false),
        gitDiffAll(root, true),
      ]);
      diffText = [staged, unstaged].filter((s) => s.trim()).join("\n");
    } catch (e) {
      diffError = String(e);
      diffText = "";
    } finally {
      diffLoading = false;
    }
  }

  async function toggleStage(change: FileChange, e: MouseEvent) {
    e.stopPropagation();
    if (!root) return;
    try {
      await gitStageFile(root, change.path, !change.staged);
      await refreshStatus();
    } catch (err) {
      statusError = String(err);
    }
  }

  /**
   * Changes grouped by the directory they live in.
   *
   * Each row used to carry its own dimmed path, which never worked: the column shared its
   * width with the filename, so every row clipped at a different point
   * (`src/lib/co…`, `src/lib/comp…`, `src/lib/compo…`) and an untracked DIRECTORY — which
   * git reports with a trailing slash — printed its own name twice. One heading per
   * folder states the path once, in full, and leaves the rows to be filenames.
   */
  const changeGroups = $derived.by(() => {
    const groups = new Map<string, FileChange[]>();
    for (const c of status?.changes ?? []) {
      // A trailing slash means git collapsed a whole untracked directory into one entry;
      // it belongs to its PARENT, with the directory itself as the "name".
      const p = c.path.endsWith("/") ? c.path.slice(0, -1) : c.path;
      const i = p.lastIndexOf("/");
      const dir = i < 0 ? "" : p.slice(0, i);
      const list = groups.get(dir);
      if (list) list.push(c);
      else groups.set(dir, [c]);
    }
    // Root-level files first, then folders alphabetically — the order a repo is read in.
    return [...groups.entries()].sort(([a], [b]) =>
      a === "" ? -1 : b === "" ? 1 : a.localeCompare(b),
    );
  });

  const reviewTotal = $derived(status?.changes.length ?? 0);
  const reviewViewed = $derived(
    ws ? app.codeViewedCount(ws.id, (status?.changes ?? []).map((c) => c.path)) : 0,
  );

  /** Filename of a change, keeping the trailing slash that marks a whole directory. */
  function changeName(c: FileChange): string {
    const dir = c.path.endsWith("/");
    const p = dir ? c.path.slice(0, -1) : c.path;
    return baseName(p) + (dir ? "/" : "");
  }

  function refreshAll() {
    treeToken++;
    void refreshStatus();
    // The search index is otherwise trusted for a few seconds; the refresh button is the
    // user saying the tree changed, so a search right after it must see the change.
    if (root) void invalidateSearchIndex(root).catch(() => {});
  }

  // ---------- visibility ----------
  let pageEl = $state<HTMLDivElement | null>(null);
  const isShown = () => !!pageEl && pageEl.clientWidth > 0 && pageEl.clientHeight > 0;

  /**
   * The Code view stays mounted (hidden) so the run shell survives switching away, so
   * "the user is looking at it" has to be observed rather than assumed. Git status is
   * re-read on every show and then polled while visible — an agent committing or editing
   * in the background is the normal case here.
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
        void refreshStatus();
        // Fire-and-forget: a failure here only means the first search pays for the walk.
        void warmSearchIndex(r).catch(() => {});
        timer = setInterval(() => void refreshStatus(), 5000);
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

  function setSideTab(tab: "files" | "changes") {
    app.codeSideTab = tab;
    app.persist();
    if (tab === "changes") void refreshStatus();
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
        <button class:on={app.codeSideTab === "files"} onclick={() => setSideTab("files")}>
          <Icon name="folder" size={13} /> Files
        </button>
        <button class:on={app.codeSideTab === "changes"} onclick={() => setSideTab("changes")}>
          <Icon name="diff" size={13} /> Changes
          {#if status?.changes.length}<span class="count">{status.changes.length}</span>{/if}
        </button>
        <button
          class="rail-search"
          title="Search files, symbols and text (⌘P)"
          aria-label="Search workspace"
          onclick={() => (searchMode = "file")}><Icon name="search" size={13} /></button
        >
      </div>

      {#if app.codeSideTab === "files"}
        <div class="rail-head">
          <span class="ws-name" title={root}>{ws.name}</span>
          <button
            class="mini"
            class:on={app.codeShowHidden}
            title="Show hidden files"
            onclick={toggleHidden}><Icon name="eye" size={13} /></button
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
      {:else}
        <div class="rail-head">
          {#if status?.branch}
            <span class="branch" title="Current branch"
              ><Icon name="branch" size={12} />{status.branch}</span
            >
            {#if status.ahead}<span class="track">↑{status.ahead}</span>{/if}
            {#if status.behind}<span class="track">↓{status.behind}</span>{/if}
          {:else}
            <span class="ws-name">{ws.name}</span>
          {/if}
          {#if reviewTotal > 0}
            <span
              class="progress"
              class:done={reviewViewed === reviewTotal}
              title="Files marked as reviewed"
            >
              {reviewViewed}/{reviewTotal}
            </span>
            {#if reviewViewed > 0}
              <button
                class="mini"
                title="Clear all review ticks"
                onclick={() => app.clearCodeViewed(ws.id)}><Icon name="close" size={12} /></button
              >
            {/if}
          {/if}
          <button class="mini" title="Refresh" onclick={refreshAll}
            ><Icon name="restore" size={13} /></button
          >
        </div>
        <div class="rail-body">
          {#if notARepo}
            <div class="rail-msg">Not a git repository.</div>
          {:else if statusError}
            <div class="rail-msg err">{statusError}</div>
          {:else if !status}
            <div class="rail-msg">Loading…</div>
          {:else if !status.changes.length}
            <div class="rail-msg">No uncommitted changes.</div>
          {:else}
            <button class="change all" class:sel={wholeDiff} onclick={showAllDiff}>
              <Icon name="diff" size={13} />
              <span class="c-name">Review all changes</span>
              <span class="c-dir">{status.changes.length} files</span>
            </button>
            {#each changeGroups as [dir, list] (dir)}
              <div class="group-head" title={dir || "Repository root"}>
                {dir || "/"}
              </div>
              {#each list as c (c.path)}
                {@const badge = changeBadge(c)}
                {@const reviewed = app.hasCodeViewedEntry(ws.id, c.path)}
                <button
                  class="change"
                  class:sel={selectedChange?.path === c.path}
                  class:reviewed
                  onclick={() => showDiff(c)}
                  title={reviewed ? `${c.path} — reviewed` : c.path}
                >
                  <span class="code" style:color={badge.color} title={badge.label}
                    >{badge.code}</span
                  >
                  <span class="c-name">{changeName(c)}</span>
                  {#if reviewed}<Icon name="check" size={12} class="tick" />{/if}
                  <span
                    class="stage"
                    class:on={c.staged}
                    title={c.staged ? "Unstage" : "Stage"}
                    role="button"
                    tabindex="0"
                    onclick={(e) => toggleStage(c, e)}
                    onkeydown={(e) => {
                      if (e.key === "Enter") toggleStage(c, e as unknown as MouseEvent);
                    }}><Icon name={c.staged ? "check" : "plus"} size={12} /></span
                  >
                </button>
              {/each}
            {/each}
          {/if}
        </div>
      {/if}
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
          <div class="tab" class:on={mode === "edit" && p === activePath}>
            <button
              class="tab-main"
              onclick={() => {
                mode = "edit";
                app.setActiveCodeFile(ws.id, p);
              }}
              title={p}
            >
              {#if dirtyPaths.has(p)}<span class="dot"></span>{/if}
              <span class="tab-name">{baseName(p)}</span>
            </button>
            <button class="tab-x" title="Close" onclick={() => closeTab(p)}
              ><Icon name="close" size={11} /></button
            >
          </div>
        {/each}
        {#if diffText || diffLoading || selectedChange || wholeDiff}
          <div class="tab" class:on={mode === "diff"}>
            <button class="tab-main" onclick={() => (mode = "diff")}>
              <Icon name="diff" size={12} />
              <span class="tab-name"
                >{wholeDiff ? "All changes" : selectedChange ? baseName(selectedChange.path) : "Diff"}</span
              >
            </button>
            <button
              class="tab-x"
              title="Close"
              onclick={() => {
                diffText = "";
                selectedChange = null;
                wholeDiff = false;
                mode = "edit";
              }}><Icon name="close" size={11} /></button
            >
          </div>
        {/if}
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
        <div class="pane" style:display={mode === "diff" ? "flex" : "none"}>
          <DiffView
            diff={diffText}
            loading={diffLoading}
            error={diffError}
            title={wholeDiff ? "All uncommitted changes" : (selectedChange?.path ?? "")}
            split={app.codeDiffSplit}
            onToggleSplit={() => app.toggleCodeDiffSplit()}
            isViewed={(path, sig) => app.isCodeViewed(ws.id, path, sig)}
            onViewed={(path, sig, v) => app.setCodeViewed(ws.id, path, sig, v)}
            onSignatures={(sigs) => app.syncCodeViewed(ws.id, sigs)}
            onEdit={selectedChange?.absPath ? () => openFile(selectedChange!.absPath) : null}
          />
        </div>
        <div class="pane" style:display={mode === "edit" ? "flex" : "none"}>
          <CodeEditor
            bind:this={editor}
            {root}
            path={activePath}
            {onDirty}
            onRunTest={runTest}
            {revealAt}
          />
        </div>
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
    gap: 2px;
    height: 32px;
    padding: 0 6px;
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
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
  .rail-tabs button.on {
    background: var(--accent-soft);
    color: var(--accent-bright);
    box-shadow: inset 0 0 0 1px var(--accent-softer);
  }
  .count {
    min-width: 15px;
    height: 15px;
    padding: 0 4px;
    display: grid;
    place-items: center;
    border-radius: 8px;
    background: var(--surface-4);
    color: var(--text-secondary);
    font-size: 9.5px;
    font-weight: 800;
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
  .branch {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 4px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--accent-bright);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .track {
    font-size: 10px;
    font-weight: 700;
    color: var(--text-muted);
  }
  .progress {
    flex-shrink: 0;
    font-size: 9.5px;
    font-weight: 800;
    color: var(--text-muted);
    background: var(--surface-4);
    border-radius: 8px;
    padding: 1px 6px;
  }
  .progress.done {
    color: var(--ok);
    background: rgba(63, 185, 80, 0.14);
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
  .rail-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 4px;
  }
  .rail-msg {
    padding: 14px 10px;
    font-size: 12px;
    color: var(--text-faint);
    text-align: center;
  }
  .rail-msg.err {
    color: var(--danger);
    text-align: left;
  }
  .change {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    height: 24px;
    border: none;
    background: transparent;
    text-align: left;
    padding: 0 5px 0 7px;
    border-radius: 5px;
    cursor: pointer;
    font-size: 12.5px;
    color: var(--text-secondary);
  }
  .change:hover {
    background: var(--surface-3);
    color: var(--text);
  }
  /* Reviewed files step back so the unread ones stand out — same idea as the diff. */
  .change.reviewed {
    color: var(--text-faint);
  }
  .change.reviewed :global(.tick) {
    color: var(--ok);
    flex-shrink: 0;
  }
  .change.sel {
    background: var(--accent-soft);
    color: var(--accent-bright);
    box-shadow: inset 0 0 0 1px var(--accent-softer);
  }
  .change.all {
    font-weight: 700;
    color: var(--text);
    margin-bottom: 4px;
    border-bottom: 1px solid var(--border-muted);
    border-radius: 5px 5px 0 0;
    padding-bottom: 0;
    height: 27px;
  }
  .change .code {
    display: grid;
    place-items: center;
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 800;
    width: 15px;
    height: 15px;
    border-radius: 3px;
    background: color-mix(in srgb, currentColor 14%, transparent);
    flex-shrink: 0;
  }
  .c-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* No `direction: rtl` ellipsis trick here — that is what mangled `.worktrees` into
     `worktrees.` on the rows this heading replaced. */
  .group-head {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-ghost);
    padding: 9px 8px 3px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .group-head:first-child {
    padding-top: 3px;
  }
  .c-dir {
    flex: 1;
    min-width: 0;
    font-size: 10.5px;
    color: var(--text-ghost);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: right;
  }
  .stage {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    border-radius: 4px;
    color: var(--text-ghost);
    opacity: 0;
    transition: opacity var(--t-fast);
  }
  /* A row of 18 identical "+" glyphs is noise; reveal the control on approach. An
     already-staged file keeps its tick, because that one is state, not an affordance. */
  .change:hover .stage,
  .stage.on {
    opacity: 1;
  }
  .stage:hover {
    background: var(--surface-4);
    color: var(--text);
  }
  .stage.on {
    color: var(--ok);
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
  .tab {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    max-width: 190px;
    border-radius: 6px 6px 0 0;
    color: var(--text-muted);
  }
  .tab:hover {
    background: var(--surface-3);
    color: var(--text);
  }
  .tab.on {
    background: var(--term-bg);
    color: var(--accent-bright);
    box-shadow: inset 0 2px 0 var(--accent);
  }
  /*
    The diff tab reads as a diff through its icon alone. It was briefly given its own
    amber accent, which just put two competing highlight colours side by side in one
    tab strip — the distinction was never worth the clash.
  */
  .tab-main {
    display: flex;
    align-items: center;
    gap: 5px;
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
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--warn);
    flex-shrink: 0;
  }
  .tab-x {
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
    position: relative;
    display: flex;
  }
  /* Both panes stay mounted so the editor's buffers and the diff survive a switch. */
  .pane {
    position: absolute;
    inset: 0;
    flex-direction: column;
  }
  .run {
    flex-shrink: 0;
    min-height: 0;
    border-top: 1px solid var(--border);
  }
</style>
