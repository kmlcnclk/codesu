<script lang="ts">
  import { untrack } from "svelte";
  import { app, STATE_META, type ReviewComment } from "$lib/store/app.svelte";
  import { insertAtPrompt } from "$lib/terminal/attachments.svelte";
  import Icon from "./Icon.svelte";
  import DiffView from "./DiffView.svelte";
  import {
    readTextFile,
    gitStatus,
    gitDiffFile,
    gitDiffAll,
    gitStageFile,
    isGitRepo,
    changeBadge,
    baseName,
    type FileChange,
    type RepoStatus,
  } from "$lib/code/api";

  let {
    onClose,
    onEditFile,
    onSent,
  }: {
    /** Leave review and go back where the user came from (the session). */
    onClose: () => void;
    /** Open a file for editing in the Code view — review itself never edits. */
    onEditFile: (absPath: string) => void;
    /** Comments were typed at this agent's prompt — go and look at it. */
    onSent: (agentId: string) => void;
  } = $props();

  const ws = $derived(app.activeWorkspace);
  const root = $derived(ws?.path ?? "");

  // ---------- git status ----------
  let status = $state<RepoStatus | null>(null);
  let statusError = $state<string | null>(null);
  let notARepo = $state(false);
  let selectedChange = $state<FileChange | null>(null);
  /** True while the "everything at once" diff is selected instead of one file. */
  let wholeDiff = $state(false);
  let diffText = $state("");
  let diffLoading = $state(false);
  let diffError = $state<string | null>(null);

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

  /**
   * What Review opens on: everything at once.
   *
   * Landing on an empty pane asked the user to pick a file before they had been told
   * what changed — the whole diff IS the review, and picking one file out of it is the
   * narrowing step, not the starting point. Only ever applied when nothing has been
   * chosen yet, so it can never pull the rug from under a selection.
   */
  function showDefaultDiff() {
    if (selectedChange || wholeDiff || diffLoading) return;
    if (!status?.changes.length) return;
    void showAllDiff();
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

  // ---------- changed-files list ----------
  /** Substring filter over the changed paths ("Filter files…"). */
  let changeFilter = $state("");
  /** Show only files that still need reviewing. */
  let unviewedOnly = $state(false);

  const visibleChanges = $derived.by(() => {
    const q = changeFilter.trim().toLowerCase();
    return (status?.changes ?? []).filter((c) => {
      if (q && !c.path.toLowerCase().includes(q)) return false;
      if (unviewedOnly && ws && app.hasCodeViewedEntry(ws.id, c.path)) return false;
      return true;
    });
  });

  /**
   * Changes grouped by the directory they live in.
   *
   * Not a nested tree: a deep path (`apps/x/src/test/kotlin/com/…`) indents so far that
   * every filename clips to `Nam…`, which is the one thing the list exists to show. One
   * heading per folder states the path once, in full, and leaves the rows to be
   * filenames.
   */
  const changeGroups = $derived.by(() => {
    const groups = new Map<string, FileChange[]>();
    for (const c of visibleChanges) {
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

  // ---------- comments ----------
  /** Every note written on this workspace, and the ones on the diff currently shown. */
  const allComments = $derived(ws ? app.reviewCommentsFor(ws.id) : []);
  const shownComments = $derived(
    wholeDiff || !selectedChange
      ? allComments
      : allComments.filter((c) => c.path === selectedChange!.path),
  );

  /** Which agent the batch goes to; null means "the workspace's active agent". */
  let target = $state<string | null>(null);
  /** What happened to the last send, shown next to the button. */
  let sendNote = $state<string | null>(null);

  const agents = $derived(
    ws ? app.agents.filter((a) => a.workspaceId === ws.id && !a.archived) : [],
  );
  const targetAgent = $derived(
    agents.find((a) => a.id === target) ??
      agents.find((a) => a.id === app.activeAgent?.id) ??
      agents[0] ??
      null,
  );

  function addComment(input: {
    path: string;
    line: number | null;
    side: "old" | "new";
    code: string;
    kind: "add" | "del" | "ctx";
    body: string;
  }) {
    if (!ws) return;
    app.addReviewComment({ workspaceId: ws.id, ...input });
  }

  /** How a commented line reads in the message: what it is in the diff. */
  const KIND_WORD = {
    add: "added line",
    del: "removed line",
    ctx: "unchanged line",
  } as const;

  /**
   * The batch, written so the agent can act on it without asking a follow-up question.
   *
   * Every note carries the four things needed to act: which file, which line, what that
   * line IS in the diff (added / removed / context), and the line itself — an agent told
   * only "line 28" would have to go and count, and by then the file may have moved on.
   * The header says what the notes are about and what to do with them, because a bare
   * list of remarks pasted into a prompt reads as trivia, not as a request.
   *
   * Plain prose rather than JSON: it goes into a prompt a human reads and may edit
   * before pressing Enter.
   */
  function composeMessage(list: ReviewComment[]): string {
    const files = new Set(list.map((c) => c.path));
    const ordered = [...list].sort(
      (a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0),
    );
    const where = status?.branch ? ` on branch ${status.branch}` : "";
    const out: string[] = [
      `Code review of the uncommitted changes${where} in ${ws?.name ?? "this workspace"} (${root}).`,
      `${list.length} comment${list.length === 1 ? "" : "s"} across ${files.size} file${files.size === 1 ? "" : "s"}.`,
      "",
      "Please work through each note below: fix it in the working tree, or tell me why the",
      "note is wrong instead of changing anything. Don't commit.",
      "",
    ];
    ordered.forEach((c, i) => {
      const at = c.line != null ? `${c.path}:${c.line}` : c.path;
      const kind = c.line != null ? ` (${KIND_WORD[c.kind ?? "ctx"]})` : " (whole file)";
      out.push(`[${i + 1}] ${at}${kind}`);
      const code = c.code.trim();
      // A minified or very long line would bury the note it is meant to locate.
      if (code) out.push(`    code: ${code.length > 240 ? code.slice(0, 240) + "…" : code}`);
      const body = c.body.trim().split("\n");
      out.push(`    note: ${body[0] ?? ""}`);
      for (const extra of body.slice(1)) out.push(`          ${extra}`);
      out.push("");
    });
    return out.join("\n");
  }

  /**
   * Type the batch at the agent's prompt — and stop there.
   *
   * Nothing is submitted: the reader lands in the session, reads what is about to be
   * sent, edits it if they want, and presses Enter themselves.
   *
   * A sleeping agent is woken here. That is the one place it is right to do so without
   * a Resume click: pressing Send IS the explicit gesture, and being told to go and
   * start the agent by hand — with the notes still stuck in this panel — was the whole
   * complaint. The text waits in `insertAtPrompt`'s queue until the prompt exists.
   */
  function sendToClaude() {
    if (!ws) return;
    const list = allComments;
    const agent = targetAgent;
    if (!list.length || !agent) return;
    const where = insertAtPrompt(agent.id, composeMessage(list));
    if (where === "queued") app.launchAgent(agent.id);
    sendNote = null;
    onSent(agent.id);
  }

  /** Filename of a change, keeping the trailing slash that marks a whole directory. */
  function changeName(c: FileChange): string {
    const dir = c.path.endsWith("/");
    const p = dir ? c.path.slice(0, -1) : c.path;
    return baseName(p) + (dir ? "/" : "");
  }

  /**
   * Current text of a repo-relative path, for the diff's "expand context" buttons.
   *
   * A diff carries only its hunks, so the unchanged lines around them have to be read
   * back off disk. Anything the reader refuses (too large, binary, gone) comes back as
   * null and simply leaves the buttons inert.
   */
  async function loadFile(rel: string): Promise<string[] | null> {
    if (!root) return null;
    const file = await readTextFile(root, `${root}/${rel}`);
    if (file.refused) return null;
    return file.content.split("\n");
  }

  // ---------- visibility ----------
  let pageEl = $state<HTMLDivElement | null>(null);
  const isShown = () => !!pageEl && pageEl.clientWidth > 0 && pageEl.clientHeight > 0;

  /**
   * The page stays mounted (hidden) so a half-read review survives a trip back to the
   * session, so "the user is looking at it" has to be observed rather than assumed.
   * Status is re-read on every show and polled while visible — an agent committing or
   * editing in the background is the normal case here.
   */
  $effect(() => {
    const el = pageEl;
    const r = root;
    if (!el || !r) return;
    // Another workspace is another review: drop what was on screen so the new one opens
    // on its own "all changes" rather than on the last repo's file.
    untrack(() => {
      selectedChange = null;
      wholeDiff = false;
      diffText = "";
      diffError = null;
    });
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
        void refreshStatus().then(showDefaultDiff);
        // Also on the poll: a repo that was clean when Review opened still gets its
        // default the moment an agent's first change lands.
        timer = setInterval(() => void refreshStatus().then(showDefaultDiff), 5000);
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

  // ---------- resizing ----------
  function dragRail(e: PointerEvent) {
    const startX = e.clientX;
    const startW = app.reviewRailWidth;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      app.reviewRailWidth = Math.max(180, Math.min(620, startW + ev.clientX - startX));
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      app.persist();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  }
</script>

<div class="review-page" bind:this={pageEl}>
  {#if !ws}
    <div class="no-ws">
      <Icon name="diff" size={26} />
      <p>Open a workspace to review its changes.</p>
    </div>
  {:else}
    <aside class="rail" style:width="{app.reviewRailWidth}px">
      <div class="rail-tabs">
        <span class="rail-title"><Icon name="diff" size={13} /> Review</span>
        {#if reviewTotal}<span class="count">{reviewTotal}</span>{/if}
        <button class="mini" title="Refresh" onclick={() => void refreshStatus()}
          ><Icon name="restore" size={13} /></button
        >
        <button class="mini" title="Back to session (Esc)" onclick={onClose}
          ><Icon name="close" size={13} /></button
        >
      </div>

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
            <button class="mini" title="Clear all review ticks" onclick={() => app.clearCodeViewed(ws.id)}
              ><Icon name="restore" size={12} /></button
            >
          {/if}
        {/if}
      </div>

      {#if status?.changes.length}
        <!-- Filter + "only what is left to read", the two things that make a 200-file
             review navigable at all. -->
        <div class="rail-filter">
          <label class="filter-field">
            <Icon name="search" size={12} />
            <input placeholder="Filter files…" bind:value={changeFilter} spellcheck="false" />
            {#if changeFilter}
              <button class="mini" title="Clear filter" onclick={() => (changeFilter = "")}
                ><Icon name="close" size={11} /></button
              >
            {/if}
          </label>
          <button
            class="mini box"
            class:on={unviewedOnly}
            title={unviewedOnly ? "Showing unviewed files only" : "Show unviewed files only"}
            onclick={() => (unviewedOnly = !unviewedOnly)}><Icon name="filter" size={13} /></button
          >
        </div>
      {/if}

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
          {#if !visibleChanges.length}
            <div class="rail-msg">No file matches.</div>
          {:else}
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
                  <span class="code" style:color={badge.color} title={badge.label}>{badge.code}</span>
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
        {/if}
      </div>

      <!--
        The batch, and where it is going. Comments are worth writing only if they can be
        handed over in one move, so the count and the send live together at the foot of
        the rail rather than behind a menu.
      -->
      {#if allComments.length}
        <div class="send">
          <div class="send-top">
            <span class="send-count">{allComments.length}</span>
            <span class="send-label">comment{allComments.length === 1 ? "" : "s"} ready</span>
            <button
              class="mini"
              title="Delete every comment"
              onclick={() => app.clearReviewComments(ws.id)}><Icon name="trash" size={12} /></button
            >
          </div>
          {#if agents.length > 1}
            <label class="send-pick">
              <span class="dot" style:background={STATE_META[targetAgent?.state ?? "idle"].color}
              ></span>
              <select
                value={targetAgent?.id ?? ""}
                onchange={(e) => (target = e.currentTarget.value)}
                title="Which agent gets these notes"
              >
                {#each agents as a (a.id)}
                  <option value={a.id}>{a.name}</option>
                {/each}
              </select>
              <Icon name="chevronDown" size={12} />
            </label>
          {/if}
          <button class="send-btn" onclick={sendToClaude} disabled={!targetAgent}>
            Send to {targetAgent?.name ?? "Claude"}
            <Icon name="arrowRight" size={13} />
          </button>
          <p class="send-hint">
            {#if sendNote}
              {sendNote}
            {:else if targetAgent && !app.launchedAgentIds.has(targetAgent.id)}
              Wakes {targetAgent.name} and types them at its prompt.
            {:else}
              Typed at the prompt — you press Enter.
            {/if}
          </p>
        </div>
      {/if}
    </aside>

    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="gutter-v" role="separator" aria-orientation="vertical" onpointerdown={dragRail}></div>

    <div class="center">
      {#if selectedChange || wholeDiff || diffLoading}
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
          onEdit={selectedChange?.absPath ? () => onEditFile(selectedChange!.absPath) : null}
          onOpenPath={(p) => onEditFile(`${root}/${p}`)}
          comments={shownComments}
          onAddComment={addComment}
          onUpdateComment={(id, body) => ws && app.updateReviewComment(ws.id, id, body)}
          onDeleteComment={(id) => ws && app.removeReviewComment(ws.id, id)}
          {loadFile}
        />
      {:else}
        <div class="empty">
          <Icon name="diff" size={26} />
          <p>Pick a file on the left, or read everything at once with “Review all changes”.</p>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .review-page {
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: flex;
    background: var(--bg);
  }
  .no-ws,
  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: var(--text-faint);
    font-size: 13px;
    text-align: center;
    padding: 0 30px;
  }
  .no-ws p,
  .empty p {
    margin: 0;
    max-width: 420px;
  }

  /* ---- left rail ---- */
  .rail {
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: var(--surface-1);
    border-right: 1px solid var(--border);
  }
  /* Height matches the centre header so the two share one horizontal rule. */
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
  .rail-filter {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 6px 6px 4px;
    flex-shrink: 0;
  }
  .filter-field {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    height: 26px;
    padding: 0 6px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-faint);
  }
  .filter-field:focus-within {
    border-color: var(--accent);
  }
  .filter-field input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    outline: none;
    color: var(--text);
    font-family: var(--font-sans);
    font-size: 12px;
  }
  .mini.box {
    border: 1px solid var(--border);
    background: var(--surface-2);
    border-radius: 6px;
    width: 26px;
    height: 26px;
    flex-shrink: 0;
  }
  .mini.box.on {
    border-color: var(--accent);
    background: var(--accent-softer);
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

  /* ---- send bar ---- */
  .send {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding: 9px 9px 8px;
    border-top: 1px solid var(--border);
    background: var(--surface-2);
  }
  .send-top {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .send-count {
    display: grid;
    place-items: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 9px;
    background: var(--accent);
    color: #fff;
    font-size: 10.5px;
    font-weight: 800;
  }
  .send-label {
    flex: 1;
    font-size: 11.5px;
    color: var(--text-secondary);
  }
  /* The picker is a row you read (dot + name), not a bare OS dropdown. */
  .send-pick {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 28px;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--surface-1);
    color: var(--text-faint);
    cursor: pointer;
  }
  .send-pick:hover {
    border-color: var(--border-strong);
  }
  .send-pick .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .send-pick select {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    color: var(--text);
    font-family: var(--font-sans);
    font-size: 12px;
    outline: none;
    cursor: pointer;
    appearance: none;
  }
  .send-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    height: 32px;
    border: none;
    border-radius: 7px;
    background: var(--accent);
    color: #fff;
    font-family: var(--font-sans);
    font-size: 12.5px;
    font-weight: 700;
    cursor: pointer;
    transition: background var(--t-fast);
  }
  .send-btn:hover:not(:disabled) {
    background: var(--accent-bright, var(--accent));
  }
  .send-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .send-hint {
    margin: 0;
    font-size: 10.5px;
    line-height: 1.35;
    color: var(--text-faint);
    text-align: center;
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

  /* ---- centre ---- */
  .center {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
</style>
