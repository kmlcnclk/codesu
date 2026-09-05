<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { untrack } from "svelte";
  import Icon from "./Icon.svelte";
  import { createTerminal, type TerminalHandle } from "$lib/terminal/createTerminal";
  import type { Script } from "$lib/code/api";

  let {
    workspaceId,
    root,
  }: {
    workspaceId: string;
    /** Workspace folder — the shell's working directory. */
    root: string;
  } = $props();

  /**
   * One long-lived shell per workspace, keyed so switching workspaces (or leaving and
   * coming back to the Code view) keeps each one's scrollback and running process.
   */
  const ptyId = $derived(`run:${workspaceId}`);

  let container = $state<HTMLDivElement | null>(null);
  let terminal: TerminalHandle | null = null;
  /** The workspace the live terminal belongs to, so a switch tears the old one down. */
  let terminalFor: string | null = null;
  let starting = false;
  let error = $state<string | null>(null);

  let custom = $state("");
  /** The last script run — from the editor's Run gutter — offered as "Run again". */
  let lastScript = $state<Script | null>(null);

  async function ensureTerminal() {
    if (terminal && terminalFor === workspaceId) return terminal;
    if (starting || !container) return null;
    if (terminal) {
      terminal.dispose();
      terminal = null;
    }
    starting = true;
    try {
      terminal = await createTerminal(container, ptyId, { shell: null, cwd: root, run: null });
      terminalFor = workspaceId;
      error = null;
      return terminal;
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
      return null;
    } finally {
      starting = false;
    }
  }

  /**
   * Type a command into the run shell.
   *
   * `cd` first so a sub-project's script (a monorepo package, `src-tauri`) runs where it
   * was discovered rather than at the workspace root, and the shell is left in that
   * directory for whatever the user types next.
   */
  async function send(line: string, cwd: string) {
    const term = await ensureTerminal();
    if (!term) return;
    const prefix = cwd && cwd !== root ? `cd ${quote(cwd)} && ` : "";
    try {
      await invoke("write_pty", { id: ptyId, data: `${prefix}${line}\n` });
    } catch (e) {
      error = String(e);
      return;
    }
    term.focus();
  }

  /** Single-quote a path for the shell (paths can hold spaces and `$`). */
  function quote(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
  }

  function run(script: Script) {
    lastScript = script;
    void send(script.command, script.cwd);
  }

  /**
   * Run a script the panel didn't discover — the editor's Run-gutter arrow.
   *
   * Goes through `run` so the test becomes the "Run again" target, which is what makes
   * re-running the last test one click (or the Run panel's own shell history) away.
   */
  export function runScript(script: Script) {
    run(script);
  }

  function runCustom() {
    const line = custom.trim();
    if (!line) return;
    custom = "";
    void send(line, root);
  }

  /**
   * Ctrl-C (0x03) into the shell — interrupts whatever is running while leaving the
   * terminal, its scrollback and its working directory intact, which is what you want
   * between two runs of the same script.
   */
  async function stop() {
    try {
      await invoke("write_pty", { id: ptyId, data: "\u0003" });
    } catch {
      /* the shell may already be gone */
    }
  }

  /** Does this panel have a layout box? (Same test SystemTerminalView uses.) */
  const isShown = () => !!container && container.clientWidth > 0 && container.clientHeight > 0;

  $effect(() => {
    const el = container;
    const ws = workspaceId;
    if (!el || !ws) return;

    // The panel is collapsed/expanded and the whole view is toggled with `display`, so
    // watch for it gaining a box and (re)fit then — a terminal created at zero size
    // would hand the PTY an 80x24 grid it never recovers from.
    const sync = () => {
      if (!isShown()) return;
      if (!terminal || terminalFor !== ws) void ensureTerminal();
      else setTimeout(() => terminal?.fit(), 60);
    };
    const observer = new MutationObserver(sync);
    for (let node: HTMLElement | null = el; node; node = node.parentElement) {
      observer.observe(node, { attributes: true, attributeFilter: ["style", "class", "hidden"] });
    }
    const ro = new ResizeObserver(() => terminal?.fit());
    ro.observe(el);
    untrack(sync);

    return () => {
      observer.disconnect();
      ro.disconnect();
    };
  });

  // Separate from the effect above: that one re-runs on a workspace switch (where the
  // terminal must survive until `ensureTerminal` replaces it), this one runs only when
  // the component itself goes away.
  $effect(() => () => {
    terminal?.dispose();
    terminal = null;
  });
</script>

<div class="run-panel">
  <div class="bar">
    {#if lastScript}
      <button class="go" onclick={() => run(lastScript!)} title={lastScript.command}>
        <Icon name="play" size={12} /> Run again
      </button>
    {/if}

    <form
      class="custom"
      onsubmit={(e) => {
        e.preventDefault();
        runCustom();
      }}
    >
      <input placeholder="Run a command…" bind:value={custom} spellcheck="false" />
    </form>

    <button class="stop" onclick={stop} title="Send Ctrl-C to the running command">
      <Icon name="stop" size={12} /> Stop
    </button>
  </div>

  {#if error}
    <div class="err"><Icon name="alert" size={13} />{error}</div>
  {/if}

  <div class="term" bind:this={container}></div>
</div>

<style>
  .run-panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    background: var(--term-bg);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 34px;
    padding: 0 10px;
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .go,
  .stop {
    display: flex;
    align-items: center;
    gap: 5px;
    border: 1px solid var(--border-strong);
    background: var(--surface-3);
    color: var(--text-secondary);
    font-size: 11.5px;
    font-weight: 600;
    padding: 4px 9px;
    border-radius: 6px;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .go:hover {
    background: var(--surface-4);
    color: var(--accent-bright);
    border-color: var(--accent);
  }
  .stop:hover {
    background: var(--danger-bg);
    color: var(--danger);
    border-color: var(--danger-line);
  }
  .custom {
    flex: 1;
    min-width: 80px;
    display: flex;
  }
  .custom input {
    flex: 1;
    min-width: 0;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 11.5px;
    padding: 4px 8px;
    border-radius: 6px;
    outline: none;
  }
  .custom input:focus {
    border-color: var(--accent);
  }
  .err {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    font-size: 11.5px;
    color: var(--danger);
    background: var(--danger-bg);
  }
  .term {
    flex: 1;
    min-height: 0;
    position: relative;
    overflow: hidden;
  }
</style>
