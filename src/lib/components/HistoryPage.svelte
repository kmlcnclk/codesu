<script lang="ts">
  import { app, type Agent, type Workspace } from "$lib/store/app.svelte";
  import Icon from "./Icon.svelte";

  let {
    onOpenAgent,
    onOpenNote,
  }: { onOpenAgent: (agentId: string) => void; onOpenNote: (noteId: string) => void } = $props();

  // Finished agents grouped by their workspace (workspace-less agents last).
  const agentGroups = $derived.by(() => {
    const map = new Map<string, { ws: Workspace | undefined; agents: Agent[] }>();
    for (const a of app.historyAgents) {
      const key = a.workspaceId ?? "__none__";
      if (!map.has(key)) map.set(key, { ws: workspaceOf(a.workspaceId), agents: [] });
      map.get(key)!.agents.push(a);
    }
    return [...map.values()].sort(
      (x, y) => (x.ws?.order ?? Infinity) - (y.ws?.order ?? Infinity),
    );
  });

  const KIND_LABEL: Record<Agent["kind"], string> = {
    claude: "Claude",
    shell: "Shell",
    custom: "Command",
  };

  function relTime(ts: number): string {
    const diff = Date.now() - ts;
    const m = Math.round(diff / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.round(h / 24);
    if (d < 7) return `${d}d ago`;
    try {
      return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch {
      return "";
    }
  }

  function workspaceOf(id: string | null) {
    return id ? app.workspaces.find((w) => w.id === id) : undefined;
  }
  function restoreAgent(agent: Agent) {
    // An archived agent belongs to an archived workspace — restoring it brings the
    // whole workspace back. A plain "done" agent just returns to the board.
    if (agent.archived && agent.workspaceId) {
      app.unarchiveWorkspace(agent.workspaceId);
    } else {
      app.restoreFromHistory(agent.id);
    }
    onOpenAgent(agent.id);
  }

  const empty = $derived(app.historyAgents.length === 0 && app.archivedWorkspaces.length === 0);
</script>

<div class="page">
  <header class="page-head">
    <div class="titles">
      <h1>History</h1>
      <p>Finished agents and archived workspaces — restore anything.</p>
    </div>
    {#if !empty}
      <div class="stats">
        <div class="stat">
          <span class="stat-ico" style="--c:var(--accent)"><Icon name="agents" size={16} /></span>
          <span class="stat-n">{app.historyAgents.length}</span>
          <span class="stat-l">agent{app.historyAgents.length === 1 ? "" : "s"}</span>
        </div>
        <div class="stat">
          <span class="stat-ico" style="--c:var(--warn)"><Icon name="folder" size={16} /></span>
          <span class="stat-n">{app.archivedWorkspaces.length}</span>
          <span class="stat-l">workspace{app.archivedWorkspaces.length === 1 ? "" : "s"}</span>
        </div>
      </div>
    {/if}
  </header>

  <div class="scroll">
    {#if empty}
      <div class="empty">
        <div class="glyph"><Icon name="inbox" size={44} stroke={1.3} /></div>
        <h2>Nothing here yet</h2>
        <p>Agents you mark <b>Done</b> and workspaces you archive show up here.</p>
      </div>
    {:else}
      <div class="wrap">
        {#if app.historyAgents.length > 0}
          <section>
            <h2 class="section-title">
              <Icon name="agents" size={13} /> Agents <span class="c">{app.historyAgents.length}</span>
            </h2>

            {#each agentGroups as group (group.ws?.id ?? "__none__")}
              <div class="ws-group">
                <div class="ws-group-head" style="--wsc:{group.ws?.color ?? 'var(--text-faint)'}">
                  <span class="wsd"></span>
                  <span class="ws-name">{group.ws?.name ?? "No workspace"}</span>
                  {#if group.ws?.archived}<span class="ws-flag">archived</span>{/if}
                  <span class="ws-count">{group.agents.length}</span>
                </div>
                <ul class="rows">
                  {#each group.agents as agent (agent.id)}
                    {@const note = app.noteForAgent(agent)}
                    <li class="row" style="--accent:{group.ws?.color ?? 'var(--ok)'}">
                      <span class="avatar"><Icon name="agents" size={17} /></span>
                      <div class="info">
                        <div class="line1">
                          <span class="name">{agent.name}</span>
                          <span class="tag">{KIND_LABEL[agent.kind]}</span>
                        </div>
                        <div class="line2">
                          {#if agent.archived}
                            <span class="arch-dot"></span><span>Archived</span>
                          {:else}
                            <span class="done-dot"></span><span>Done</span>
                          {/if}
                          <span class="dot-sep">·</span>
                          <span>{relTime(agent.createdAt)}</span>
                          {#if agent.exitCode !== null}
                            <span class="dot-sep">·</span>
                            <span class="mono">exit {agent.exitCode}</span>
                          {/if}
                        </div>
                        {#if note}
                          <button
                            class="note-chip"
                            title="Open linked note"
                            onclick={() => onOpenNote(note.id)}
                          >
                            <Icon name="notes" size={11} />
                            <span class="note-chip-t">{note.title?.trim() || "Untitled note"}</span>
                          </button>
                        {/if}
                      </div>
                      <div class="acts">
                        <button class="btn ghost sm" onclick={() => restoreAgent(agent)}>
                          <Icon name="restore" size={13} /> Restore
                        </button>
                        <button
                          class="btn danger sm icon-only"
                          title="Delete permanently"
                          aria-label="Delete agent"
                          onclick={() => app.removeAgent(agent.id)}><Icon name="trash" size={13} /></button
                        >
                      </div>
                    </li>
                  {/each}
                </ul>
              </div>
            {/each}
          </section>
        {/if}

        {#if app.archivedWorkspaces.length > 0}
          <section>
            <h2 class="section-title">
              <Icon name="folder" size={13} /> Archived workspaces
              <span class="c">{app.archivedWorkspaces.length}</span>
            </h2>
            <ul class="rows">
              {#each app.archivedWorkspaces as ws (ws.id)}
                <li class="row" style="--accent:{ws.color}">
                  <span class="avatar"><Icon name={ws.isWorktree ? "branch" : "folder"} size={17} /></span>
                  <div class="info">
                    <div class="line1">
                      <span class="name">{ws.name}</span>
                      <span class="tag">{ws.isWorktree ? "Worktree" : "Folder"}</span>
                    </div>
                    <div class="line2 mono">{ws.branch ?? ws.path}</div>
                  </div>
                  <div class="acts">
                    <button class="btn ghost sm" onclick={() => app.unarchiveWorkspace(ws.id)}>
                      <Icon name="restore" size={13} /> Restore
                    </button>
                  </div>
                </li>
              {/each}
            </ul>
          </section>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .page {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }
  .page-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    padding: 20px 24px 16px;
    border-bottom: 1px solid var(--border-muted);
  }
  .titles h1 {
    margin: 0;
    font-size: 20px;
    font-weight: 700;
    color: var(--text);
  }
  .titles p {
    margin: 3px 0 0;
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .stats {
    display: flex;
    gap: 10px;
  }
  .stat {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 13px 10px 11px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--surface-1);
  }
  .stat-ico {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    color: var(--c);
    background: color-mix(in srgb, var(--c) 15%, transparent);
  }
  .stat-n {
    font-size: 17px;
    font-weight: 700;
    color: var(--text);
  }
  .stat-l {
    font-size: 12px;
    color: var(--text-muted);
  }

  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 20px 24px 32px;
  }
  .wrap {
    max-width: 840px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 26px;
  }
  .section-title {
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 0 0 10px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .section-title :global(svg) {
    color: var(--text-faint);
  }
  .section-title .c {
    font-size: 10.5px;
    background: var(--surface-4);
    color: var(--text-muted);
    border-radius: 8px;
    padding: 1px 7px;
    letter-spacing: 0;
  }
  .ws-group {
    margin-bottom: 16px;
  }
  .ws-group:last-child {
    margin-bottom: 0;
  }
  .ws-group-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 2px 8px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-secondary);
  }
  .ws-group-head .wsd {
    width: 9px;
    height: 9px;
    box-shadow: 0 0 7px color-mix(in srgb, var(--wsc) 55%, transparent);
  }
  .ws-name {
    color: var(--text);
  }
  .ws-flag {
    font-size: 9.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--warn);
    background: color-mix(in srgb, var(--warn) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--warn) 35%, transparent);
    border-radius: 5px;
    padding: 1px 6px;
  }
  .ws-count {
    margin-left: auto;
    font-size: 10.5px;
    font-weight: 800;
    color: var(--text-muted);
    background: var(--surface-4);
    border-radius: 8px;
    padding: 1px 7px;
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 11px 14px;
    border: 1px solid var(--surface-4);
    border-radius: var(--r-lg);
    background: var(--surface-float);
    box-shadow: var(--shadow-sm);
    transition: border-color var(--t-fast), transform var(--t-fast);
  }
  .row:hover {
    border-color: var(--border-strong);
    transform: translateY(-1px);
  }
  .avatar {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border-radius: var(--r-md);
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent);
  }
  .info {
    flex: 1;
    min-width: 0;
  }
  .line1 {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .name {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tag {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-faint);
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 1px 6px;
    flex-shrink: 0;
  }
  .line2 {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-top: 4px;
    font-size: 11.5px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .line2.mono {
    font-family: var(--font-mono);
  }
  .mono {
    font-family: var(--font-mono);
  }
  .wsd {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--wsc);
  }
  .done-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ok);
    box-shadow: 0 0 6px var(--ok-glow);
  }
  .arch-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--warn);
  }
  .note-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 100%;
    margin-top: 6px;
    padding: 2px 8px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--surface-1);
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: border-color var(--t-fast), color var(--t-fast), background var(--t-fast);
  }
  .note-chip:hover {
    border-color: var(--accent-line);
    color: var(--text);
    background: var(--surface-3);
  }
  .note-chip :global(svg) {
    color: var(--accent);
    flex-shrink: 0;
  }
  .note-chip-t {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dot-sep {
    color: var(--text-ghost);
  }
  .acts {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
    opacity: 0.55;
    transition: opacity var(--t-fast);
  }
  .row:hover .acts {
    opacity: 1;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border-radius: var(--r-sm);
    padding: 6px 11px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid transparent;
    white-space: nowrap;
  }
  .btn.icon-only {
    padding: 6px 8px;
  }
  .btn.ghost {
    background: transparent;
    border-color: var(--border-strong);
    color: var(--text-secondary);
  }
  .btn.ghost:hover {
    background: var(--surface-4);
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

  .empty {
    max-width: 420px;
    margin: 10vh auto 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    text-align: center;
    color: var(--text-faint);
  }
  .empty .glyph {
    display: grid;
    place-items: center;
    width: 82px;
    height: 82px;
    border-radius: 50%;
    background: var(--surface-1);
    border: 1px solid var(--border);
    color: var(--text-muted);
    opacity: 0.9;
  }
  .empty h2 {
    margin: 4px 0 0;
    font-size: 16px;
    color: var(--text-muted);
  }
  .empty p {
    margin: 0;
    font-size: 13px;
  }
  .empty b {
    color: var(--text-secondary);
  }
</style>
