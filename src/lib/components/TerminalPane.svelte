<script lang="ts">
  import { onDestroy } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { createTerminal, type TerminalHandle } from "$lib/terminal/createTerminal";
  import { app, shellQuote, STATE_META, type Agent } from "$lib/store/app.svelte";
  import {
    attach,
    attachBlob,
    attachmentsOf,
    dragState,
    forget,
    forgetAll,
    insertAgain,
    isThumbnailable,
    notices,
    pickFiles,
    registerPane,
    thumbnailSrc,
  } from "$lib/terminal/attachments.svelte";
  import { openPath } from "@tauri-apps/plugin-opener";
  import type { Rect } from "$lib/terminal/layout";
  import Icon from "./Icon.svelte";

  let {
    agent,
    rect,
    visible,
    focused,
    showHeader,
    cwd,
  }: {
    agent: Agent;
    /** Where this pane sits in the split grid (fractions of the area). */
    rect: Rect | undefined;
    /** True when this pane is a leaf of the on-screen tab. */
    visible: boolean;
    /** True when this is the focused pane (⌘D target, keyboard focus). */
    focused: boolean;
    /** Only shown when the tab is split — a lone terminal needs no pane chrome. */
    showHeader: boolean;
    cwd: string | null;
  } = $props();

  let container: HTMLDivElement;
  let handle: TerminalHandle | undefined;
  let started = $state(false);
  let seeded = false;
  /**
   * Why the process could not start (most often: the workspace folder was moved or its
   * worktree deleted, so the PTY refuses a cwd that no longer exists). Shown in the
   * pane instead of leaving a blank terminal, and it also LATCHES the auto-start
   * effect off — without that, a failing spawn would be retried on every re-render.
   * Cleared by Retry, and on teardown so a later reopen tries again.
   */
  let error = $state<string | null>(null);
  /**
   * Bumped by every teardown. `start()` is async and can be in flight for a while
   * (it waits for the pane to be laid out before sizing the PTY), so a run whose
   * token is stale by the time it finishes must throw its terminal away instead of
   * installing it — otherwise closing or sleeping an agent mid-launch would leave an
   * orphan PTY nothing holds a handle to.
   */
  let runToken = 0;

  const meta = $derived(STATE_META[agent.state]);

  // Has the user explicitly opened this agent this run? Only then may its PTY /
  // Claude session start. A restored agent (app reopen) is NOT launched, so it
  // stays dormant — preventing many Claude processes from spawning at once — until
  // clicked. (Splitting or switching into a workspace launches the relevant panes.)
  let launched = $derived(app.isLaunched(agent.id));

  /**
   * Choose the exact Claude command by checking whether the session file really
   * exists — resume if it does, create it (by id) if it doesn't. This avoids the
   * "No conversation found" error from guessing wrong. A `||` fallback covers races.
   */
  async function resolveRun(): Promise<string | null> {
    if (agent.kind === "claude" && agent.sessionId) {
      const id = agent.sessionId;
      let exists = false;
      try {
        exists = await invoke<boolean>("claude_session_exists", { sessionId: id });
      } catch {
        /* fall through to create-first */
      }
      // Seed the task prompt only when creating a brand-new session (first launch).
      seeded = !exists && !agent.sessionStarted && !!agent.initialPrompt;
      const seed = seeded ? " " + shellQuote(agent.initialPrompt!) : "";
      return exists
        ? `claude --resume ${id} || claude --session-id ${id}`
        : `claude --session-id ${id}${seed} || claude --resume ${id}`;
    }
    return app.effectiveRun(agent);
  }

  /**
   * Environment for this agent's shell.
   *
   * Claude Code keeps its typed-prompt history per PROJECT DIRECTORY, not per session, so
   * two agents in one workspace would offer each other's prompts on ↑ / ⌃R. Each Claude
   * agent therefore runs against its own config dir, assembled by the Rust side out of
   * symlinks to the real `~/.claude` (so credentials, settings, CLAUDE.md, commands,
   * skills and — crucially — the `projects/` transcripts `--resume` reads stay shared).
   *
   * Best effort by design: if the isolated home cannot be built the agent still launches,
   * just with the shared history it had before.
   */
  async function resolveEnv(): Promise<Record<string, string> | null> {
    if (agent.kind !== "claude") return null;
    try {
      return await invoke<Record<string, string>>("claude_agent_env", {
        agentId: agent.id,
        sessionId: agent.sessionId,
      });
    } catch (err) {
      console.warn("[Codesu] falling back to the shared Claude config dir", err);
      return null;
    }
  }

  async function start() {
    if (started) return;
    // An agent must run in a KNOWN directory. A null/blank cwd reaches the PTY as "no
    // cwd", which means $HOME — fine for the system terminal, but for an agent it is
    // the silent-relocation bug all over again (Claude Code then asks to trust `~`).
    // Refuse it here rather than pass it down. See AppState.cwdOf.
    if (!cwd?.trim()) {
      error = "No workspace folder set for this agent.";
      return;
    }
    started = true;
    const token = runToken;
    try {
      const run = await resolveRun();
      const env = await resolveEnv();
      const term = await createTerminal(container, agent.id, {
        run,
        cwd,
        env,
        onOutput: () => app.noteOutput(agent.id),
        onInput: (data) => {
          app.noteInput(agent.id, data);
          // Typing into the terminal counts as reviewing a finished agent.
          app.markReviewed(agent.id);
        },
      });
      if (token !== runToken) {
        term.dispose(); // torn down (closed / slept) while it was starting
        return;
      }
      handle = term;
      // Let dropped files and pasted images reach this pane's prompt.
      registerPane(agent.id, term);
      // Hand the activity monitor a window onto this terminal's live screen — that is
      // what working / blocked / done are read from (see AppState.tickMonitor).
      app.registerScreen(agent.id, (rows) => handle?.screen(rows) ?? "");
      app.markRunning(agent.id);
      // Pin the session to this exact directory so every later resume runs here —
      // `claude --resume` is cwd-scoped and would otherwise spawn an empty session.
      app.markSessionStarted(agent.id, cwd);
      // An auto-seeded first prompt is a turn the agent starts without a keystroke.
      if (seeded) app.beginTurn(agent.id);
      requestAnimationFrame(() => handle?.fit());
    } catch (err) {
      console.error("[Codesu] terminal failed to start", err);
      if (token === runToken) {
        // Surface it in the pane and allow a retry. A missing cwd is the common case:
        // the PTY rejects it rather than silently starting in $HOME (which used to make
        // Claude Code re-ask to trust the home directory on every open).
        error = String(err instanceof Error ? err.message : err) || "Failed to start";
        started = false;
        // The folder may have just disappeared — refresh the sidebar's flags too.
        void app.checkWorkspacePaths();
      }
    }
  }

  // Lazily start the PTY the first time this pane is on screen AND the user has
  // opened the agent; refit whenever it (re)appears or is resized (a divider drag
  // changes `rect`). Fit only — focus is handled separately so a resize can't steal
  // the keyboard from another pane. Gating on `launched` keeps a restored/inactive
  // agent's Claude session dormant until clicked.
  //
  // `launched` flips back to false when the idle-reaper sleeps an unused, off-screen
  // agent (see AppState.sleepAgent). We tear the PTY down then but keep the Claude
  // session — reopening resumes it via `claude --resume`, and the "Resume" placeholder
  // returns because `started` drops back to false.
  $effect(() => {
    // Reference rect so a resize re-runs this effect and refits the terminal.
    void rect;
    void visible;
    if (visible && launched) {
      // `error` latches the auto-start off: a spawn that failed is retried only when
      // the user asks (Retry), never on every re-render of the pane.
      if (!started && !error) start();
      else if (started) requestAnimationFrame(() => handle?.fit());
    } else if (!launched) {
      if (started) {
        teardown();
        started = false;
        seeded = false;
      }
      // A fresh open (Resume click) should try again from scratch.
      error = null;
    }
  });

  /** Drop the terminal and invalidate any `start()` still in flight. */
  function teardown() {
    runToken++;
    // Drop the screen reader first: once the terminal is gone the monitor has no
    // ground truth, and it must leave this agent's state alone rather than guess.
    app.unregisterScreen(agent.id);
    registerPane(agent.id, null);
    handle?.dispose();
    handle = undefined;
  }

  // Give the keyboard to whichever pane is focused (⌘D target / clicked pane).
  $effect(() => {
    if (focused && visible && started) requestAnimationFrame(() => handle?.focus());
  });

  onDestroy(teardown);

  // ---------- attachments ----------

  const attached = $derived(attachmentsOf(agent.id));
  /** e.g. files dropped on a dormant pane, waiting for it to be resumed. */
  const notice = $derived(notices[agent.id] ?? null);
  const dragOver = $derived(dragState.agentId === agent.id);
  /**
   * The attachments panel is CLOSED until you open it, and it lives off the right
   * edge — a full-width bar across the bottom sat on top of the agent's own output,
   * and no amount of translucency fixes text over text.
   *
   * It never opens itself. New attachments announce themselves on the handle instead
   * (a count, and one pulse), so the panel appearing is always something you asked
   * for and never something that covers output while you are reading it.
   */
  let trayOpen = $state(false);
  let busy = $state(false);
  let failure = $state<string | null>(null);

  function fail(err: unknown, what: string) {
    console.error(`[Codesu] ${what}`, err);
    failure = String(err instanceof Error ? err.message : err);
    setTimeout(() => (failure = null), 5000);
  }

  async function addFiles() {
    busy = true;
    try {
      await pickFiles(agent.id);
    } catch (err) {
      fail(err, "file picker failed");
    } finally {
      busy = false;
    }
  }

  /**
   * THE paste handler for this pane — it takes the whole gesture, text and images
   * alike, and xterm never sees it.
   *
   * That total ownership is the fix for the duplicate-attachment bug, and the reason
   * is worth writing down. One ⌘V of a screenshot reaches the webview as MORE THAN
   * ONE paste event (macOS offers the clipboard item in several flavours). Every
   * event that gets through to the terminal makes `claude` read the clipboard again,
   * so one paste arrived as `[Image #5] [Image #6]` — two attachments, one image.
   * Leaving any of them to xterm reopens that, so:
   *
   *   - images  -> written to a temp file, attached once, recorded in the tray
   *   - text    -> re-sent by us as a bracketed paste (what xterm would have done)
   *   - repeats -> collapsed: identical content within 1.5s is one paste
   */
  let lastPaste = { key: "", at: 0 };

  /** True when this exact payload was already pasted a moment ago. */
  function isRepeat(key: string): boolean {
    const now = Date.now();
    if (key === lastPaste.key && now - lastPaste.at < 1500) return true;
    lastPaste = { key, at: now };
    return false;
  }

  async function onPaste(e: ClipboardEvent) {
    if (!handle) return;
    e.preventDefault();
    e.stopPropagation();

    const data = e.clipboardData;
    const item = Array.from(data?.items ?? []).find(
      (i) => i.kind === "file" && i.type.startsWith("image/"),
    );
    const image = item?.getAsFile();

    if (image) {
      if (isRepeat(`img:${image.name}:${image.size}:${image.type}`)) return;
      busy = true;
      try {
        await attachBlob(agent.id, image);
      } catch (err) {
        fail(err, "could not attach the pasted image");
      } finally {
        busy = false;
      }
      return;
    }

    const text = data?.getData("text/plain") ?? "";
    if (!text) return;
    if (isRepeat(`txt:${text}`)) return;
    // A pasted path is an attachment too — record it so the tray shows it.
    if (/^\/\S+$/.test(text.trim()) && attach(agent.id, [text.trim()]).length > 0) return;
    handle.paste(text);
  }

  /*
   * Announce a new attachment on the handle: one pulse, plus the count that is always
   * there. A drop is handled by the window-level listener rather than by this
   * component, so the signal comes from watching the list grow — which also covers
   * pastes and the picker, one rule for all three.
   */
  let pulse = $state(false);
  let seen = -1;
  let pulseTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const n = attached.length;
    // The first run only records the starting length; it must not pulse for
    // attachments that were already there.
    if (seen >= 0 && n > seen) {
      pulse = true;
      clearTimeout(pulseTimer);
      pulseTimer = setTimeout(() => (pulse = false), 1400);
    }
    seen = n;
  });

  function reveal(path: string) {
    openPath(path).catch((err) => fail(err, "could not open the attachment"));
  }

  function focus() {
    app.setActiveAgent(agent.id);
    app.markReviewed(agent.id);
  }
  function splitRow() {
    focus();
    app.splitFocused("row");
  }
  function splitCol() {
    focus();
    app.splitFocused("col");
  }

  // Absolute placement from the layout rect (percentages of the area).
  const style = $derived(
    visible && rect
      ? `left:${rect.x * 100}%;top:${rect.y * 100}%;width:${rect.w * 100}%;height:${rect.h * 100}%;`
      : "",
  );
</script>

<!-- Clicking into the pane focuses it and marks a finished (done) agent as reviewed
     → idle. Blocked agents are unaffected (they clear only when Claude resumes). -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="pane"
  class:visible
  class:focused
  class:split={showHeader}
  {style}
  data-agent-id={agent.id}
  onpointerdown={focus}
  onpastecapture={onPaste}
>
  <div class="card">
  {#if showHeader}
    <div class="head">
      <span class="dot" data-state={agent.state} style="--state:{meta.color}" title={meta.label}></span>
      <span class="pane-name">{agent.name}</span>
      <div class="actions">
        <button class="act" title="Attach files" aria-label="Attach files" onclick={(e) => { e.stopPropagation(); addFiles(); }}>
          <Icon name="paperclip" size={14} />
        </button>
        <button class="act" title="Split side by side (⌘D)" aria-label="Split side by side" onclick={(e) => { e.stopPropagation(); splitRow(); }}>
          <Icon name="columns" size={14} />
        </button>
        <button class="act" title="Split stacked (⌘⇧D)" aria-label="Split stacked" onclick={(e) => { e.stopPropagation(); splitCol(); }}>
          <Icon name="rows" size={14} />
        </button>
        <button class="act" title="Flip split direction (⌘⇧E)" aria-label="Flip split direction" onclick={(e) => { e.stopPropagation(); app.flipSplitOf(agent.id); }}>
          <Icon name="flip" size={14} />
        </button>
        <span class="sep"></span>
        <button class="act close" title="Close pane" aria-label="Close pane" onclick={(e) => { e.stopPropagation(); app.removeAgent(agent.id); }}>
          <Icon name="close" size={14} />
        </button>
      </div>
    </div>
  {/if}

  <div class="term-wrap">
    <div class="term" bind:this={container}></div>

    <!--
      Attachments. A collapsed handle on the RIGHT edge, and a popover above it —
      the terminal keeps its full width and nothing is painted over the agent's
      output. The terminal only ever shows the path an agent was handed
      (paste-1788….png tells you nothing), so this is where you see what you sent.
    -->
    {#if started || notice}
      {#if trayOpen}
        <div class="tray">
          <header class="tray-head">
            <span class="tray-title">
              Attachments{attached.length > 0 ? ` · ${attached.length}` : ""}
            </span>
            <button
              class="tray-x"
              title="Close"
              aria-label="Close attachments"
              onclick={(e) => { e.stopPropagation(); trayOpen = false; }}
            >
              <Icon name="close" size={12} />
            </button>
          </header>

          <button
            class="tray-add"
            title="Attach files to {agent.name}"
            onclick={(e) => { e.stopPropagation(); addFiles(); }}
          >
            <Icon name="paperclip" size={12} />
            <span>Attach files</span>
          </button>

          {#if failure}
            <p class="tray-msg failed">{failure}</p>
          {:else if notice}
            <p class="tray-msg waiting">{notice}</p>
          {:else if busy}
            <p class="tray-msg">Attaching…</p>
          {:else if attached.length === 0}
            <p class="tray-msg">Nothing yet. Drop files on this pane, or ⌘V a screenshot.</p>
          {/if}

          {#if attached.length > 0}
            <ul class="chips">
              {#each attached as a (a.id)}
                <li class="chip">
                  <button
                    class="chip-main"
                    title="{a.path}&#10;Click to insert this path again"
                    onclick={(e) => { e.stopPropagation(); insertAgain(agent.id, a.path); }}
                  >
                    {#if a.isImage && isThumbnailable(a.path)}
                      <img class="chip-thumb" src={thumbnailSrc(a.path)} alt={a.name} loading="lazy" />
                    {:else}
                      <span class="chip-glyph"><Icon name={a.isImage ? "image" : "file"} size={13} /></span>
                    {/if}
                    <span class="chip-name">{a.name}</span>
                  </button>
                  <button
                    class="chip-act"
                    title="Open in the default app"
                    aria-label="Open attachment"
                    onclick={(e) => { e.stopPropagation(); reveal(a.path); }}
                  >
                    <Icon name="open" size={11} />
                  </button>
                  <button
                    class="chip-act danger"
                    title="Remove from this list (the agent keeps what was already sent)"
                    aria-label="Remove from list"
                    onclick={(e) => { e.stopPropagation(); forget(agent.id, a.id); }}
                  >
                    <Icon name="close" size={11} />
                  </button>
                </li>
              {/each}
            </ul>
            <button
              class="tray-clear"
              onclick={(e) => { e.stopPropagation(); forgetAll(agent.id); }}
            >
              Clear list
            </button>
          {/if}
        </div>
      {/if}

      <!-- The handle: quiet when there is nothing attached, badged when there is. -->
      <button
        class="tray-toggle"
        class:on={trayOpen}
        class:has={attached.length > 0 || !!notice}
        class:pulse
        class:waiting={!!notice}
        title={trayOpen ? "Hide attachments" : "Attachments"}
        aria-label="Attachments"
        aria-expanded={trayOpen}
        onclick={(e) => { e.stopPropagation(); trayOpen = !trayOpen; }}
      >
        <Icon name="paperclip" size={13} />
        {#if attached.length > 0}
          <span class="tray-count">{attached.length}</span>
        {:else if notice}
          <span class="tray-count waiting">!</span>
        {/if}
      </button>
    {/if}

    <!-- Drop target. Tauri owns the drag events, so this is driven by the shared
         dragState rather than by CSS :hover. -->
    {#if dragOver}
      <div class="dropzone">
        <div class="dropzone-card">
          <Icon name="paperclip" size={20} />
          <strong>Attach to {agent.name}</strong>
          <span>Release to hand the file paths to this agent</span>
        </div>
      </div>
    {/if}
    {#if visible && error}
      <!-- The process could not start. Say why, and name the folder — a moved workspace
           or a deleted worktree is by far the most common cause, and it is invisible
           otherwise. -->
      <div class="failed">
        <span class="fdot"></span>
        <span class="label">Couldn't start {agent.name}</span>
        <span class="reason">{error}</span>
        {#if app.isPathMissing(cwd)}
          <span class="hint">
            This workspace's folder no longer exists. Move it back, or remove the
            workspace from the sidebar.
          </span>
        {/if}
        <button class="retry" onclick={(e) => { e.stopPropagation(); error = null; }}>
          Retry
        </button>
      </div>
    {:else if visible && !started}
      <!-- Agent is on screen but its process hasn't started this run (e.g. a restored
           pane after reopening the app). Start it only on an explicit click so many
           agents never spin up at once. -->
      <button class="resume" onclick={(e) => { e.stopPropagation(); app.launchAgent(agent.id); }}>
        <span class="rdot"></span>
        <span class="label">
          {agent.kind === "claude" ? "Resume Claude session" : "Start agent"}
        </span>
        <span class="hint">Click to start · dormant to save resources</span>
      </button>
    {/if}
  </div>
  </div>
</div>

<style>
  .pane {
    position: absolute;
    box-sizing: border-box;
    display: none;
    min-width: 0;
    min-height: 0;
  }
  .pane.visible {
    display: block;
  }
  /* ---------- attachments ---------- */

  /* Drop target: a full-pane invitation, not a 1px border you have to hunt for. */
  .dropzone {
    position: absolute;
    inset: 0;
    z-index: 6;
    display: grid;
    place-items: center;
    border-radius: 8px;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    outline: 2px dashed var(--accent);
    outline-offset: -6px;
    /* The drag is Tauri's, not the webview's — nothing here may swallow it. */
    pointer-events: none;
  }
  .dropzone-card {
    display: grid;
    justify-items: center;
    gap: 3px;
    padding: 14px 20px;
    border-radius: 10px;
    background: var(--surface-float);
    border: 1px solid var(--border-strong);
    box-shadow: var(--shadow-md);
    color: var(--text-secondary);
    text-align: center;
  }
  .dropzone-card strong {
    font-size: 13px;
    color: var(--text);
  }
  .dropzone-card span {
    font-size: 11.5px;
    color: var(--text-faint);
  }
  .dropzone-card :global(svg) {
    color: var(--accent-bright);
  }

  /*
   * The handle: a small square on the pane's right edge. Nearly invisible until
   * hovered while nothing is attached, so an empty pane is not decorated with a
   * control you are not using.
   */
  .tray-toggle {
    position: absolute;
    right: 8px;
    bottom: 8px;
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 4px;
    height: 26px;
    padding: 0 7px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--surface-2);
    color: var(--text-faint);
    cursor: pointer;
    opacity: 0.45;
    transition: opacity 0.14s, color 0.14s, background 0.14s, border-color 0.14s;
  }
  .pane:hover .tray-toggle,
  .tray-toggle.on,
  .tray-toggle.has,
  .tray-toggle:focus-visible {
    opacity: 1;
  }
  .tray-toggle:hover {
    background: var(--surface-4);
    border-color: var(--border-strong);
    color: var(--text);
  }
  .tray-toggle.on {
    border-color: var(--accent);
    color: var(--accent-bright);
  }
  /* A new attachment landed while the panel was closed. */
  .tray-toggle.pulse {
    border-color: var(--accent);
    color: var(--accent-bright);
    animation: attach-pulse 0.7s ease-out 2;
  }
  @keyframes attach-pulse {
    0% { box-shadow: 0 0 0 0 var(--accent-glow); }
    100% { box-shadow: 0 0 0 7px transparent; }
  }
  .tray-count.waiting {
    background: var(--warn, #f2c55c);
    color: var(--on-hue, #16171a);
  }
  .tray-toggle.waiting {
    border-color: var(--warn, #f2c55c);
    color: var(--warn, #f2c55c);
    opacity: 1;
  }
  .tray-count {
    min-width: 15px;
    height: 15px;
    padding: 0 4px;
    display: grid;
    place-items: center;
    border-radius: 8px;
    background: var(--accent);
    color: var(--accent-fg);
    font-size: 10px;
    font-weight: 700;
  }

  /*
   * The panel: anchored to the right edge above its handle, OPAQUE, and only as wide
   * as it needs to be. The previous full-width translucent bar printed itself over
   * the agent's own output — two layers of text, neither readable.
   */
  .tray {
    position: absolute;
    right: 8px;
    bottom: 40px;
    z-index: 6;
    width: min(268px, calc(100% - 24px));
    max-height: min(320px, calc(100% - 60px));
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border-radius: 9px;
    background: var(--surface-float);
    border: 1px solid var(--border-strong);
    box-shadow: var(--shadow-md);
  }
  .tray-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .tray-title {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .tray-x {
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--text-faint);
    cursor: pointer;
  }
  .tray-x:hover {
    background: var(--surface-3);
    color: var(--text);
  }
  .tray-add {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 28px;
    border: 1px dashed var(--border-strong);
    border-radius: 7px;
    background: var(--surface-2);
    color: var(--text-secondary);
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
  }
  .tray-add:hover {
    background: var(--surface-3);
    border-color: var(--accent);
    color: var(--text);
  }
  .tray-msg {
    margin: 0;
    font-size: 11.5px;
    line-height: 1.4;
    color: var(--text-faint);
  }
  .tray-msg.failed {
    color: var(--danger, #ff6b6b);
  }
  .tray-msg.waiting {
    color: var(--warn, #f2c55c);
  }
  .tray-clear {
    align-self: flex-start;
    padding: 2px 6px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--text-ghost);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .tray-clear:hover {
    background: var(--surface-3);
    color: var(--text-secondary);
  }

  /* One chip per attached file: thumbnail, name, open, forget. */
  .chips {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-height: 0;
    overflow-y: auto;
    scrollbar-width: thin;
  }
  .chip {
    display: flex;
    align-items: center;
    height: 30px;
    padding-right: 2px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-2);
  }
  .chip:hover {
    border-color: var(--border-strong);
  }
  .chip-main {
    display: flex;
    align-items: center;
    gap: 7px;
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0 4px;
    border: 0;
    background: transparent;
    color: var(--text-secondary);
    font-family: inherit;
    font-size: 11.5px;
    cursor: pointer;
  }
  .chip-thumb {
    width: 22px;
    height: 22px;
    flex-shrink: 0;
    border-radius: 4px;
    object-fit: cover;
    background: var(--bg);
  }
  .chip-glyph {
    width: 22px;
    height: 22px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    border-radius: 4px;
    background: var(--surface-4);
    color: var(--text-faint);
  }
  .chip-name {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chip-main:hover .chip-name {
    color: var(--text);
  }
  .chip-act {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--text-ghost);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s, color 0.12s, background 0.12s;
  }
  .chip:hover .chip-act,
  .chip-act:focus-visible {
    opacity: 1;
  }
  .chip-act:hover {
    background: var(--surface-4);
    color: var(--text);
  }
  .chip-act.danger:hover {
    color: var(--danger, #ff6b6b);
  }

  /* The visible surface is an inset, rounded card — so split panes read as
     distinct tiles with a little breathing room instead of edge-to-edge slabs.
     The inset also forms the gap between neighbouring panes, and the hairline
     border makes the radius legible against the near-black canvas. */
  .card {
    position: absolute;
    inset: 4px;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--term-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    transition: border-color 0.16s ease, box-shadow 0.16s ease;
  }
  /* The focused pane's card lifts with a brighter neutral border and a soft dark
     depth shadow — clear which pane ⌘D / the keyboard targets, without any color. */
  .pane.split.focused .card {
    border-color: var(--border-strong);
    box-shadow: 0 6px 22px -12px rgba(0, 0, 0, 0.55);
  }

  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    flex-shrink: 0;
    padding: 0 6px 0 11px;
    background: var(--surface-1);
    border-bottom: 1px solid var(--border);
    user-select: none;
    transition: background 0.14s ease;
  }
  /* The focused pane header lifts with a slightly brighter neutral surface — enough
     to read as active without competing with the card's focus border. */
  .pane.focused .head {
    background: var(--surface-3);
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--state, var(--text-faint));
    transition: box-shadow 0.14s ease;
  }
  .dot[data-state="working"],
  .dot[data-state="blocked"] {
    animation: dot-pulse 1s ease-in-out infinite;
  }
  .dot[data-state="done"] {
    box-shadow: 0 0 7px var(--state);
  }
  @keyframes dot-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.55; transform: scale(0.82); }
  }

  .pane-name {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.1px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: color 0.14s ease;
  }
  .pane.focused .pane-name {
    color: var(--text);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 1px;
    opacity: 0;
    transform: translateX(3px);
    transition: opacity 0.14s ease, transform 0.14s ease;
  }
  /* Reveal the controls on hover, and keep them faintly present on the focused pane
     so its affordances are always discoverable. */
  .head:hover .actions {
    opacity: 1;
    transform: none;
  }
  .pane.focused .actions {
    opacity: 0.75;
    transform: none;
  }
  .pane.focused .head:hover .actions {
    opacity: 1;
  }
  .act {
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text-muted);
    border-radius: 6px;
    cursor: pointer;
    transition: color 0.12s, background 0.12s;
  }
  .act:hover {
    color: var(--text);
    background: var(--surface-4);
  }
  .act:active {
    background: var(--surface-3);
  }
  .act.close:hover {
    color: var(--danger);
    background: rgba(255, 107, 107, 0.14);
  }
  /* Thin divider setting the destructive Close apart from the split controls. */
  .sep {
    width: 1px;
    height: 15px;
    margin: 0 3px;
    background: var(--border);
    flex-shrink: 0;
  }

  .term-wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    /*
     * xterm must mount into a padding-free element: the FitAddon measures the .term
     * element's height to pick the row count, so any padding there would shift the
     * canvas down and clip the bottom row. The padding lives on this wrapper.
     */
    padding: 6px 4px 6px 10px;
    box-sizing: border-box;
  }
  .term {
    width: 100%;
    height: 100%;
  }

  /* Dormant-agent placeholder: covers the (empty) terminal until the user starts it. */
  .resume {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background: var(--term-bg);
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    font: inherit;
    user-select: none;
  }
  .resume .rdot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--accent, #6e8bff);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent, #6e8bff) 22%, transparent);
  }
  .resume .label {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-secondary);
  }
  .resume .hint {
    font-size: 12px;
    color: var(--text-faint);
  }
  .resume:hover .label {
    color: var(--text);
  }

  /* Failed-to-start placeholder — same footprint as .resume, but not itself a button
     (it holds one), and the reason is selectable so a path can be copied out. */
  .failed {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 0 28px;
    text-align: center;
    background: var(--term-bg);
    color: var(--text-muted);
  }
  .failed .fdot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--danger, #ff6b6b);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--danger, #ff6b6b) 22%, transparent);
  }
  .failed .label {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-secondary);
  }
  .failed .reason {
    font-family: ui-monospace, monospace;
    font-size: 12px;
    color: var(--danger, #ff6b6b);
    user-select: text;
    overflow-wrap: anywhere;
  }
  .failed .hint {
    max-width: 46ch;
    font-size: 12px;
    line-height: 1.45;
    color: var(--text-faint);
  }
  .failed .retry {
    margin-top: 4px;
    padding: 5px 14px;
    font: inherit;
    font-size: 12.5px;
    color: var(--text-secondary);
    background: var(--surface-2);
    border: 1px solid var(--border-strong);
    border-radius: 7px;
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }
  .failed .retry:hover {
    color: var(--text);
    background: var(--surface-4);
  }
</style>
