<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import Icon from "./Icon.svelte";
  import { readTextFile, writeTextFile, humanSize, relPath } from "$lib/code/api";
  import { languageFor, syntaxTheme } from "$lib/code/editor";

  let {
    root,
    path,
    onDirty,
  }: {
    root: string;
    /** Absolute path of the file to show, or null for "no file open". */
    path: string | null;
    /** Reports which open files have unsaved edits, so the tab bar can dot them. */
    onDirty: (path: string, dirty: boolean) => void;
  } = $props();

  /** Per-file editor state, so switching tabs keeps undo history and cursor position. */
  type Buffer = {
    state: any;
    /** mtime the buffer was loaded/saved at — the optimistic-concurrency token. */
    modifiedMs: number;
    /** Exactly what is on disk, for the "did this actually change?" test. */
    saved: string;
    dirty: boolean;
    refused: string | null;
    size: number;
  };

  let container = $state<HTMLDivElement | null>(null);
  let view: any = null;
  /** The file currently rendered in `view` (may lag `path` during a swap). */
  let shownPath: string | null = null;
  let cm: any = null; // the CodeMirror modules, imported once
  const buffers = new Map<string, Buffer>();

  let loading = $state(false);
  let error = $state<string | null>(null);
  /** A save was refused because the file changed underneath us. */
  let conflict = $state(false);
  let refused = $state<string | null>(null);
  let refusedSize = $state(0);
  let saving = $state(false);
  /** Shown briefly after a successful save. */
  let savedFlash = $state(false);
  let dirty = $state(false);
  let cursor = $state({ line: 1, col: 1 });

  /** Load @codemirror/* once, on first use — never during SSR/prerender. */
  async function modules() {
    if (cm) return cm;
    const [state, viewMod, commands, language, search] = await Promise.all([
      import("@codemirror/state"),
      import("@codemirror/view"),
      import("@codemirror/commands"),
      import("@codemirror/language"),
      import("@codemirror/search"),
    ]);
    cm = { state, view: viewMod, commands, language, search };
    return cm;
  }

  /** Mark the current file dirty/clean and tell the parent. */
  function setDirty(p: string, value: boolean) {
    const buf = buffers.get(p);
    if (buf) buf.dirty = value;
    if (p === path) dirty = value;
    onDirty(p, value);
  }

  /** Build the editor state for one file's content. */
  async function buildState(p: string, content: string) {
    const m = await modules();
    const lang = await languageFor(p);
    const extensions = [
      m.view.lineNumbers(),
      m.view.highlightActiveLine(),
      m.view.highlightActiveLineGutter(),
      m.view.highlightSpecialChars(),
      m.view.drawSelection(),
      m.view.rectangularSelection(),
      m.view.crosshairCursor(),
      m.view.dropCursor(),
      m.view.EditorView.lineWrapping,
      m.state.EditorState.allowMultipleSelections.of(true),
      m.language.indentOnInput(),
      m.language.bracketMatching(),
      m.language.foldGutter(),
      m.commands.history(),
      m.search.highlightSelectionMatches(),
      m.view.keymap.of([
        // Save first so ⌘S never falls through to the browser's own binding.
        { key: "Mod-s", preventDefault: true, run: () => (void save(), true) },
        ...m.commands.defaultKeymap,
        ...m.search.searchKeymap,
        ...m.commands.historyKeymap,
        ...m.language.foldKeymap,
        m.commands.indentWithTab,
      ]),
      m.search.search({ top: true }),
      ...syntaxTheme,
      m.view.EditorView.updateListener.of((u: any) => {
        if (u.docChanged) {
          const buf = buffers.get(p);
          // Compare against disk rather than latching a flag: undoing back to the
          // original content should clear the dot, not leave the file looking unsaved.
          if (buf) setDirty(p, u.state.doc.toString() !== buf.saved);
        }
        if (u.selectionSet || u.docChanged) {
          const head = u.state.selection.main.head;
          const line = u.state.doc.lineAt(head);
          if (p === path) cursor = { line: line.number, col: head - line.from + 1 };
        }
      }),
      ...(lang ? [lang] : []),
    ];
    return m.state.EditorState.create({ doc: content, extensions });
  }

  /** Read `p` from disk and make a buffer for it. */
  async function load(p: string): Promise<Buffer> {
    const file = await readTextFile(root, p);
    const buf: Buffer = {
      state: await buildState(p, file.content),
      modifiedMs: file.modifiedMs,
      saved: file.content,
      dirty: false,
      refused: file.refused,
      size: file.size,
    };
    buffers.set(p, buf);
    return buf;
  }

  /** Show `p`, loading it if this is the first time (or if it was closed and reopened). */
  async function show(p: string) {
    const m = await modules();
    if (!container) return;
    error = null;
    conflict = false;
    let buf = buffers.get(p);
    if (!buf) {
      loading = true;
      try {
        buf = await load(p);
      } catch (e) {
        error = String(e);
        loading = false;
        return;
      } finally {
        loading = false;
      }
    } else if (!buf.dirty) {
      // Re-read on every focus: an agent editing this file in the background is the
      // normal case here, and silently showing a stale buffer is the one thing the
      // review workflow cannot tolerate. A DIRTY buffer is left alone — the user's
      // unsaved work wins until they choose (see the conflict bar).
      try {
        const file = await readTextFile(root, p);
        if (file.content !== buf.saved) buf = await load(p);
      } catch {
        /* the file may have been deleted; keep showing what we have */
      }
    }
    refused = buf.refused;
    refusedSize = buf.size;
    dirty = buf.dirty;
    if (buf.refused) {
      view?.destroy();
      view = null;
      shownPath = null;
      return;
    }
    if (!view) {
      view = new m.view.EditorView({ state: buf.state, parent: container });
    } else {
      view.setState(buf.state);
    }
    shownPath = p;
    view.focus();
  }

  /** Persist the current file. Returns false when the write was refused. */
  export async function save(force = false): Promise<boolean> {
    const p = path;
    if (!p || !view || saving) return false;
    const buf = buffers.get(p);
    if (!buf) return false;
    const content = view.state.doc.toString();
    saving = true;
    try {
      const mtime = await writeTextFile(root, p, content, force ? null : buf.modifiedMs);
      buf.modifiedMs = mtime;
      buf.saved = content;
      setDirty(p, false);
      conflict = false;
      savedFlash = true;
      setTimeout(() => (savedFlash = false), 1200);
      return true;
    } catch (e) {
      if (String(e).includes("changed-on-disk")) conflict = true;
      else error = String(e);
      return false;
    } finally {
      saving = false;
    }
  }

  /** Throw away local edits and take what is on disk. */
  async function reload() {
    const p = path;
    if (!p) return;
    buffers.delete(p);
    conflict = false;
    await show(p);
  }

  /** Drop a closed file's buffer so reopening it re-reads from disk. */
  export function forget(p: string) {
    buffers.delete(p);
  }

  /** Whether `p` has unsaved edits (used by the parent before closing a tab). */
  export function isDirty(p: string): boolean {
    return buffers.get(p)?.dirty ?? false;
  }

  $effect(() => {
    const p = path;
    const el = container;
    if (!el) return;
    if (!p) {
      // Keep buffers, but take the editor off screen so the empty state shows.
      untrack(() => {
        stash();
        view?.destroy();
        view = null;
        shownPath = null;
      });
      return;
    }
    // Snapshot the outgoing file before swapping — setState() inside show() would
    // otherwise discard the cursor and undo history of the tab being left.
    untrack(stash);
    void show(p);
  });

  /**
   * Copy the live view's state back into its buffer. Tracked by `shownPath` rather than
   * `path`, because by the time the swap effect runs `path` is already the INCOMING file
   * and stashing under it would overwrite the wrong buffer.
   */
  function stash() {
    if (!view || !shownPath) return;
    const buf = buffers.get(shownPath);
    if (buf) buf.state = view.state;
  }

  onDestroy(() => {
    stash();
    view?.destroy();
    view = null;
  });
</script>

<div class="editor-wrap">
  {#if conflict}
    <div class="bar conflict">
      <Icon name="alert" size={14} />
      <span>This file changed on disk since you opened it.</span>
      <button onclick={reload}>Reload from disk</button>
      <button class="danger" onclick={() => save(true)}>Overwrite</button>
    </div>
  {/if}
  {#if error}
    <div class="bar error"><Icon name="alert" size={14} /><span>{error}</span></div>
  {/if}

  {#if !path}
    <div class="empty">
      <Icon name="code" size={26} />
      <p>Pick a file from the tree to edit it here.</p>
    </div>
  {:else if refused === "too-large"}
    <div class="empty">
      <Icon name="alert" size={26} />
      <p>{relPath(root, path)} is {humanSize(refusedSize)} — too large to edit here.</p>
    </div>
  {:else if refused === "binary"}
    <div class="empty">
      <Icon name="file" size={26} />
      <p>{relPath(root, path)} is a binary file.</p>
    </div>
  {:else if loading}
    <div class="empty"><p>Loading…</p></div>
  {/if}

  <div class="cm-host" bind:this={container} onfocusout={stash} role="presentation"></div>

  {#if path && !refused}
    <div class="statusbar">
      <span class="path">{relPath(root, path)}</span>
      <span class="sp"></span>
      {#if savedFlash}<span class="ok">Saved</span>{/if}
      {#if dirty}<span class="unsaved">Unsaved — ⌘S</span>{/if}
      <span class="pos">Ln {cursor.line}, Col {cursor.col}</span>
    </div>
  {/if}
</div>

<style>
  .editor-wrap {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    position: relative;
    background: var(--term-bg);
  }
  .cm-host {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .cm-host :global(.cm-editor) {
    height: 100%;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    font-size: 12px;
    border-bottom: 1px solid var(--border);
  }
  .bar.conflict {
    background: rgba(227, 179, 65, 0.12);
    color: var(--warn);
  }
  .bar.error {
    background: var(--danger-bg);
    color: var(--danger);
  }
  .bar button {
    border: 1px solid var(--border-strong);
    background: var(--surface-3);
    color: var(--text);
    font-size: 11.5px;
    font-weight: 600;
    padding: 3px 8px;
    border-radius: 5px;
    cursor: pointer;
  }
  .bar button:hover {
    background: var(--surface-4);
  }
  .bar button.danger {
    color: var(--danger);
    border-color: var(--danger-line);
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
    font-size: 13px;
    background: var(--term-bg);
    z-index: 2;
    text-align: center;
    padding: 20px;
  }
  .empty p {
    margin: 0;
  }
  .statusbar {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 24px;
    padding: 0 10px;
    font-size: 11px;
    color: var(--text-faint);
    background: var(--surface-1);
    border-top: 1px solid var(--border);
    font-family: var(--font-mono);
  }
  .statusbar .sp {
    flex: 1;
  }
  .statusbar .path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .statusbar .ok {
    color: var(--ok);
  }
  .statusbar .unsaved {
    color: var(--warn);
  }
</style>
