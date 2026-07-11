<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { open } from "@tauri-apps/plugin-dialog";
  import Modal from "./Modal.svelte";
  import { app, type Workspace } from "$lib/store/app.svelte";

  interface Worktree {
    path: string;
    branch: string | null;
    head: string | null;
    locked: boolean;
    is_main: boolean;
  }

  interface DefaultProject {
    path: string;
    hasGit: boolean;
  }

  let {
    onClose,
    onCreated,
    heading = "New workspace",
    submitLabel = "Create workspace",
  }: {
    onClose: () => void;
    /** Called with the freshly-created workspace before the dialog closes. */
    onCreated?: (ws: Workspace) => void;
    heading?: string;
    submitLabel?: string;
  } = $props();

  let mode = $state<"folder" | "worktree">("folder");

  // folder mode
  let folder = $state("");
  // worktree mode
  let repo = $state("");
  let branch = $state("");
  let baseRef = $state("");

  let busy = $state(false);
  let error = $state<string | null>(null);
  let defaultProjects = $state<DefaultProject[]>([]);

  async function loadDefaultProjects() {
    const projects: DefaultProject[] = [];
    for (const path of app.defaultProjects) {
      try {
        const hasGit = await invoke<boolean>("is_git_repo", { path });
        projects.push({ path, hasGit });
      } catch {
        projects.push({ path, hasGit: false });
      }
    }
    defaultProjects = projects;
  }

  $effect.pre(() => {
    loadDefaultProjects();
  });

  async function pick(setter: (v: string) => void, title: string) {
    const dir = await open({ directory: true, multiple: false, title });
    if (typeof dir === "string") setter(dir);
  }

  async function create() {
    error = null;
    busy = true;
    try {
      let ws: Workspace;
      if (mode === "folder") {
        if (!folder.trim()) throw new Error("Pick a folder.");
        ws = app.addWorkspace({ path: folder.trim() });
      } else {
        if (!repo.trim() || !branch.trim()) throw new Error("Repository and branch are required.");
        const wt = await invoke<Worktree>("create_worktree", {
          repo: repo.trim(),
          branch: branch.trim(),
          baseRef: baseRef.trim() || null,
        });
        ws = app.addWorkspace({
          name: branch.trim(),
          path: wt.path,
          repo: repo.trim(),
          branch: branch.trim(),
          isWorktree: true,
        });
      }
      onCreated?.(ws);
      onClose();
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      busy = false;
    }
  }
</script>

<Modal title={heading} {onClose}>
  <div class="form">
    <div class="seg">
      <button class="seg-btn" class:on={mode === "folder"} onclick={() => (mode = "folder")}>Open folder</button>
      <button class="seg-btn" class:on={mode === "worktree"} onclick={() => (mode = "worktree")}>Git worktree</button>
    </div>

    {#if mode === "folder"}
      {#if defaultProjects.length > 0}
        <div class="field">
          <span class="lbl">Default projects</span>
          <div class="defaults">
            {#each defaultProjects as proj (proj.path)}
              <button
                type="button"
                class="default-btn"
                title={proj.path}
                onclick={() => {
                  folder = proj.path;
                  create();
                }}
              >
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
          <button type="button" class="pick" onclick={() => pick((v) => (folder = v), "Open folder")}>Browse…</button>
        </div>
      </label>
    {:else}
      {#if defaultProjects.filter((p) => p.hasGit).length > 0}
        <div class="field">
          <span class="lbl">Default git repos</span>
          <div class="defaults">
            {#each defaultProjects.filter((p) => p.hasGit) as proj (proj.path)}
              <button
                type="button"
                class="default-btn"
                title={proj.path}
                onclick={() => {
                  repo = proj.path;
                  mode = "worktree";
                }}
              >
                {proj.path.split("/").pop()}
              </button>
            {/each}
          </div>
        </div>
      {/if}
      <label class="field">
        <span class="lbl">Repository</span>
        <div class="row">
          <input class="input mono" bind:value={repo} placeholder="/path/to/repo" spellcheck="false" />
          <button type="button" class="pick" onclick={() => pick((v) => (repo = v), "Select repository")}>Browse…</button>
        </div>
      </label>
      <label class="field">
        <span class="lbl">New branch</span>
        <input class="input mono" bind:value={branch} placeholder="feat/my-task" spellcheck="false" />
      </label>
      <label class="field">
        <span class="lbl">Base ref <em>(optional)</em></span>
        <input class="input mono" bind:value={baseRef} placeholder="HEAD" spellcheck="false" />
      </label>
    {/if}

    {#if error}<p class="error">{error}</p>{/if}

    <div class="actions">
      <button type="button" class="btn ghost" onclick={onClose}>Cancel</button>
      <button type="button" class="btn primary" disabled={busy} onclick={create}>
        {busy ? "Working…" : submitLabel}
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
  .seg {
    display: flex;
    gap: 4px;
    padding: 4px;
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-md);
  }
  .seg-btn {
    flex: 1;
    padding: 7px;
    border: none;
    border-radius: var(--r-sm);
    background: transparent;
    color: var(--text-secondary);
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    transition: background var(--t-fast), color var(--t-fast);
  }
  .seg-btn:hover {
    color: var(--text);
  }
  .seg-btn.on {
    background: var(--surface-4);
    color: var(--text);
    box-shadow: inset 0 0 0 1px var(--accent-softer);
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
