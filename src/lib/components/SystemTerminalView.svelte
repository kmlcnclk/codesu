<script lang="ts">
  import { untrack } from "svelte";
  import { createTerminal, type TerminalHandle } from "$lib/terminal/createTerminal";
  import { app } from "$lib/store/app.svelte";

  let container = $state<HTMLDivElement | null>(null);
  let terminal = $state<TerminalHandle | null>(null);
  let error = $state<string | null>(null);

  /** Last known visibility, so each show/hide is acted on exactly once. */
  let shown = false;
  /** A `createTerminal` is in flight — it must not be started twice. */
  let starting = false;

  /**
   * Does this view have a layout box? The same test createTerminal uses: an element
   * under a `display:none` ancestor generates no box, so its client size is 0.
   */
  const isShown = () => !!container && container.clientWidth > 0 && container.clientHeight > 0;

  /**
   * Spawn the login shell — LAZILY, the first time the terminal is actually looked at.
   * This view is mounted for the whole life of the app (hidden behind `display:none`, so
   * the PTY and its scrollback survive switching away), and starting it on mount meant
   * every launch spawned a shell the user may never open. It also started it at the wrong
   * size: createTerminal's waitForLayout would burn its full timeout on a hidden pane and
   * fall through to xterm's 80x24 default.
   */
  async function start() {
    if (terminal || starting || !container) return;
    starting = true;
    try {
      terminal = await createTerminal(container, "system-terminal", {
        shell: null,
        cwd: null,
        run: null,
      });
      if (app.terminalScrollPos > 0) terminal.setScrollPosition(app.terminalScrollPos);
      terminal.focus();
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
      console.error("[Codesu] Failed to create terminal:", e);
    } finally {
      starting = false;
    }
  }

  function saveScroll() {
    if (!terminal) return;
    app.terminalScrollPos = terminal.getScrollPosition();
    app.persist();
  }

  /** Shown: start the shell, or bring an existing one back to the right size. */
  function onShow() {
    if (!terminal) {
      void start();
      return;
    }
    // A frame after the display flip, so the pane has its real size to fit to.
    setTimeout(() => {
      terminal?.fit();
      if (app.terminalScrollPos > 0) terminal?.setScrollPosition(app.terminalScrollPos);
      terminal?.focus();
    }, 100);
  }

  function sync() {
    const now = isShown();
    if (now === shown) return;
    shown = now;
    if (now) onShow();
    else saveScroll(); // hidden: remember where the user was reading
  }

  /**
   * Watch for the show/hide flip. The toggle is an inline `display` on a WRAPPER div a
   * couple of levels up (see +page.svelte), not on this component's own parent — the
   * previous code observed `container.parentElement` and so never saw a single mutation.
   * Rather than hard-code a depth, every ancestor's visibility-bearing attributes are
   * watched and the answer is taken from the layout box itself.
   *
   * Deliberately depends on `container` ALONE. `terminal` is `$state` (it is this
   * component's state, and `sync` runs off it), which is exactly why the reads of it
   * below are kept out of this effect's tracking scope: were assigning it to re-run the
   * effect, the teardown would dispose the terminal that had just been created.
   */
  $effect(() => {
    const el = container;
    if (!el) return;

    const observer = new MutationObserver(() => sync());
    for (let node: HTMLElement | null = el; node; node = node.parentElement) {
      observer.observe(node, { attributes: true, attributeFilter: ["style", "class", "hidden"] });
    }
    untrack(sync); // the view may already be the one on screen at mount

    return () => {
      observer.disconnect();
      saveScroll(); // the component is really going away — keep the reading position
      terminal?.dispose();
    };
  });
</script>

<div class="view">
  <div class="terminal-container" bind:this={container}>
    {#if error}
      <div class="error">{error}</div>
    {/if}
  </div>
</div>

<style>
  .view {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    background: var(--term-bg);
  }

  .terminal-container {
    position: absolute;
    inset: 0;
    background: var(--term-bg);
  }

  .error {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--danger);
    font-size: 13px;
    padding: 20px;
    text-align: center;
  }
</style>
