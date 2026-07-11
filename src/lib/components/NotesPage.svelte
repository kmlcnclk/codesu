<script lang="ts">
  import { onMount } from "svelte";
  import { app, TASK_META, type TaskItem, type Workspace } from "$lib/store/app.svelte";
  import Icon from "./Icon.svelte";
  import MarkdownEditor from "./MarkdownEditor.svelte";
  import NewWorkspaceDialog from "./NewWorkspaceDialog.svelte";
  import { stripMarkdown } from "$lib/markdown";

  let { onOpenAgent }: { onOpenAgent: (agentId: string) => void } = $props();

  function initialNoteId(): string | null {
    // Restore the last note only if it belongs to the tab we're opening in (active vs
    // archive) — otherwise an archived note would open inside the active Notes list.
    const list = app.getPageView("notes") === "archived" ? app.ideaArchive : app.ideaList;
    const last = app.lastNoteId;
    if (last && list.some((t) => t.id === last)) return last;
    return list[0]?.id ?? null;
  }
  let selectedId = $state<string | null>(initialNoteId());
  // Remember the open note so it's restored next time the Notes page is entered.
  $effect(() => {
    app.setLastNote(selectedId);
  });
  let focusId = $state<string | null>(null);
  let query = $state("");
  let titleEl = $state<HTMLInputElement>();
  let selectedText = $state("");

  let listTab = $derived.by(() => (app.getPageView("notes") as "active" | "archived") || "active");

  // No longer needs event listener since keyboard handler calls app.setPageView directly

  // Cache agent lookup map for faster searches
  const agentMap = $derived.by(() => {
    const map = new Map();
    for (const a of app.agents) {
      map.set(a.id, a);
    }
    return map;
  });

  // Selection must match the visible tab — an archived note never shows in the active
  // list and vice-versa.
  const selected = $derived(
    selectedId
      ? (app.tasks.find(
          (t) =>
            t.id === selectedId &&
            t.status === "idea" &&
            (listTab === "archived" ? t.archived : !t.archived),
        ) ?? null)
      : null,
  );
  const linkedAgents = $derived(selected ? selected.agentIds.map(id => agentMap.get(id)).filter((a): a is typeof a & {} => a !== undefined) : []);
  const base = $derived(listTab === "archived" ? app.ideaArchive : app.ideaList);
  // If the current selection isn't valid for the visible tab, fall back to its first note.
  $effect(() => {
    if (selectedId && !selected) selectedId = base[0]?.id ?? null;
  });
  const filtered = $derived.by(() => {
    if (!query.trim()) return base;
    const q = query.toLowerCase();
    return base.filter((t) => t.title.toLowerCase().includes(q) || t.details.toLowerCase().includes(q));
  });
  const wordCount = $derived(
    selected?.details.trim() ? selected.details.trim().split(/\s+/).length : 0,
  );

  // Focus the title of a freshly-created note exactly once.
  $effect(() => {
    if (focusId && selected?.id === focusId) {
      titleEl?.focus();
      focusId = null;
    }
  });

  function displayTitle(t: TaskItem): string {
    if (t.title.trim()) return t.title.trim();
    const line = t.details.split("\n").map((l) => l.trim()).find(Boolean);
    return line || "Untitled idea";
  }
  function snippet(t: TaskItem): string {
    const body = t.title.trim() ? t.details : t.details.split("\n").slice(1).join(" ");
    return stripMarkdown(body);
  }
  function fmtDate(ts: number): string {
    try {
      return new Date(ts).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  }

  function newIdea() {
    const t = app.addTask({ title: "", status: "idea" });
    query = "";
    selectedId = t.id;
    focusId = t.id;
  }
  function edit(field: "title" | "details", value: string) {
    if (!selected) return;
    app.updateTask(selected.id, { [field]: value });
  }
  function remove(id: string) {
    const remaining = filtered.filter((t) => t.id !== id);
    app.removeTask(id);
    if (selectedId === id) selectedId = remaining[0]?.id ?? null;
  }
  // Creating an agent opens the workspace picker; `useSelected` uses only the
  // highlighted text (spun off as its own task) instead of the whole note.
  let agentDialog = $state<{ useSelected: boolean } | null>(null);

  function startCreateAgent(useSelected: boolean) {
    if (!selected || selected.status !== "idea") return;
    if (useSelected && !selectedText.trim()) return;
    agentDialog = { useSelected };
  }

  function onAgentWorkspace(ws: Workspace) {
    const cfg = agentDialog;
    agentDialog = null;
    if (!selected || !cfg) return;
    // Fork a board task from the note (the note stays in Notes); optionally scope it
    // to just the highlighted text.
    const overrides =
      cfg.useSelected && selectedText.trim()
        ? { title: selected.title || "Agent task", details: selectedText }
        : undefined;
    const agent = app.createAgentForNote(selected.id, ws.id, overrides);
    if (agent) onOpenAgent(agent.id);
  }

  function openExistingAgent() {
    const a = linkedAgents[0];
    if (a) onOpenAgent(a.id);
  }

  function getSelectedText(text: string) {
    selectedText = text;
  }
  function archive(id: string) {
    const remaining = app.ideaList.filter((t) => t.id !== id);
    app.archiveTask(id);
    if (selectedId === id) selectedId = remaining[0]?.id ?? null;
  }
  function unarchive(id: string) {
    app.unarchiveTask(id);
    app.setPageView("notes", "active");
    selectedId = id;
  }

  /** Drag the note-list pane's right edge to resize it. */
  function listPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = app.notesListWidth;
    const move = (ev: PointerEvent) => app.setNotesListWidth(startW + (ev.clientX - startX));
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
      } catch {
        /* capture may already be gone */
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
</script>

<div class="page">
  <div class="split">
    <!-- note list -->
    <aside class="list-pane" style="width:{app.notesListWidth}px">
      <header class="list-head">
        <h1>Notes</h1>
        <button class="new-note" title="New note" aria-label="New note" onclick={newIdea}>
          <Icon name="plus" size={16} />
        </button>
      </header>

      {#if app.ideaArchive.length > 0}
        <div class="list-tabs">
          <button class="list-tab" class:on={listTab === "active"} onclick={() => app.setPageView("notes", "active")}>
            Notes <span class="lt-c">{app.ideaList.length}</span>
          </button>
          <button class="list-tab" class:on={listTab === "archived"} onclick={() => app.setPageView("notes", "archived")}>
            <Icon name="archive" size={12} /> Archive <span class="lt-c">{app.ideaArchive.length}</span>
          </button>
        </div>
      {/if}

      {#if base.length > 0}
        <div class="search">
          <input class="search-input" placeholder="Search notes…" bind:value={query} spellcheck="false" />
        </div>
      {/if}

      {#if base.length === 0}
        <div class="list-empty">{listTab === "archived" ? "No archived notes." : "No notes yet."}</div>
      {:else if filtered.length === 0}
        <div class="list-empty">No notes match &quot;{query}&quot;.</div>
      {:else}
        <ul class="list">
          {#each filtered as t (t.id)}
            {@const tasks = app.children(t)}
            <li>
              <div
                class="item"
                class:active={t.id === selectedId}
                role="button"
                tabindex="0"
                onclick={() => (selectedId = t.id)}
                onkeydown={(e) => (e.key === "Enter" || e.key === " ") && (selectedId = t.id)}
              >
                <div class="item-top">
                  <span class="item-title">{displayTitle(t)}</span>
                  {#if t.archived}
                    <span class="item-task" title="Archived"><Icon name="archive" size={12} /></span>
                  {:else if tasks.length > 0}
                    <span class="item-task" title="Has {tasks.length} agent{tasks.length === 1 ? '' : 's'}"><Icon name="agents" size={12} /> {tasks.length}</span>
                  {/if}
                </div>
                <span class="item-snip">{snippet(t) || "No additional text"}</span>
                <span class="item-date">{fmtDate(t.updatedAt)}</span>
                <button
                  class="item-del"
                  title="Delete idea"
                  aria-label="Delete idea"
                  onclick={(e) => {
                    e.stopPropagation();
                    remove(t.id);
                  }}
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </aside>

    <!-- Draggable divider: resizes the note-list pane. -->
    <div
      class="list-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize note list"
      title="Drag to resize"
      onpointerdown={listPointerDown}
      ondblclick={() => app.setNotesListWidth(296)}
    ></div>

    <!-- editor -->
    <section class="editor-pane">
      {#if selected}
        {@const s = selected}
        <div class="editor-bar">
          <span class="meta">Edited {fmtDate(s.updatedAt)}</span>
          {#if wordCount > 0}<span class="meta dim">· {wordCount} word{wordCount === 1 ? "" : "s"}</span>{/if}
          <span class="bar-spacer"></span>

          {#if s.archived}
            <span class="task-chip" style="--c:var(--text-muted)" title="Archived note">
              <span class="cd"></span>Archived
            </span>
          {/if}

          {#if linkedAgents.length > 0}
            <div class="task-chips">
              {#each linkedAgents as agent (agent?.id)}
                {#if agent}
                  <button class="task-chip-btn" style="--c:#6e8bff" onclick={() => onOpenAgent(agent.id)} title="Open agent">
                    <span class="cd"></span>{agent.name || "Agent"}
                  </button>
                {/if}
              {/each}
            </div>
          {/if}
          {#if !s.archived}
            <div class="button-group">
              {#if linkedAgents.length > 0}
                <button class="btn accent" onclick={openExistingAgent} title="Open this note's agent">
                  <Icon name="open" size={14} /> Open agent
                </button>
              {:else}
                <button class="btn accent" onclick={() => startCreateAgent(false)} title="Pick a workspace, then create an agent for this note">
                  <Icon name="sparkles" size={14} /> Create agent
                </button>
                {#if selectedText.trim()}
                  <button class="btn ghost" onclick={() => startCreateAgent(true)} title="Create an agent with the selected text only">
                    <Icon name="highlighter" size={14} /> Selected
                  </button>
                {/if}
              {/if}
            </div>
          {/if}

          {#if s.archived}
            <button class="btn ghost" onclick={() => unarchive(s.id)} title="Move back to Notes">
              <Icon name="restore" size={14} /> Unarchive
            </button>
          {:else}
            <button class="btn ghost" onclick={() => archive(s.id)} title="Move to Archive">
              <Icon name="archive" size={14} /> Archive
            </button>
          {/if}

          <button class="btn danger" onclick={() => remove(s.id)} title="Delete note" aria-label="Delete note">
            <Icon name="trash" size={14} />
          </button>
        </div>

        <div class="editor-scroll">
          {#if linkedAgents.length > 0}
            <div class="linked-banner-list">
              {#each linkedAgents as agent (agent.id)}
                <button class="linked-banner" onclick={() => onOpenAgent(agent.id)}>
                  <Icon name="agents" size={15} />
                  <span class="lb-text">Agent <b>{agent.name}</b></span>
                  <span class="lb-go">Open <Icon name="arrowRight" size={13} /></span>
                </button>
              {/each}
            </div>
          {/if}

          <input
            bind:this={titleEl}
            class="title-input"
            placeholder="Title"
            value={s.title}
            oninput={(e) => edit("title", e.currentTarget.value)}
          />
          <!-- Preview state is tracked per note id so it persists when switching notes
               (and doesn't leak from one note to another). -->
          <MarkdownEditor
            grow
            value={s.details}
            placeholder="Start writing… Markdown supported — ⌘B bold, ⌘I italic."
            minHeight="320px"
            preview={app.getNotePreview(s.id)}
            onPreviewChange={(v) => app.setNotePreview(s.id, v)}
            oninput={(v) => edit("details", v)}
            onselect={getSelectedText}
          />
        </div>
      {:else}
        <div class="empty">
          <div class="glyph"><Icon name="notes" size={44} stroke={1.4} /></div>
          <h2>Your notes live here</h2>
          <p>Jot down tasks, then create agents to work on them.</p>
          <button class="btn primary" onclick={newIdea}><Icon name="plus" size={15} /> New note</button>
        </div>
      {/if}
    </section>
  </div>
</div>

{#if agentDialog}
  <NewWorkspaceDialog
    heading="Create agent for note"
    submitLabel="Create workspace & agent"
    onCreated={onAgentWorkspace}
    onClose={() => (agentDialog = null)}
  />
{/if}

<style>
  .page {
    flex: 1;
    min-height: 0;
    display: flex;
    background: var(--bg);
  }
  .split {
    flex: 1;
    min-height: 0;
    display: flex;
  }

  /* ---- list pane ---- */
  .list-pane {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--border-muted);
    background: var(--surface-1);
  }
  /* Draggable divider on the note-list's right edge. */
  .list-resize {
    flex: 0 0 auto;
    width: 6px;
    margin-left: -3px;
    margin-right: -3px;
    cursor: col-resize;
    touch-action: none;
    z-index: 5;
    transition: background 0.12s ease;
  }
  .list-resize:hover {
    background: color-mix(in srgb, var(--accent) 45%, transparent);
  }
  .list-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 16px 10px;
  }
  .list-head h1 {
    margin: 0;
    font-size: 18px;
    font-weight: 700;
    color: var(--text);
  }
  .new-note {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    padding: 0;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-2);
    color: var(--text-secondary);
    cursor: pointer;
    transition: border-color 0.12s ease, color 0.12s ease, background 0.12s ease;
  }
  .new-note:hover {
    border-color: var(--accent-line);
    color: var(--text);
    background: var(--surface-3);
  }
  .list-tabs {
    display: flex;
    gap: 3px;
    margin: 0 12px 8px;
    padding: 3px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
  }
  .list-tab {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 11.5px;
    font-weight: 600;
    padding: 5px 8px;
    border-radius: var(--r-xs);
    cursor: pointer;
    transition: background var(--t-fast), color var(--t-fast);
  }
  .list-tab:hover {
    color: var(--text);
  }
  .list-tab.on {
    background: var(--surface-3);
    color: var(--text);
  }
  .lt-c {
    font-size: 10px;
    font-weight: 800;
    color: var(--text-faint);
  }
  .list-tab.on .lt-c {
    color: var(--text-secondary);
  }
  .search {
    padding: 0 12px 8px;
  }
  .search-input {
    width: 100%;
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-sm);
    padding: 7px 10px;
    color: var(--text);
    font-size: 12.5px;
    font-family: inherit;
    outline: none;
    transition: border-color var(--t-fast);
  }
  .search-input::placeholder {
    color: var(--text-ghost);
  }
  .search-input:focus {
    border-color: var(--accent-line);
  }
  .list-empty {
    padding: 10px 16px;
    font-size: 12.5px;
    color: var(--text-faint);
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 2px 8px 16px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .item {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 3px;
    width: 100%;
    padding: 10px 11px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    text-align: left;
    cursor: pointer;
    transition: background 0.12s ease, border-color 0.12s ease;
  }
  .item:hover {
    background: var(--surface-2);
  }
  .item.active {
    background: var(--surface-3);
    border-color: var(--border);
  }
  .item-top {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-right: 20px;
  }
  .item-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .item-task {
    display: grid;
    place-items: center;
    color: var(--accent);
    flex-shrink: 0;
  }
  .item-snip {
    font-size: 11.5px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .item-date {
    font-size: 10.5px;
    color: var(--text-faint);
  }
  .item-del {
    position: absolute;
    top: 8px;
    right: 8px;
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border: none;
    border-radius: var(--r-xs);
    background: transparent;
    color: var(--text-faint);
    cursor: pointer;
    opacity: 0;
    transition: opacity var(--t-fast), color var(--t-fast), background var(--t-fast);
  }
  .item:hover .item-del {
    opacity: 1;
  }
  .item-del:hover {
    color: var(--danger);
    background: var(--danger-bg);
  }

  /* ---- editor pane ---- */
  .editor-pane {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }
  .editor-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border-muted);
  }
  .meta {
    font-size: 11.5px;
    color: var(--text-faint);
  }
  .meta.dim {
    color: var(--text-ghost);
  }
  .bar-spacer {
    flex: 1;
  }
  .task-chips {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .task-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    font-weight: 600;
    color: var(--c);
    background: color-mix(in srgb, var(--c) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--c) 35%, transparent);
    border-radius: var(--r-sm);
    padding: 4px 9px;
  }
  .task-chip .cd {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--c);
  }
  .task-chip-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    font-weight: 600;
    color: var(--c);
    background: color-mix(in srgb, var(--c) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--c) 35%, transparent);
    border-radius: var(--r-sm);
    padding: 4px 9px;
    cursor: pointer;
    transition: background var(--t-fast), border-color var(--t-fast);
  }
  .task-chip-btn:hover {
    background: color-mix(in srgb, var(--c) 22%, transparent);
    border-color: color-mix(in srgb, var(--c) 50%, transparent);
  }
  .task-chip-btn .cd {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--c);
  }
  .button-group {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
  .editor-scroll {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    padding: 22px 28px 28px;
    max-width: 820px;
    width: 100%;
    margin: 0 auto;
  }
  .linked-banner-list {
    display: flex;
    flex-direction: column;
    gap: 0;
    margin-bottom: 8px;
  }
  .linked-banner {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    margin-bottom: 16px;
    padding: 10px 12px;
    border: 1px solid var(--accent-line);
    border-radius: var(--r-md);
    background: var(--accent-softer);
    color: var(--text-secondary);
    font-size: 12.5px;
    cursor: pointer;
    text-align: left;
    transition: background var(--t-fast);
  }
  .linked-banner:hover {
    background: var(--accent-soft);
  }
  .linked-banner :global(svg):first-child {
    color: var(--accent);
    flex-shrink: 0;
  }
  .lb-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lb-text b {
    color: var(--text);
    font-weight: 600;
  }
  .lb-go {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--accent-bright);
    font-weight: 600;
    flex-shrink: 0;
  }
  .title-input {
    border: none;
    background: transparent;
    color: var(--text);
    font-size: 24px;
    font-weight: 700;
    font-family: inherit;
    outline: none;
    padding: 0 0 10px;
  }
  .title-input::placeholder {
    color: var(--text-ghost);
  }

  .empty {
    margin: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 9px;
    text-align: center;
    color: var(--text-faint);
  }
  .empty .glyph {
    opacity: 0.4;
  }
  .empty h2 {
    margin: 0;
    font-size: 16px;
    color: var(--text-muted);
  }
  .empty p {
    margin: 0 0 6px;
    font-size: 13px;
  }

  /* ---- buttons ---- */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border-radius: var(--r-sm);
    padding: 7px 12px;
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid transparent;
    white-space: nowrap;
  }
  .btn.primary {
    background: var(--accent);
    color: var(--accent-fg);
    padding: 9px 15px;
    font-size: 13px;
    box-shadow: var(--shadow-sm);
  }
  .btn.primary:hover {
    background: var(--accent-dim);
  }
  .btn.accent {
    background: color-mix(in srgb, var(--accent) 18%, var(--bg));
    border-color: var(--accent-line);
    color: var(--text);
  }
  .btn.accent:hover {
    background: color-mix(in srgb, var(--accent) 30%, var(--bg));
  }
  .btn.ghost {
    background: transparent;
    border-color: var(--border-strong);
    color: var(--text-secondary);
  }
  .btn.ghost:hover {
    background: var(--surface-2);
    border-color: var(--accent-line);
    color: var(--text);
  }
  .btn.danger {
    background: transparent;
    border-color: var(--border-strong);
    color: var(--text-faint);
  }
  .btn.danger:hover {
    background: var(--danger-bg);
    border-color: var(--danger-line);
    color: var(--danger);
  }
</style>
