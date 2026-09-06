<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import Modal from "./Modal.svelte";
  import { app, type Workspace } from "$lib/store/app.svelte";

  interface Worktree {
    path: string;
    branch: string | null;
    head: string | null;
    locked: boolean;
    is_main: boolean;
  }

  let {
    projectId,
    onClose,
    onCreated,
    heading = "New workspace",
    submitLabel = "Create workspace",
  }: {
    /** The project the new workspace is created UNDER. */
    projectId: string;
    onClose: () => void;
    /** Called with the freshly-created workspace before the dialog closes. */
    onCreated?: (ws: Workspace) => void;
    heading?: string;
    submitLabel?: string;
  } = $props();

  const project = $derived(app.projects.find((p) => p.id === projectId));

  /**
   * A workspace is a COPY of the project folder — a git worktree, made by the same
   * `create_worktree` path Codesu has always used, checking the project out at
   * `~/.codesu/worktrees/<repo>/<branch>` so parallel agents never fight over one
   * checkout. There is no second way in: pointing a workspace at some unrelated folder
   * would file it under a project it has nothing to do with, and a project that is not
   * a git repo simply has nothing to branch from.
   */
  let branch = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function create() {
    error = null;
    if (!project) {
      error = "That project no longer exists.";
      return;
    }
    if (!project.isGit) {
      error = `${project.name} is not a git repository, so it has no branch to copy.`;
      return;
    }
    const name = branch.trim();
    if (!name) {
      error = "Branch name is required.";
      return;
    }
    busy = true;
    try {
      const wt = await invoke<Worktree>("create_worktree", {
        repo: project.path,
        branch: name,
        // Always off the project's current HEAD — the branch you are on is what you
        // want a scratch copy of, and asking every time bought nothing.
        baseRef: null,
      });
      const ws = app.addWorkspace({
        projectId: project.id,
        name,
        path: wt.path,
        repo: project.path,
        branch: name,
        isWorktree: true,
      });
      onCreated?.(ws);
      onClose();
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      busy = false;
    }
  }

  /** Enter submits — the dialog has exactly one field, so a trip to the button is noise. */
  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !busy) {
      e.preventDefault();
      void create();
    }
  }

  function focusOnMount(node: HTMLInputElement) {
    node.focus();
  }
</script>

<Modal title={heading} {onClose}>
  <div class="form">
    {#if project}
      <div class="proj-tag" style="--accent:{project.color}">
        <span class="d"></span>under <b>{project.name}</b>
        <span class="path">{project.path}</span>
      </div>
    {/if}

    {#if project && !project.isGit}
      <p class="hint">
        <b>{project.name}</b> is not a git repository, so there is no branch to copy into a
        workspace. Run <code>git init</code> in the folder and reopen this dialog.
      </p>
    {:else}
      <p class="hint">
        Checks the project out into its own folder under <code>~/.codesu/worktrees</code>, off
        the current HEAD, so agents here never touch the other workspaces' files.
      </p>
      <label class="field">
        <span class="lbl">Branch</span>
        <input
          class="input mono"
          bind:value={branch}
          use:focusOnMount
          placeholder="feat/my-task"
          spellcheck="false"
          autocomplete="off"
          onkeydown={onKey}
        />
      </label>
    {/if}

    {#if error}<p class="error">{error}</p>{/if}

    <div class="actions">
      <button type="button" class="btn ghost" onclick={onClose}>Cancel</button>
      <button
        type="button"
        class="btn primary"
        disabled={busy || !project?.isGit}
        onclick={create}
      >
        {busy ? "Working…" : submitLabel}
      </button>
    </div>
  </div>
</Modal>

<style>
  .hint {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-muted);
  }
  .hint code {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-secondary);
  }
  .proj-tag {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .proj-tag .d {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--accent);
    flex: none;
  }
  .proj-tag b {
    color: var(--text-secondary);
    font-weight: 600;
  }
  .proj-tag .path {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-ghost);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 14px;
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
