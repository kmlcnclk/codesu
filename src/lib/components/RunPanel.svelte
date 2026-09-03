<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { untrack } from "svelte";
  import Icon from "./Icon.svelte";
  import { createTerminal, type TerminalHandle } from "$lib/terminal/createTerminal";
  import { discoverScripts, type Script } from "$lib/code/api";

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

  let scripts = $state<Script[]>([]);
  let loadingScripts = $state(false);
  let filter = $state("");
  let custom = $state("");
  let menuOpen = $state(false);
  /** The last script run, offered as a one-click "Run again". */
  let lastScript = $state<Script | null>(null);

  const filtered = $derived(
    scripts.filter((s) => {
      const q = filter.trim().toLowerCase();
      return !q || s.name.toLowerCase().includes(q) || s.command.toLowerCase().includes(q);
    }),
  );

  /** Group the picker by where each command came from (npm, make, cargo, …). */
  const grouped = $derived(
    Object.entries(
      filtered.reduce<Record<string, Script[]>>((acc, s) => {
        (acc[s.source] ??= []).push(s);
        return acc;
      }, {}),
    ).sort(([a], [b]) => a.localeCompare(b)),
  );

  const SOURCE_LABEL: Record<string, string> = {
    npm: "package.json",
    make: "Makefile",
    cargo: "Cargo",
    gradle: "Gradle",
    go: "Go",
    python: "Python",
    shell: "Shell scripts",
  };

  async function refreshScripts() {
    if (!root) return;
    loadingScripts = true;
    try {
      scripts = await discoverScripts(root);
      error = null;
    } catch (e) {
      error = String(e);
      scripts = [];
    } finally {
      loadingScripts = false;
    }
  }

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
    menuOpen = false;
    void send(script.command, script.cwd);
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
    void refreshScripts();

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
    <div class="picker">
      <button class="pick-btn" onclick={() => (menuOpen = !menuOpen)} title="Choose a script">
        <Icon name="play" size={13} />
        <span class="pick-lbl">{lastScript ? lastScript.name : "Scripts"}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {#if menuOpen}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="backdrop" onclick={() => (menuOpen = false)} role="presentation"></div>
        <div class="menu">
          <input class="search" placeholder="Filter scripts…" bind:value={filter} />
          <div class="menu-scroll">
            {#if loadingScripts}
              <div class="menu-empty">Scanning…</div>
            {:else if !grouped.length}
              <div class="menu-empty">No runnable scripts found.</div>
            {/if}
            {#each grouped as [source, list] (source)}
              <div class="group">{SOURCE_LABEL[source] ?? source}</div>
              {#each list as s (s.id)}
                <button class="item" onclick={() => run(s)} title={s.command}>
                  <span class="item-name">{s.name}</span>
                  <span class="item-cmd">{s.command}</span>
                </button>
              {/each}
            {/each}
          </div>
          <button class="rescan" onclick={refreshScripts}>
            <Icon name="restore" size={12} /> Rescan
          </button>
        </div>
      {/if}
    </div>

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
  .picker {
    position: relative;
  }
  .pick-btn,
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
  }
  .pick-btn:hover,
  .go:hover {
    background: var(--surface-4);
    color: var(--accent-bright);
    border-color: var(--accent);
  }
  .pick-lbl {
    max-width: 190px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .stop:hover {
    color: var(--danger);
    border-color: var(--danger-line);
  }
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
  }
  .menu {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    z-index: 41;
    width: 340px;
    max-height: 380px;
    display: flex;
    flex-direction: column;
    background: var(--surface-float);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-lg);
    overflow: hidden;
  }
  .search {
    border: none;
    border-bottom: 1px solid var(--border);
    background: transparent;
    color: var(--text);
    font-size: 12px;
    padding: 8px 10px;
    outline: none;
  }
  .menu-scroll {
    overflow: auto;
    padding: 4px;
  }
  .group {
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    color: var(--text-ghost);
    padding: 7px 8px 3px;
  }
  .item {
    display: flex;
    flex-direction: column;
    gap: 1px;
    width: 100%;
    text-align: left;
    border: none;
    background: transparent;
    padding: 5px 8px;
    border-radius: 6px;
    cursor: pointer;
  }
  .item:hover {
    background: var(--surface-3);
  }
  .item-name {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text);
  }
  .item-cmd {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .menu-empty {
    padding: 14px 10px;
    font-size: 12px;
    color: var(--text-faint);
    text-align: center;
  }
  .rescan {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    border: none;
    border-top: 1px solid var(--border);
    background: transparent;
    color: var(--text-muted);
    font-size: 11.5px;
    font-weight: 600;
    padding: 7px;
    cursor: pointer;
  }
  .rescan:hover {
    background: var(--surface-3);
    color: var(--text);
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
