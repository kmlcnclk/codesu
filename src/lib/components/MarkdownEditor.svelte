<script lang="ts">
  import { tick } from "svelte";
  import Icon from "./Icon.svelte";
  import { renderMarkdown, applyMdFormat, type MdAction } from "$lib/markdown";

  let {
    value = "",
    placeholder = "",
    minHeight = "160px",
    autofocus = false,
    grow = false,
    preview = $bindable(false),
    oninput,
    onselect,
    onPreviewChange,
  }: {
    value?: string;
    placeholder?: string;
    minHeight?: string;
    autofocus?: boolean;
    /** Fill the parent's available height (parent must be a flex column). */
    grow?: boolean;
    /** Preview vs edit mode. Pass one-way + onPreviewChange to persist it (e.g. per note). */
    preview?: boolean;
    oninput?: (value: string) => void;
    onselect?: (text: string) => void;
    onPreviewChange?: (preview: boolean) => void;
  } = $props();

  function togglePreview() {
    preview = !preview;
    onPreviewChange?.(preview);
  }

  let ta = $state<HTMLTextAreaElement>();

  const TOOLS: { action: MdAction; icon: string; label: string; key?: string }[] = [
    { action: "bold", icon: "bold", label: "Bold", key: "⌘B" },
    { action: "italic", icon: "italic", label: "Italic", key: "⌘I" },
    { action: "code", icon: "code", label: "Code" },
    { action: "h1", icon: "h1", label: "Heading 1" },
    { action: "h2", icon: "h2", label: "Heading 2" },
    { action: "ul", icon: "list", label: "Bullet list" },
    { action: "ol", icon: "listOrdered", label: "Numbered list" },
    { action: "quote", icon: "quote", label: "Quote" },
    { action: "link", icon: "link", label: "Link" },
  ];

  async function apply(action: MdAction) {
    const el = ta;
    if (!el) return;
    const res = applyMdFormat(el.value, el.selectionStart, el.selectionEnd, action);
    oninput?.(res.value);
    await tick();
    el.focus();
    el.setSelectionRange(res.selStart, res.selEnd);
  }

  function onKeydown(e: KeyboardEvent) {
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    if (k === "b") {
      e.preventDefault();
      apply("bold");
    } else if (k === "i") {
      e.preventDefault();
      apply("italic");
    }
  }
</script>

<div class="md-editor" class:grow>
  <div class="md-toolbar">
    <div class="tool-group">
      {#each TOOLS as t (t.action)}
        <button
          type="button"
          class="tool"
          title={t.label + (t.key ? ` (${t.key})` : "")}
          aria-label={t.label}
          disabled={preview}
          onclick={() => apply(t.action)}
        >
          <Icon name={t.icon} size={15} />
        </button>
      {/each}
    </div>
    <button
      type="button"
      class="preview-toggle"
      class:on={preview}
      title={preview ? "Back to editing" : "Preview"}
      onclick={togglePreview}
    >
      <Icon name={preview ? "edit" : "eye"} size={14} />
      {preview ? "Edit" : "Preview"}
    </button>
  </div>

  {#if preview}
    <div class="md preview-pane" style:min-height={minHeight}>
      {#if value.trim()}
        {@html renderMarkdown(value)}
      {:else}
        <span class="preview-empty">Nothing to preview.</span>
      {/if}
    </div>
  {:else}
    <!-- svelte-ignore a11y_autofocus -->
    <textarea
      bind:this={ta}
      bind:value
      class="md-input"
      style:min-height={minHeight}
      {placeholder}
      {autofocus}
      oninput={(e) => oninput?.(e.currentTarget.value)}
      onkeydown={onKeydown}
      onmouseup={(e) => {
        const el = e.currentTarget as HTMLTextAreaElement;
        const selected = el.value.substring(el.selectionStart, el.selectionEnd);
        onselect?.(selected);
      }}
      onkeyup={(e) => {
        const el = e.currentTarget as HTMLTextAreaElement;
        const selected = el.value.substring(el.selectionStart, el.selectionEnd);
        onselect?.(selected);
      }}
    ></textarea>
  {/if}
</div>

<style>
  .md-editor {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-strong);
    border-radius: var(--r-md);
    background: var(--bg);
    overflow: hidden;
    transition: border-color var(--t-fast);
  }
  .md-editor.grow {
    flex: 1;
    min-height: 0;
  }
  .md-editor:focus-within {
    border-color: var(--accent-line);
  }
  /* When growing, the input/preview fill the remaining height. */
  .md-editor.grow .md-input,
  .md-editor.grow .preview-pane {
    flex: 1;
    min-height: 0;
    resize: none;
  }
  .md-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 5px 7px;
    border-bottom: 1px solid var(--border-muted);
    background: var(--surface-1);
  }
  .tool-group {
    display: flex;
    align-items: center;
    gap: 1px;
    flex-wrap: wrap;
  }
  .tool {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    border-radius: var(--r-sm);
    cursor: pointer;
    transition: background var(--t-fast), color var(--t-fast);
  }
  .tool:hover:not(:disabled) {
    background: var(--surface-3);
    color: var(--text);
  }
  .tool:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .preview-toggle {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 1px solid var(--border-strong);
    background: transparent;
    color: var(--text-secondary);
    font-size: 11.5px;
    font-weight: 600;
    padding: 5px 10px;
    border-radius: var(--r-sm);
    cursor: pointer;
    flex-shrink: 0;
    transition: background var(--t-fast), color var(--t-fast), border-color var(--t-fast);
  }
  .preview-toggle:hover {
    color: var(--text);
    background: var(--surface-3);
  }
  .preview-toggle.on {
    border-color: var(--accent-line);
    color: var(--text);
    background: var(--surface-3);
  }
  .md-input {
    border: none;
    background: transparent;
    color: var(--text);
    font-size: 13.5px;
    line-height: 1.6;
    font-family: inherit;
    outline: none;
    resize: vertical;
    padding: 12px 14px;
  }
  .md-input::placeholder {
    color: var(--text-ghost);
  }
  .preview-pane {
    padding: 12px 14px;
    overflow-y: auto;
  }
  .preview-empty {
    color: var(--text-ghost);
    font-size: 13px;
    font-style: italic;
  }
</style>
