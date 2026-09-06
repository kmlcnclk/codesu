<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { app, type ClaudePermissionMode, type Shortcut } from "$lib/store/app.svelte";
  import Icon from "./Icon.svelte";

  const PERM_MODES: { id: ClaudePermissionMode; label: string; desc: string }[] = [
    { id: "ask", label: "Ask every time", desc: "Claude's default — confirms before edits and before running commands." },
    { id: "edits", label: "Auto-accept edits", desc: "File edits go through silently; commands still ask." },
    {
      id: "full",
      label: "Never ask",
      desc: "Runs everything unattended, commands included. Best on a worktree you can throw away.",
    },
  ];

  let newPath = $state("");
  let error = $state<string | null>(null);
  let editingId = $state<string | null>(null);
  let recordingKey = $state(false);
  let recordedKey = $state<Partial<Shortcut> | null>(null);

  async function addProject() {
    error = null;
    const dir = await open({ directory: true, multiple: false, title: "Select a project folder" });
    if (typeof dir === "string") {
      try {
        app.addDefaultProject(dir);
        newPath = "";
      } catch (e) {
        error = String(e instanceof Error ? e.message : e);
      }
    }
  }

  function removeProject(path: string) {
    app.removeDefaultProject(path);
  }

  function startRecordingKey(shortcutId: string) {
    editingId = shortcutId;
    recordingKey = true;
    recordedKey = null;
  }

  function cancelRecording() {
    recordingKey = false;
    editingId = null;
    recordedKey = null;
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!recordingKey) return;
    e.preventDefault();

    recordedKey = {
      key: e.key.toLowerCase(),
      meta: e.metaKey,
      shift: e.shiftKey,
      ctrl: e.ctrlKey,
      alt: e.altKey,
    };
  }

  function saveRecordedKey(shortcutId: string) {
    if (!recordedKey || !editingId) return;

    app.updateShortcut(editingId, {
      key: recordedKey.key || "",
      meta: recordedKey.meta ?? false,
      shift: recordedKey.shift ?? false,
      ctrl: recordedKey.ctrl ?? false,
      alt: recordedKey.alt ?? false,
    });

    recordingKey = false;
    editingId = null;
    recordedKey = null;
  }

  function formatShortcut(shortcut: Shortcut): string {
    const parts = [];
    if (shortcut.meta) parts.push("⌘");
    if (shortcut.shift) parts.push("⇧");
    if (shortcut.ctrl) parts.push("⌃");
    if (shortcut.alt) parts.push("⌥");
    parts.push(shortcut.key.toUpperCase());
    return parts.join("");
  }

  function getContextLabel(context: string): string {
    const labels: Record<string, string> = {
      global: "Global",
      agents: "Agents Page",
      tasks: "Tasks Page",
      notes: "Notes Page",
      report: "Report Page",
      history: "History Page",
      settings: "Settings Page",
      terminal: "Terminal Page",
    };
    return labels[context] || context;
  }
</script>

<svelte:window onkeydown={onKeyDown} />

<div class="page">
  <header class="page-head">
    <div class="titles">
      <h1>Settings</h1>
      <p>Default projects, Claude permissions and keyboard shortcuts for Codesu.</p>
    </div>
  </header>

  <div class="scroll">
   <div class="wrap">
  <!-- Default Projects Section -->
  <div class="section">
    <h2 class="section-title">Default projects</h2>
    <p class="desc">These projects are offered when you create a new workspace.</p>

    {#if app.defaultProjects.length > 0}
      <div class="projects-list">
        {#each app.defaultProjects as path (path)}
          <div class="project-item">
            <span class="path">{path}</span>
            <button
              class="remove-btn"
              title="Remove project"
              onclick={() => removeProject(path)}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        {/each}
      </div>
    {:else}
      <p class="empty-hint">No default projects yet — add one below.</p>
    {/if}

    <button class="add-btn" onclick={addProject}>
      <Icon name="plus" size={14} />
      Add default project
    </button>

    {#if error}
      <p class="error">{error}</p>
    {/if}
  </div>

  <!-- Claude Permissions Section -->
  <div class="section">
    <h2 class="section-title">Claude permissions</h2>
    <p class="desc">
      How much a Claude agent may do before it stops to ask you. Takes effect the next time
      an agent starts or resumes.
    </p>

    <div class="perm-list">
      {#each PERM_MODES as m (m.id)}
        <button
          class="perm-item"
          class:on={app.claudePermissionMode === m.id}
          aria-pressed={app.claudePermissionMode === m.id}
          onclick={() => app.setClaudePermissionMode(m.id)}
        >
          <span class="perm-radio" aria-hidden="true"></span>
          <span class="perm-text">
            <span class="perm-label">{m.label}</span>
            <span class="perm-desc">{m.desc}</span>
          </span>
        </button>
      {/each}
    </div>
  </div>

  <!-- Keyboard Shortcuts Section -->
  <div class="section">
    <div class="section-header">
      <div>
        <h2 class="section-title">Keyboard shortcuts</h2>
        <p class="desc">Customize keyboard shortcuts for each page context.</p>
      </div>
      <button class="reset-btn" onclick={() => app.resetShortcutsToDefault()}>
        Reset to defaults
      </button>
    </div>

    <div class="shortcuts-grid">
      {#each app.shortcuts as shortcut (shortcut.id)}
        <div class="shortcut-item">
          <div class="shortcut-info">
            <div class="shortcut-name">{shortcut.name}</div>
            <div class="shortcut-context">{getContextLabel(shortcut.context)}</div>
          </div>

          {#if editingId === shortcut.id && recordingKey}
            <div class="recording">
              <span class="recording-text">
                {recordedKey
                  ? formatShortcut({
                      key: recordedKey.key || "",
                      meta: recordedKey.meta ?? false,
                      shift: recordedKey.shift ?? false,
                      ctrl: recordedKey.ctrl ?? false,
                      alt: recordedKey.alt ?? false,
                      name: "",
                      id: "",
                      context: "global",
                      action: "",
                    })
                  : "Press any key..."}
              </span>
              <div class="recording-buttons">
                {#if recordedKey}
                  <button class="save-btn" onclick={() => saveRecordedKey(shortcut.id)}>
                    Save
                  </button>
                {/if}
                <button class="cancel-btn" onclick={cancelRecording}>Cancel</button>
              </div>
            </div>
          {:else}
            <button
              class="shortcut-key"
              onclick={() => startRecordingKey(shortcut.id)}
            >
              {formatShortcut(shortcut)}
            </button>
          {/if}
        </div>
      {/each}
    </div>
  </div>
   </div>
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

  /* Page header — matches History / Report / Notes. */
  .page-head {
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

  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 24px;
  }
  .wrap {
    max-width: 640px;
    margin: 0 auto;
  }

  .section {
    margin: 0 0 32px;
  }
  .section:last-child {
    margin-bottom: 0;
  }

  .section-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 4px;
  }

  /* Uppercase eyebrow section titles, shared with History / Report. */
  .section-title {
    margin: 0 0 6px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  .desc {
    margin: 0 0 16px;
    font-size: 13px;
    color: var(--text-secondary);
  }

  /* Same bordered stack as .projects-list, but each row is the radio itself. */
  .perm-list {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }

  .perm-item {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    width: 100%;
    padding: 12px 14px;
    text-align: left;
    background: var(--surface-1);
    border: none;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    font: inherit;
  }

  .perm-item:last-child {
    border-bottom: none;
  }

  .perm-item:hover {
    background: var(--surface-2);
  }

  .perm-radio {
    flex-shrink: 0;
    width: 14px;
    height: 14px;
    margin-top: 2px;
    border: 1px solid var(--border);
    border-radius: 50%;
    box-sizing: border-box;
  }

  .perm-item.on .perm-radio {
    border-color: var(--accent);
    border-width: 4px;
  }

  .perm-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .perm-label {
    font-size: 13px;
    color: var(--text);
  }

  .perm-desc {
    font-size: 12px;
    color: var(--text-muted);
  }

  .projects-list {
    display: flex;
    flex-direction: column;
    gap: 0;
    margin-bottom: 16px;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }

  .project-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    background: var(--surface-1);
    border-bottom: 1px solid var(--border);
    gap: 12px;
  }

  .project-item:last-child {
    border-bottom: none;
  }

  .path {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    font-family: ui-monospace, monospace;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .remove-btn {
    flex-shrink: 0;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px;
    border-radius: 5px;
    transition: background 0.12s ease, color 0.12s ease;
  }
  .remove-btn:hover {
    background: var(--danger-bg);
    color: var(--danger);
  }

  .empty-hint {
    margin: 0 0 16px;
    padding: 12px 14px;
    font-size: 12.5px;
    color: var(--text-faint);
    background: var(--surface-1);
    border: 1px dashed var(--border-strong);
    border-radius: 8px;
  }

  .add-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    border: 1px solid var(--border);
    background: var(--surface-1);
    color: var(--text-secondary);
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.13s, color 0.13s;
  }

  .add-btn:hover {
    background: var(--surface-2);
    color: var(--text);
  }

  .error {
    margin: 12px 0 0;
    padding: 10px 12px;
    font-size: 12px;
    color: var(--danger);
    background: rgba(255, 107, 107, 0.08);
    border: 1px solid rgba(255, 107, 107, 0.25);
    border-radius: 8px;
  }

  .reset-btn {
    padding: 8px 14px;
    border: 1px solid var(--border);
    background: var(--surface-1);
    color: var(--text-secondary);
    border-radius: 8px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.13s, color 0.13s;
  }

  .reset-btn:hover {
    background: var(--surface-2);
    color: var(--text);
  }

  .shortcuts-grid {
    display: flex;
    flex-direction: column;
    gap: 0;
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }

  .shortcut-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    background: var(--surface-1);
    border-bottom: 1px solid var(--border);
    gap: 12px;
  }

  .shortcut-item:last-child {
    border-bottom: none;
  }

  .shortcut-info {
    flex: 1;
  }

  .shortcut-name {
    font-size: 13px;
    font-weight: 500;
    color: var(--text);
    margin-bottom: 2px;
  }

  .shortcut-context {
    font-size: 11px;
    color: var(--text-muted);
  }

  .shortcut-key {
    padding: 6px 10px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text-secondary);
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    font-family: ui-monospace, monospace;
    cursor: pointer;
    min-width: 80px;
    text-align: center;
    transition: background 0.13s, color 0.13s;
    white-space: nowrap;
  }

  .shortcut-key:hover {
    background: var(--surface-2);
    color: var(--text);
    border-color: var(--accent);
  }

  .recording {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .recording-text {
    padding: 6px 10px;
    background: var(--accent-soft);
    color: var(--accent-bright);
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    font-family: ui-monospace, monospace;
    min-width: 80px;
    text-align: center;
  }

  .recording-buttons {
    display: flex;
    gap: 4px;
  }

  .save-btn,
  .cancel-btn {
    padding: 4px 10px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text-secondary);
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.13s, color 0.13s;
  }

  .save-btn:hover {
    background: var(--accent-soft);
    color: var(--accent-bright);
    border-color: var(--accent);
  }

  .cancel-btn:hover {
    background: var(--danger-bg);
    color: var(--danger);
    border-color: var(--danger-line);
  }
</style>
