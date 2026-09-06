<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { open } from "@tauri-apps/plugin-dialog";
  import Modal from "./Modal.svelte";
  import { app, type Project } from "$lib/store/app.svelte";

  interface DefaultProject {
    path: string;
    hasGit: boolean;
  }

  let {
    onClose,
    onCreated,
  }: {
    onClose: () => void;
    /** Called with the freshly-added project before the dialog closes. */
    /**
     * `created` is false when the folder was already a project and this call only
     * selected it — the caller must not treat that as a fresh project (seeding an
     * agent into one you already had is not what re-picking a folder asks for).
     */
    onCreated?: (project: Project, created: boolean) => void;
  } = $props();

  let folder = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);
  let defaultProjects = $state<DefaultProject[]>([]);

  async function loadDefaultProjects() {
    const list: DefaultProject[] = [];
    for (const path of app.defaultProjects) {
      try {
        list.push({ path, hasGit: await invoke<boolean>("is_git_repo", { path }) });
      } catch {
        list.push({ path, hasGit: false });
      }
    }
    defaultProjects = list;
  }

  $effect.pre(() => {
    loadDefaultProjects();
  });

  async function pickFolder() {
    const dir = await open({ directory: true, multiple: false, title: "Open project folder" });
    if (typeof dir === "string") folder = dir;
  }

  /**
   * Add the folder as a project. Git-ness is resolved BEFORE the project is created so
   * the tree knows from the first render whether this project can spawn worktree
   * workspaces — a project that silently refused "New workspace" would look broken.
   */
  async function create(path = folder) {
    const target = path.trim();
    error = null;
    if (!target) {
      error = "Pick a folder.";
      return;
    }
    busy = true;
    try {
      let isGit = false;
      try {
        isGit = await invoke<boolean>("is_git_repo", { path: target });
      } catch {
        /* not fatal — the project is still usable, just without worktrees */
      }
      const { project, created } = app.addProject({ path: target, isGit });
      onCreated?.(project, created);
      onClose();
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      busy = false;
    }
  }
</script>

<Modal title="New project" {onClose}>
  <div class="form">
    <p class="hint">
      A project is a folder you work in. Its branches live underneath it as workspaces.
    </p>

    {#if defaultProjects.length > 0}
      <div class="field">
        <span class="lbl">Default projects</span>
        <div class="defaults">
          {#each defaultProjects as proj (proj.path)}
            <button type="button" class="default-btn" title={proj.path} onclick={() => create(proj.path)}>
              {proj.path.split("/").pop()}
              {#if proj.hasGit}<span class="git-badge">git</span>{/if}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <label class="field">
      <span class="lbl">Folder</span>
      <div class="row">
        <input class="input mono" bind:value={folder} placeholder="/path/to/project" spellcheck="false" />
        <button type="button" class="pick" onclick={pickFolder}>Browse…</button>
      </div>
    </label>

    {#if error}<p class="error">{error}</p>{/if}

    <div class="actions">
      <button type="button" class="btn ghost" onclick={onClose}>Cancel</button>
      <button type="button" class="btn primary" disabled={busy} onclick={() => create()}>
        {busy ? "Working…" : "Add project"}
      </button>
    </div>
  </div>
</Modal>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .hint {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-muted);
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
  .defaults {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .default-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    border: 1px solid var(--border-strong);
    background: var(--surface-2);
    color: var(--text-secondary);
    border-radius: var(--r-sm);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.13s, color 0.13s, border-color 0.13s;
  }
  .default-btn:hover {
    background: var(--accent-soft);
    color: var(--accent-bright);
    border-color: var(--accent);
  }
  .git-badge {
    display: inline-block;
    padding: 2px 6px;
    background: var(--surface-3);
    color: var(--text-muted);
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    opacity: 0.7;
  }
  .row {
    display: flex;
    gap: 8px;
  }
  .row .input {
    flex: 1;
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
    font-family: var(--font-mono);
    font-size: 12px;
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
  .error {
    margin: 0;
    font-size: 12px;
    color: var(--danger);
    background: var(--danger-bg);
    border: 1px solid var(--danger-line);
    border-radius: var(--r-sm);
    padding: 8px 10px;
    font-family: var(--font-mono);
    word-break: break-word;
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
  .btn.primary:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
