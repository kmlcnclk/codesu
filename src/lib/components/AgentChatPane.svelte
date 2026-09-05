<script lang="ts">
  /**
   * A Claude agent rendered as a conversation instead of a terminal — the pane behind
   * Settings → Agent interface → Chat.
   *
   * Same footprint, chrome, lifecycle and store contract as
   * {@link import("./TerminalPane.svelte")}: it occupies a rect in the split grid, starts
   * only when the agent has been explicitly launched, tears its child down when the agent
   * is slept, and falls back to the Resume placeholder. What differs is the ground truth —
   * `claude`'s own JSON frames rather than a screen reading — so turn state is reported
   * exactly (see AppState.reportTurnState) with no settle delay and no version-pinned
   * markers.
   *
   * Known gaps versus the terminal, deliberately visible rather than papered over:
   * permission prompts have no answerer yet (the session runs in `acceptEdits`), and the
   * `/` picker, `@` autocomplete and attachment tray are terminal-only for now.
   */
  import { onDestroy } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { app, STATE_META, type Agent } from "$lib/store/app.svelte";
  import {
    createAgentSession,
    type AgentSessionHandle,
  } from "$lib/agent/createAgentSession";
  import {
    applyFrame,
    freshModel,
    pushUserMessage,
    toolSummary,
    type ChatModel,
  } from "$lib/agent/protocol";
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
    rect: Rect | undefined;
    visible: boolean;
    focused: boolean;
    showHeader: boolean;
    cwd: string | null;
  } = $props();

  let handle: AgentSessionHandle | undefined;
  let started = $state(false);
  let error = $state<string | null>(null);
  let draft = $state("");
  let sending = $state(false);
  // `$state` because both are read from reactive positions (the focus effect, and the
  // frame handler's scroll pin) — a plain `let` written by bind:this would not track.
  let inputEl = $state<HTMLTextAreaElement | undefined>();
  let scroller = $state<HTMLDivElement | undefined>();
  /** Bumped by every teardown, so a `start()` still in flight discards its session. */
  let runToken = 0;

  let model = $state<ChatModel>(freshModel());

  const meta = $derived(STATE_META[agent.state]);
  const launched = $derived(app.isLaunched(agent.id));
  const style = $derived(
    rect
      ? `left:${rect.x * 100}%;top:${rect.y * 100}%;width:${rect.w * 100}%;height:${rect.h * 100}%;`
      : "",
  );

  /**
   * Per-agent isolated Claude home, exactly as the terminal path resolves it — the
   * headless child reads the same `~/.claude` through the same symlinks, so credentials,
   * settings, CLAUDE.md, skills and (crucially) the `projects/` transcripts `--resume`
   * needs are shared, while typed-prompt history stays per agent.
   */
  async function resolveEnv(): Promise<Record<string, string> | null> {
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
    // An agent must run in a KNOWN directory. `--resume` is project-scoped, so a wrong or
    // blank cwd does not just start in the wrong place — it silently resolves the session
    // id to nothing and the conversation looks gone. Refuse it here.
    if (!cwd?.trim()) {
      error = "No workspace folder set for this agent.";
      return;
    }
    if (!agent.sessionId) {
      error = "This agent has no session id yet.";
      return;
    }
    started = true;
    const token = runToken;
    try {
      const env = await resolveEnv();
      // Seed the task prompt only when creating a brand-new session (first launch),
      // matching the terminal path's rule.
      const seed = !agent.sessionStarted && agent.initialPrompt ? agent.initialPrompt : null;
      const session = await createAgentSession(agent.id, {
        sessionId: agent.sessionId,
        cwd,
        prompt: seed,
        env,
        onFrames: (frames) => {
          // Fold the WHOLE batch before yielding, so a streaming turn re-renders once per
          // batch rather than once per token.
          for (const f of frames) applyFrame(model, f);
          syncTurn();
          scrollToEnd();
        },
      });
      if (token !== runToken) {
        session.dispose(); // torn down (closed / slept) while it was starting
        return;
      }
      handle = session;
      app.markRunning(agent.id);
      // Pin the session to this exact directory so every later resume runs here.
      app.markSessionStarted(agent.id, cwd);
      if (seed) {
        pushUserMessage(model, seed);
        app.beginTurn(agent.id);
        syncTurn();
      }
    } catch (err) {
      console.error("[Codesu] headless agent failed to start", err);
      if (token === runToken) {
        error = String(err instanceof Error ? err.message : err) || "Failed to start";
        started = false;
        void app.checkWorkspacePaths();
      }
    }
  }

  /**
   * Push the frame stream's turn state into the roster.
   *
   * `idle` is never reported from here: the model only distinguishes working from done,
   * and the roster's idle means "reviewed" — which is the user's action (markReviewed),
   * not the agent's.
   */
  function syncTurn() {
    if (model.turn === "working") app.reportTurnState(agent.id, "working");
    else if (model.turn === "done") app.reportTurnState(agent.id, "done");
  }

  /** Keep the transcript pinned to the bottom unless the user has scrolled up to read. */
  function scrollToEnd() {
    const el = scroller;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight }));
  }

  async function send() {
    const text = draft.trim();
    if (!text || !handle || sending) return;
    sending = true;
    try {
      await handle.send(text);
      pushUserMessage(model, text);
      draft = "";
      app.beginTurn(agent.id);
      app.markReviewed(agent.id);
      syncTurn();
      scrollToEnd();
    } catch (err) {
      // The child is gone (crashed, or killed outside the app). Say so instead of
      // leaving a message that looks sent.
      model.items.push({
        id: `send-${Date.now()}`,
        role: "system",
        text: `Could not send: ${err instanceof Error ? err.message : err}`,
        isError: true,
      });
    } finally {
      sending = false;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    // Enter sends, ⇧Enter is a newline — the convention every chat input uses. ⌘Enter
    // also sends, for anyone coming from the terminal's habit.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  // Lifecycle mirror of TerminalPane's: start lazily once the pane is on screen AND the
  // agent has been explicitly launched; tear down the moment it is unlaunched (closed, or
  // slept by the idle reaper), keeping the Claude session for a later resume.
  $effect(() => {
    void rect;
    void visible;
    if (visible && launched) {
      // `error` latches the auto-start off: a failed spawn is retried only on request.
      if (!started && !error) start();
    } else if (!launched) {
      if (started) {
        teardown();
        started = false;
        // A resumed session replays nothing, so the transcript starts fresh. The
        // conversation itself is intact on disk — this pane just did not witness it.
        model = freshModel();
      }
      error = null;
    }
  });

  function teardown() {
    runToken++;
    handle?.dispose();
    handle = undefined;
  }

  $effect(() => {
    if (focused && visible && started) requestAnimationFrame(() => inputEl?.focus());
  });

  onDestroy(teardown);

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

  /** Collapsed/expanded state per tool call, keyed by tool_use id. */
  let openTools = $state<Record<string, boolean>>({});
  function toggleTool(id: string) {
    openTools[id] = !openTools[id];
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="pane"
  class:visible
  class:focused
  class:split={showHeader}
  {style}
  data-agent-id={agent.id}
  onpointerdown={focus}
>
  <div class="card">
    {#if showHeader}
      <div class="head">
        <span class="dot" data-state={agent.state} style="--state:{meta.color}" title={meta.label}></span>
        <span class="pane-name">{agent.name}</span>
        <div class="actions">
          <button class="act" title="Split side by side (⌘D)" aria-label="Split side by side" onclick={(e) => { e.stopPropagation(); splitRow(); }}>
            <Icon name="columns" size={14} />
          </button>
          <button class="act" title="Split stacked (⌘⇧D)" aria-label="Split stacked" onclick={(e) => { e.stopPropagation(); splitCol(); }}>
            <Icon name="rows" size={14} />
          </button>
          <span class="sep"></span>
          <button class="act close" title="Close pane" aria-label="Close pane" onclick={(e) => { e.stopPropagation(); app.removeAgent(agent.id); }}>
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>
    {/if}

    <div class="chat-wrap">
      {#if started}
        <div class="scroll" bind:this={scroller}>
          {#if model.items.length === 0 && !model.streaming}
            <p class="placeholder">
              {agent.sessionStarted
                ? "Session resumed. Earlier turns stay in the transcript on disk — send a message to continue."
                : "Ready. Send a message to start the conversation."}
            </p>
          {/if}

          {#each model.items as item (item.id)}
            {#if item.role === "user"}
              <div class="msg user"><div class="bubble">{item.text}</div></div>
            {:else if item.role === "assistant"}
              <div class="msg assistant"><div class="bubble">{item.text}</div></div>
            {:else if item.role === "thinking"}
              <details class="thinking">
                <summary>Thinking</summary>
                <pre>{item.text}</pre>
              </details>
            {:else if item.role === "tool"}
              <div class="tool" class:failed={item.isError}>
                <button class="tool-head" onclick={(e) => { e.stopPropagation(); toggleTool(item.id); }}>
                  <span class="tool-glyph">
                    {#if item.result === undefined}
                      <span class="spinner"></span>
                    {:else}
                      <Icon name={item.isError ? "close" : "check"} size={12} />
                    {/if}
                  </span>
                  <span class="tool-name">{toolSummary(item.name, item.input)}</span>
                </button>
                {#if openTools[item.id]}
                  <pre class="tool-body">{JSON.stringify(item.input, null, 2)}</pre>
                  {#if item.result !== undefined}
                    <pre class="tool-body result">{item.result}</pre>
                  {/if}
                {/if}
              </div>
            {:else}
              <div class="msg system" class:failed={item.isError}>
                <div class="bubble">{item.text}</div>
              </div>
            {/if}
          {/each}

          {#if model.streaming}
            <!-- The live tail. Replaced by the authoritative `assistant` frame the
                 moment the block completes, so it is never appended to the transcript. -->
            <div class="msg assistant streaming"><div class="bubble">{model.streaming}</div></div>
          {/if}
        </div>

        <div class="composer" class:busy={model.turn === "working"}>
          <textarea
            bind:this={inputEl}
            bind:value={draft}
            onkeydown={onKeydown}
            placeholder={model.turn === "working" ? "Claude is working — Enter to queue" : "Message Claude…  (⇧Enter for a newline)"}
            rows="1"
          ></textarea>
          <button class="send" disabled={!draft.trim() || sending} onclick={(e) => { e.stopPropagation(); send(); }} title="Send (Enter)" aria-label="Send">
            <Icon name="arrowRight" size={15} />
          </button>
        </div>

        <!-- What this interface cannot do yet, said once and quietly, rather than
             discovered when a tool call silently fails. -->
        <p class="foot">
          Chat mode · tools auto-approved (acceptEdits){model.costUsd > 0 ? ` · $${model.costUsd.toFixed(4)}` : ""}
        </p>
      {/if}

      {#if visible && error}
        <div class="failed-panel">
          <span class="fdot"></span>
          <span class="label">Couldn't start {agent.name}</span>
          <span class="reason">{error}</span>
          {#if app.isPathMissing(cwd)}
            <span class="hint">
              This workspace's folder no longer exists. Move it back, or remove the
              workspace from the sidebar.
            </span>
          {/if}
          <button class="retry" onclick={(e) => { e.stopPropagation(); error = null; }}>Retry</button>
        </div>
      {:else if visible && !started}
        <button class="resume" onclick={(e) => { e.stopPropagation(); app.launchAgent(agent.id); }}>
          <span class="rdot"></span>
          <span class="label">Resume Claude session</span>
          <span class="hint">Click to start · dormant to save resources</span>
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  /* Pane chrome is deliberately identical to TerminalPane's: switching interfaces must
     change what is INSIDE the card, not the geometry of the split grid around it. */
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
  .card {
    position: absolute;
    inset: 4px;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--surface-0, var(--term-bg));
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    transition: border-color 0.16s ease, box-shadow 0.16s ease;
  }
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
  }
  .pane.focused .head {
    background: var(--surface-3);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--state, var(--text-faint));
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
  .head:hover .actions,
  .pane.focused .actions {
    opacity: 1;
    transform: none;
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
  }
  .act:hover {
    color: var(--text);
    background: var(--surface-4);
  }
  .sep {
    width: 1px;
    height: 15px;
    margin: 0 3px;
    background: var(--border);
    flex-shrink: 0;
  }

  .chat-wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  /* ---------- transcript ---------- */

  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 14px 16px 8px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .placeholder {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--text-faint);
  }
  .msg {
    display: flex;
    max-width: 100%;
  }
  .msg.user {
    justify-content: flex-end;
  }
  .bubble {
    max-width: 82%;
    padding: 8px 12px;
    border-radius: 12px;
    font-size: 13px;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }
  .msg.user .bubble {
    background: var(--accent, #6e8bff);
    color: #fff;
    border-bottom-right-radius: 4px;
  }
  .msg.assistant .bubble {
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text);
    border-bottom-left-radius: 4px;
  }
  /* The live tail reads as provisional until its block completes. */
  .msg.assistant.streaming .bubble {
    border-style: dashed;
    color: var(--text-secondary);
  }
  .msg.system .bubble {
    max-width: 100%;
    background: transparent;
    border: 1px dashed var(--border-strong);
    color: var(--text-faint);
    font-family: ui-monospace, monospace;
    font-size: 11.5px;
  }
  .msg.system.failed .bubble {
    border-color: var(--danger, #ff6b6b);
    color: var(--danger, #ff6b6b);
  }

  .thinking {
    font-size: 12px;
    color: var(--text-faint);
  }
  .thinking summary {
    cursor: pointer;
    user-select: none;
  }
  .thinking pre {
    margin: 6px 0 0;
    padding: 8px 10px;
    background: var(--surface-1);
    border-radius: 8px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 11.5px;
    line-height: 1.5;
  }

  /* ---------- tool calls ---------- */

  .tool {
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--surface-1);
    overflow: hidden;
  }
  .tool.failed {
    border-color: var(--danger, #ff6b6b);
  }
  .tool-head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 10px;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .tool-head:hover {
    background: var(--surface-3);
  }
  .tool-glyph {
    display: grid;
    place-items: center;
    width: 16px;
    flex-shrink: 0;
    color: var(--text-faint);
  }
  .tool.failed .tool-glyph {
    color: var(--danger, #ff6b6b);
  }
  .tool-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, monospace;
  }
  .tool-body {
    margin: 0;
    padding: 8px 10px;
    border-top: 1px solid var(--border);
    background: var(--surface-0, var(--term-bg));
    font-size: 11.5px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 320px;
    overflow-y: auto;
    user-select: text;
  }
  .tool-body.result {
    color: var(--text-secondary);
  }
  .spinner {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    border: 1.5px solid var(--border-strong);
    border-top-color: var(--accent, #6e8bff);
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* ---------- composer ---------- */

  .composer {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    flex-shrink: 0;
    padding: 8px 10px;
    border-top: 1px solid var(--border);
    background: var(--surface-1);
  }
  .composer textarea {
    flex: 1;
    min-width: 0;
    max-height: 40vh;
    padding: 8px 10px;
    font: inherit;
    font-size: 13px;
    line-height: 1.5;
    color: var(--text);
    background: var(--surface-0, var(--term-bg));
    border: 1px solid var(--border);
    border-radius: 9px;
    resize: vertical;
    field-sizing: content;
  }
  .composer textarea:focus {
    outline: none;
    border-color: var(--accent, #6e8bff);
  }
  .send {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    border: none;
    border-radius: 9px;
    background: var(--accent, #6e8bff);
    color: #fff;
    cursor: pointer;
  }
  .send:disabled {
    background: var(--surface-4);
    color: var(--text-faint);
    cursor: default;
  }
  .foot {
    margin: 0;
    padding: 0 12px 7px;
    flex-shrink: 0;
    font-size: 10.5px;
    color: var(--text-faint);
    user-select: none;
  }

  /* ---------- placeholders (same footprint as TerminalPane's) ---------- */

  .resume,
  .failed-panel {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background: var(--surface-0, var(--term-bg));
    color: var(--text-muted);
  }
  .resume {
    border: none;
    cursor: pointer;
    font: inherit;
    user-select: none;
  }
  .failed-panel {
    padding: 0 28px;
    text-align: center;
  }
  .rdot,
  .fdot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }
  .rdot {
    background: var(--accent, #6e8bff);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent, #6e8bff) 22%, transparent);
  }
  .fdot {
    background: var(--danger, #ff6b6b);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--danger, #ff6b6b) 22%, transparent);
  }
  .label {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-secondary);
  }
  .resume:hover .label {
    color: var(--text);
  }
  .hint {
    max-width: 46ch;
    font-size: 12px;
    line-height: 1.45;
    color: var(--text-faint);
  }
  .reason {
    font-family: ui-monospace, monospace;
    font-size: 12px;
    color: var(--danger, #ff6b6b);
    user-select: text;
    overflow-wrap: anywhere;
  }
  .retry {
    margin-top: 4px;
    padding: 5px 14px;
    font: inherit;
    font-size: 12.5px;
    color: var(--text-secondary);
    background: var(--surface-2);
    border: 1px solid var(--border-strong);
    border-radius: 7px;
    cursor: pointer;
  }
  .retry:hover {
    color: var(--text);
    background: var(--surface-4);
  }
</style>
