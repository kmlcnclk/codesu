<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import Modal from "./Modal.svelte";
  import { app, runCommandFor, type AgentKind } from "$lib/store/app.svelte";

  let { workspaceId, onClose }: { workspaceId: string; onClose: () => void } = $props();

  const workspace = $derived(app.workspaces.find((w) => w.id === workspaceId));

  let name = $state("");
  let kind = $state<AgentKind>("claude");
  let custom = $state("");
  let cwd = $state<string | null>(null);

  const KINDS: { value: AgentKind; label: string; hint: string }[] = [
    { value: "claude", label: "Claude Code", hint: "Runs `claude`" },
    { value: "shell", label: "Shell", hint: "Interactive shell" },
    { value: "custom", label: "Command", hint: "Any command" },
  ];

  async function pickFolder() {
    const dir = await open({ directory: true, multiple: false, title: "Working directory" });
    if (typeof dir === "string") cwd = dir;
  }

  function create() {
    app.addAgent({
      workspaceId,
      name: name.trim() || undefined,
      kind,
      run: runCommandFor(kind, custom),
      cwd,
    });
    onClose();
  }
</script>

<Modal title="New agent" {onClose}>
  <div class="form">
    {#if workspace}
      <div class="ws-tag" style="--accent:{workspace.color}">
        <span class="d"></span>in <b>{workspace.name}</b>
      </div>
    {/if}

    <label class="field">
      <span class="lbl">Name <em>(optional)</em></span>
      <input class="input" bind:value={name} placeholder="e.g. Fix login bug" />
    </label>

    <div class="field">
      <span class="lbl">Type</span>
      <div class="kinds">
        {#each KINDS as k}
          <button type="button" class="kind" class:active={kind === k.value} onclick={() => (kind = k.value)}>
            <span class="kind-label">{k.label}</span>
            <span class="kind-hint">{k.hint}</span>
          </button>
        {/each}
      </div>
    </div>

    {#if kind === "custom"}
      <label class="field">
        <span class="lbl">Command</span>
        <input class="input mono" bind:value={custom} placeholder="e.g. aider --model sonnet" />
      </label>
    {/if}

    <div class="field">
      <span class="lbl">Working directory <em>(defaults to workspace)</em></span>
      <div class="row">
        <input class="input mono" bind:value={cwd} placeholder={workspace?.path ?? "$HOME"} spellcheck="false" />
        <button type="button" class="pick" onclick={pickFolder}>Browse…</button>
      </div>
    </div>

    <div class="actions">
      <button type="button" class="btn ghost" onclick={onClose}>Cancel</button>
      <button type="button" class="btn primary" onclick={create}>Create agent</button>
    </div>
  </div>
</Modal>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .ws-tag {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .ws-tag .d {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--accent);
  }
  .ws-tag b {
    color: var(--text-secondary);
    font-weight: 600;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .lbl {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
  }
  .lbl em {
    font-style: normal;
    color: var(--text-muted);
    font-weight: 400;
  }
  .input {
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-sm);
    padding: 9px 11px;
    color: var(--text);
    font-size: 13px;
    font-family: inherit;
    outline: none;
    transition: border-color var(--t-fast), box-shadow var(--t-fast);
  }
  .input::placeholder {
    color: var(--text-ghost);
  }
  .input:focus {
    border-color: var(--accent-line);
    box-shadow: 0 0 0 3px var(--accent-softer);
  }
  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }
  .kinds {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }
  .kind {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 9px 10px;
    border: 1px solid var(--border-strong);
    border-radius: var(--r-md);
    background: var(--bg);
    color: var(--text-secondary);
    text-align: left;
    cursor: pointer;
    transition: border-color var(--t-fast), background var(--t-fast), color var(--t-fast);
  }
  .kind:hover {
    background: var(--surface-2);
    color: var(--text);
  }
  .kind.active {
    border-color: color-mix(in srgb, var(--accent) 60%, transparent);
    background: color-mix(in srgb, var(--accent) 15%, var(--bg));
    color: var(--text);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent);
  }
  .kind-label {
    font-size: 12.5px;
    font-weight: 600;
  }
  .kind-hint {
    font-size: 10.5px;
    color: var(--text-muted);
  }
  .row {
    display: flex;
    gap: 8px;
  }
  .row .input {
    flex: 1;
  }
  .pick {
    border: 1px solid var(--border-strong);
    background: var(--surface-2);
    color: var(--text-secondary);
    border-radius: var(--r-sm);
    padding: 0 12px;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
    transition: border-color var(--t-fast), color var(--t-fast), background var(--t-fast);
  }
  .pick:hover {
    border-color: var(--accent-line);
    color: var(--text);
    background: var(--surface-3);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .btn {
    border-radius: var(--r-sm);
    padding: 8px 15px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid transparent;
    transition: background var(--t-fast), color var(--t-fast);
  }
  .btn.ghost {
    background: transparent;
    border-color: var(--border-strong);
    color: var(--text-secondary);
  }
  .btn.ghost:hover {
    background: var(--surface-2);
    color: var(--text);
  }
  .btn.primary {
    background: var(--accent);
    color: var(--accent-fg);
    box-shadow: var(--shadow-sm);
  }
  .btn.primary:hover {
    background: var(--accent-dim);
  }
</style>
