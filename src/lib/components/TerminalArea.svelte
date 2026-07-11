<script lang="ts">
  import { app } from "$lib/store/app.svelte";
  import TerminalPane from "./TerminalPane.svelte";
  import Icon from "./Icon.svelte";

  function cwdFor(workspaceId: string, agentCwd: string | null): string | null {
    if (agentCwd) return agentCwd;
    return app.workspaces.find((w) => w.id === workspaceId)?.path ?? null;
  }
</script>

<div class="area">
  {#if app.mountedAgents.length === 0}
    <div class="empty">
      {#if app.liveWorkspaces.length === 0}
        <div class="glyph"><Icon name="folder" size={34} stroke={1.4} /></div>
        <h2>No workspaces yet</h2>
        <p>Create a workspace from the left to start running agents.</p>
      {:else}
        <div class="glyph"><Icon name="terminal" size={34} stroke={1.4} /></div>
        <h2>No agents in this workspace</h2>
        <p>Press <kbd>⌘</kbd><kbd>T</kbd> or use the + tab to launch a Claude agent.</p>
      {/if}
    </div>
  {:else}
    {#each app.mountedAgents as agent (agent.id)}
      <TerminalPane
        {agent}
        active={agent.id === app.activeAgent?.id}
        cwd={cwdFor(agent.workspaceId, agent.cwd)}
      />
    {/each}
    {#if !app.activeAgent}
      <div class="empty overlay">
        <div class="glyph"><Icon name="terminal" size={34} stroke={1.4} /></div>
        <h2>No open agent</h2>
        <p>Press <kbd>⌘</kbd><kbd>T</kbd> or pick a tab above.</p>
      </div>
    {/if}
  {/if}
</div>

<style>
  .area {
    position: relative;
    flex: 1;
    min-height: 0;
    background: var(--term-bg);
    overflow: hidden;
  }
  .empty {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: var(--text-faint);
    user-select: none;
    text-align: center;
    padding: 0 24px;
  }
  .empty.overlay {
    background: var(--term-bg);
  }
  .empty .glyph {
    display: grid;
    place-items: center;
    width: 76px;
    height: 76px;
    margin-bottom: 2px;
    border-radius: 50%;
    background: var(--surface-1);
    border: 1px solid var(--border);
    color: var(--text-muted);
  }
  .empty h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--text-muted);
  }
  .empty p {
    margin: 0;
    font-size: 12.5px;
  }
  kbd {
    display: inline-block;
    padding: 1px 6px;
    margin: 0 1px;
    font-size: 11px;
    font-family: ui-monospace, monospace;
    color: var(--text-secondary);
    background: var(--border);
    border: 1px solid var(--border-strong);
    border-radius: 5px;
  }
</style>
