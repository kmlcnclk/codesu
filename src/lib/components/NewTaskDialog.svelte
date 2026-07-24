<script lang="ts">
  import { convertFileSrc, invoke } from "@tauri-apps/api/core";
  import { open } from "@tauri-apps/plugin-dialog";
  import { openPath } from "@tauri-apps/plugin-opener";
  import Modal from "./Modal.svelte";
  import Icon from "./Icon.svelte";
  import MarkdownEditor from "./MarkdownEditor.svelte";
  import {
    app,
    makeAttachment,
    TASK_STATUSES,
    TASK_META,
    type TaskItem,
    type TaskStatus,
    type TaskAttachment,
  } from "$lib/store/app.svelte";

  let {
    task,
    initialStatus,
    onClose,
  }: { task?: TaskItem; initialStatus?: TaskStatus; onClose: () => void } = $props();

  // Freshly mounted per target, so capturing initial values once is intentional.
  // svelte-ignore state_referenced_locally
  const initial = task;
  const editing = !!initial;
  let title = $state(initial?.title ?? "");
  let details = $state(initial?.details ?? "");
  // svelte-ignore state_referenced_locally
  let status = $state<TaskStatus>(initial?.status ?? initialStatus ?? "backlog");
  let attachments = $state<TaskAttachment[]>(initial ? [...initial.attachments] : []);

  // The asset protocol scope is empty by default; grant access per image the
  // moment it appears (newly attached or loaded from a saved task) so the
  // webview can thumbnail only these files, never the whole filesystem.
  let allowed = $state<Set<string>>(new Set());
  const requested = new Set<string>();
  $effect(() => {
    for (const a of attachments) {
      if (!a.isImage || requested.has(a.path)) continue;
      requested.add(a.path);
      const p = a.path;
      invoke("allow_asset", { path: p })
        .then(() => (allowed = new Set(allowed).add(p)))
        .catch((e) => console.error("[Codesu] allow_asset failed", e));
    }
  });

  async function addFiles() {
    const picked = await open({ multiple: true, title: "Attach files to task" });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    const have = new Set(attachments.map((a) => a.path));
    for (const p of paths) {
      if (typeof p === "string" && !have.has(p)) attachments.push(makeAttachment(p));
    }
  }

  function removeAttachment(id: string) {
    attachments = attachments.filter((a) => a.id !== id);
  }

  function openAttachment(a: TaskAttachment) {
    openPath(a.path).catch((e) => console.error("[Codesu] openPath failed", e));
  }

  function save() {
    if (!title.trim()) return;
    const patch = { title, details, status, attachments: $state.snapshot(attachments) };
    if (task) app.updateTask(task.id, patch);
    else app.addTask(patch);
    onClose();
  }
</script>

<Modal title={editing ? "Edit task" : "New task"} {onClose} width={720}>
  <div class="form">
    <label class="field">
      <span class="lbl">Title</span>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="input title-input"
        bind:value={title}
        placeholder="e.g. Fix flaky login test"
        autofocus
        onkeydown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && save()}
      />
    </label>

    <div class="field">
      <span class="lbl">Status</span>
      <div class="statuses" role="radiogroup" aria-label="Status">
        {#each TASK_STATUSES as s}
          {@const m = TASK_META[s]}
          <button
            type="button"
            class="status-opt"
            class:on={status === s}
            style="--c:{m.color}"
            role="radio"
            aria-checked={status === s}
            onclick={() => (status = s)}
          >
            <span class="sd"></span>{m.label}
          </button>
        {/each}
      </div>
    </div>

    <label class="field">
      <span class="lbl">Details <em>(Markdown · handed to the agent as its opening prompt)</em></span>
      <MarkdownEditor
        value={details}
        minHeight="240px"
        placeholder="Describe what needs doing, acceptance criteria, links…"
        oninput={(v) => (details = v)}
      />
    </label>

    <div class="field">
      <div class="lbl-row">
        <span class="lbl">Attachments <em>(images, docs — shared with the agent)</em></span>
        <button type="button" class="add-files" onclick={addFiles}>
          <Icon name="paperclip" size={13} /> Add files
        </button>
      </div>

      {#if attachments.length === 0}
        <button type="button" class="dropzone" onclick={addFiles}>
          <Icon name="paperclip" size={18} />
          <span>Attach images or documents</span>
        </button>
      {:else}
        <ul class="atts">
          {#each attachments as a (a.id)}
            <li class="att" class:img={a.isImage}>
              <button type="button" class="att-open" title={a.path} onclick={() => openAttachment(a)}>
                {#if a.isImage && allowed.has(a.path)}
                  <img class="thumb" src={convertFileSrc(a.path)} alt={a.name} loading="lazy" />
                {:else}
                  <span class="doc"><Icon name="file" size={18} /></span>
                {/if}
                <span class="att-name">{a.name}</span>
              </button>
              <button
                type="button"
                class="att-x"
                title="Remove"
                aria-label="Remove attachment"
                onclick={() => removeAttachment(a.id)}
              >
                <Icon name="close" size={12} />
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <div class="actions">
      <button type="button" class="btn ghost" onclick={onClose}>Cancel</button>
      <button type="button" class="btn primary" disabled={!title.trim()} onclick={save}>
        {editing ? "Save task" : "Add task"}
      </button>
    </div>
  </div>
</Modal>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .lbl,
  .lbl-row {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
  }
  .lbl-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .lbl em {
    font-style: normal;
    color: var(--text-faint);
    font-weight: 400;
  }
  .input {
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-sm);
    padding: 10px 12px;
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
  .title-input {
    font-size: 15px;
    font-weight: 600;
    padding: 11px 13px;
  }

  /* status segmented picker */
  .statuses {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .status-opt {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 7px 12px;
    border: 1px solid var(--border-strong);
    border-radius: var(--r-sm);
    background: var(--bg);
    color: var(--text-secondary);
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    transition: border-color var(--t-fast), background var(--t-fast), color var(--t-fast);
  }
  .status-opt .sd {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--c);
  }
  .status-opt:hover {
    border-color: var(--border-strong);
    background: var(--surface-2);
    color: var(--text);
  }
  .status-opt.on {
    border-color: color-mix(in srgb, var(--c) 60%, transparent);
    background: color-mix(in srgb, var(--c) 15%, var(--bg));
    color: var(--text);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c) 30%, transparent);
  }

  /* attachments */
  .add-files {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--border-strong);
    background: var(--surface-2);
    color: var(--text-secondary);
    border-radius: var(--r-sm);
    padding: 5px 10px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: border-color var(--t-fast), color var(--t-fast), background var(--t-fast);
  }
  .add-files:hover {
    border-color: var(--accent-line);
    color: var(--text);
    background: var(--surface-3);
  }
  .dropzone {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    width: 100%;
    padding: 20px;
    border: 1.5px dashed var(--border-strong);
    border-radius: var(--r-md);
    background: var(--bg);
    color: var(--text-faint);
    font-size: 12.5px;
    cursor: pointer;
    transition: border-color var(--t-fast), color var(--t-fast);
  }
  .dropzone:hover {
    border-color: var(--accent-line);
    color: var(--text-secondary);
  }
  .atts {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 8px;
  }
  .att {
    position: relative;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    background: var(--surface-1);
    overflow: hidden;
    transition: border-color var(--t-fast);
  }
  .att:hover {
    border-color: var(--border-strong);
  }
  .att-open {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 8px 9px;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    text-align: left;
    cursor: pointer;
  }
  .thumb {
    width: 40px;
    height: 40px;
    border-radius: var(--r-xs);
    object-fit: cover;
    background: var(--surface-3);
    flex-shrink: 0;
  }
  .doc {
    width: 40px;
    height: 40px;
    display: grid;
    place-items: center;
    border-radius: var(--r-xs);
    background: var(--surface-3);
    color: var(--accent-bright);
    flex-shrink: 0;
  }
  .att-name {
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .att-x {
    position: absolute;
    top: 5px;
    right: 5px;
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border: none;
    border-radius: 50%;
    background: color-mix(in srgb, var(--bg) 70%, transparent);
    color: var(--text-muted);
    cursor: pointer;
    opacity: 0;
    transition: opacity var(--t-fast), color var(--t-fast), background var(--t-fast);
  }
  .att:hover .att-x {
    opacity: 1;
  }
  .att-x:hover {
    background: var(--danger-bg);
    color: var(--danger);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 2px;
  }
  .btn {
    border-radius: var(--r-sm);
    padding: 9px 16px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid transparent;
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
    opacity: 0.55;
    cursor: default;
  }
</style>
