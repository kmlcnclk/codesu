<script lang="ts">
  /**
   * The Chat view of a Claude agent: Claude Code runs headless in the background and
   * this pane is the conversation. Layout per Settings: Transcript (tool rows inline),
   * Split (an activity rail), Simple (one line per step). Also here: the session strip
   * with the context meter and usage popover, the prompt navigator, the queue of
   * follow-ups, the output tabs of scripts and runners, and the subagent drill-in.
   */
  import { onDestroy, onMount, untrack } from "svelte";
  import { app, type Agent, type TaskAttachment } from "$lib/store/app.svelte";
  import { chatFor, toolSummary, type SubagentRun, type ToolCall, type TranscriptItem } from "$lib/chat/session.svelte";
  import { runs } from "$lib/chat/runs.svelte";
  import { attachBlob, attachmentsOf, ensureThumbnails, forget, isThumbnailable, pickFiles, setChatMode, thumbnailSrc } from "$lib/terminal/attachments.svelte";
  import ChatTranscript from "./ChatTranscript.svelte";
  import RunRail from "./RunRail.svelte";
  import Icon from "../Icon.svelte";

  let { agent, visible, cwd }: { agent: Agent; visible: boolean; cwd: string | null } = $props();

  const session = $derived(chatFor(agent.id));
  const layout = $derived(app.chatLayout);
  const project = $derived(app.projectOf(agent.workspaceId ?? ""));
  const workspace = $derived(app.workspaces.find((w) => w.id === agent.workspaceId));

  // ---- start when shown and launched (same rule as the terminal: explicit resume) ----
  // `wanted` is the latch: a stopped, failed or crashed session stays down until the
  // user starts it again, so this never restarts what was just stopped.
  const launched = $derived(app.isLaunched(agent.id));
  // Seeded with the current value: mounting this pane (switching views, reopening the
  // agent) is not a Resume click and must not restart a session the user stopped.
  let wasLaunched = untrack(() => app.isLaunched(agent.id));
  $effect(() => {
    // A Resume click (launched false → true) re-arms the latch: the user asked for it.
    if (launched && !wasLaunched) session.wanted = true;
    wasLaunched = launched;
    if (visible && launched && session.wanted && !session.running) void session.start();
  });
  // Files dropped, pasted or picked for this agent are recorded, not pasted into a
  // terminal (there is none), while this pane is the chat.
  onMount(() => setChatMode(agent.id, true));

  // ---- composer ----
  let text = $state("");
  let composerEl = $state<HTMLTextAreaElement | null>(null);
  /** Files attached but not yet sent: the composer's chips (the sent set lives on the session). */
  const pendingAtt = $derived<TaskAttachment[]>(attachmentsOf(agent.id).filter((a) => !session.sentAttachmentIds.includes(a.id)));
  let hoverAtt = $state<string | null>(null);
  const sendOnEnter = $derived(app.chatSendKey === "enter");
  const followUp = $derived(app.chatFollowUp);
  const inAgent = $derived(session.focusAgent ? session.subagentByToolUse(session.focusAgent) : null);
  const items = $derived<TranscriptItem[]>(inAgent ? inAgent.items : session.items);

  function send(mode: "default" | "other") {
    const body = text.trim();
    if (!body && pendingAtt.length === 0) return;
    const busy = session.status === "working" || session.status === "waiting";
    // Default per setting; ⌘⏎ (or Enter, when ⌘⏎ sends) does the other thing.
    const queue = busy && ((followUp === "queue") !== (mode === "other"));
    session.send(body, [...pendingAtt], session.focusAgent, queue ? "queue" : "now");
    text = "";
    autosize();
  }
  function onComposerKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey) {
      const meta = e.metaKey;
      if (sendOnEnter) {
        e.preventDefault();
        send(meta ? "other" : "default");
      } else if (meta) {
        e.preventDefault();
        send("default");
      }
      return;
    }
    if (e.key === "Escape") {
      if (session.status === "working" || session.status === "waiting") {
        e.preventDefault();
        session.interrupt();
      } else if (session.focusAgent) {
        e.preventDefault();
        session.focusAgent = null;
      }
      return;
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && e.metaKey) {
      e.preventDefault();
      stepPrompt(e.key === "ArrowUp" ? -1 : 1);
    }
  }
  function autosize() {
    const el = composerEl;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(220, Math.max(44, el.scrollHeight))}px`;
  }
  // Picking, pasting and dropping (the window-level Tauri drop routes to this pane by
  // its data-agent-id) all land in the agent's attachment list; see pendingAtt.
  async function addFiles() {
    await pickFiles(agent.id);
    ensureThumbnails(agent.id);
  }
  function removePending(id: string) {
    forget(agent.id, id);
  }
  function onPaste(e: ClipboardEvent) {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) void attachBlob(agent.id, f).then(() => ensureThumbnails(agent.id));
  }

  // ---- navigator (your messages) ----
  const userItems = $derived(items.filter((i): i is Extract<TranscriptItem, { kind: "user" }> => i.kind === "user"));
  let inViewUser = $state<string | null>(null);
  let navOpen = $state(false);
  let scrollTo = $state<string | null>(null);
  let navIndex = $state(-1);
  function stepPrompt(dir: 1 | -1) {
    if (!userItems.length) return;
    const cur = userItems.findIndex((u) => u.id === inViewUser);
    const next = Math.max(0, Math.min(userItems.length - 1, (cur < 0 ? userItems.length : cur) + dir));
    scrollTo = userItems[next].id;
  }
  function onNavKey(e: KeyboardEvent) {
    if (!navOpen) return;
    if (e.key === "ArrowDown") { e.preventDefault(); navIndex = Math.min(userItems.length - 1, navIndex + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); navIndex = Math.max(0, navIndex - 1); }
    else if (e.key === "Enter" && navIndex >= 0) { e.preventDefault(); scrollTo = userItems[navIndex].id; navOpen = false; }
    else if (e.key === "Escape") navOpen = false;
  }

  // ---- strip: usage popover ----
  let usageOpen = $state(false);
  const ctxPct = $derived(session.contextLimit ? Math.min(100, Math.round((session.contextTokens / session.contextLimit) * 100)) : 0);
  function k(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
    return String(n);
  }
  function resetsIn(ts: number): string {
    const s = Math.max(0, ts * 1000 - Date.now());
    const h = Math.floor(s / 3_600_000);
    if (h >= 48) return `${Math.round(h / 24)}d`;
    if (h >= 1) return `${h}h`;
    return `${Math.max(1, Math.round(s / 60_000))}m`;
  }
  const rateRows = $derived.by(() => {
    const labels: Record<string, string> = { five_hour: "Current session", seven_day: "Weekly · all models", seven_day_opus: "Weekly · Opus", seven_day_sonnet: "Weekly · Sonnet" };
    return Object.entries(session.rate).map(([key, w]) => ({ key, label: labels[key] ?? key.replace(/_/g, " "), pct: Math.round((w.utilization ?? 0) * 100), resets: resetsIn(w.resetsAt) }));
  });
  const statusLabel = $derived.by(() => {
    switch (session.status) {
      case "stopped": return "Stopped";
      case "starting": return "Starting";
      case "idle": return "Idle";
      case "working": return "Working";
      case "waiting": return "Waiting for you";
    }
  });
  const modelLabel = $derived((session.model ?? "").replace(/^claude-/, "").replace(/-\d{8}$/, ""));

  // ---- output tabs ----
  let activeTab = $state<string>("agent");
  const runTabs = $derived(runs.tabsFor(agent.id));
  let runRailOpen = $state(false);
  const runningRuns = $derived(runs.runningCount(agent.id));
  function mountRun(node: HTMLDivElement, tabId: string) {
    // The terminal lives in an element the run store owns, so it survives this pane
    // unmounting (every tab switch) and is simply re-appended here.
    void runs.attach(tabId, node);
    return { destroy() {} };
  }
  $effect(() => {
    if (activeTab !== "agent") requestAnimationFrame(() => runs.fit(activeTab));
  });
  function closeRun(id: string) {
    runs.close(id);
    if (activeTab === id) activeTab = "agent";
  }

  // ---- split layout: activity rail ----
  const activity = $derived.by(() => {
    const out: ToolCall[] = [];
    const scan = (list: TranscriptItem[]) => {
      for (const it of list) if (it.kind === "assistant") for (const p of it.parts) if (p.type === "tool") out.push(p);
    };
    scan(session.items);
    return out.slice(-80);
  });
  const changedFiles = $derived.by(() => {
    const files = new Map<string, number>();
    for (const t of activity) if ((t.name === "Edit" || t.name === "Write") && typeof t.input.file_path === "string") files.set(t.input.file_path, (files.get(t.input.file_path) ?? 0) + 1);
    return [...files.entries()];
  });
  function rel(p: string): string {
    return cwd && p.startsWith(cwd) ? p.slice(cwd.length + 1) : p;
  }

  // ---- view switch ----
  async function openInTerminal() {
    // The terminal resumes the same session id, so the headless copy must be gone first
    // (the mirror of the terminal's own teardown when switching to chat).
    if (session.running) await session.stop();
    app.setAgentView(agent.id, "terminal");
  }
  async function toggleSession() {
    if (session.running) await session.stop();
    else {
      session.wanted = true;
      app.launchAgent(agent.id);
      await session.start();
    }
  }
  const agentsRunning = $derived(session.subagents.filter((a) => a.status === "running").length);
  let agentsOpen = $state(false);
  function enterAgent(id: string) {
    session.focusAgent = id;
    agentsOpen = false;
  }
  onDestroy(() => {
    // The session outlives the pane: switching views or tabs must not kill Claude.
    setChatMode(agent.id, false);
  });
</script>

<svelte:window onkeydown={onNavKey} />

<div class="chat" class:simple={layout === "simple"} role="region" aria-label="Claude chat">
  <!-- output tabs (only once a run exists) -->
  {#if runTabs.length}
    <div class="otabs">
      <button class="otab" class:on={activeTab === "agent"} onclick={() => (activeTab = "agent")}><span class="d" style="background:var(--accent-bright)"></span>Agent</button>
      {#each runTabs as t (t.id)}
        <button class="otab" class:on={activeTab === t.id} onclick={() => (activeTab = t.id)}>
          <span class="d" style="background:{t.status === 'done' ? 'var(--ok)' : t.status === 'error' ? 'var(--danger)' : 'var(--accent-bright)'}"></span>{t.name}
          <kbd>{t.status === "running" || t.status === "starting" ? "running" : `${t.status} · ${Math.round(((t.endedAt ?? Date.now()) - t.startedAt) / 1000)}s`}</kbd>
          <span class="ox" role="button" tabindex="0" title="Close" onclick={(e) => { e.stopPropagation(); closeRun(t.id); }} onkeydown={(e) => e.key === "Enter" && closeRun(t.id)}><Icon name="close" size={11} /></span>
        </button>
      {/each}
    </div>
  {/if}

  <!-- strip -->
  <div class="strip">
    {#if inAgent}
      <button class="crumb" onclick={() => (session.focusAgent = null)}><span class="back"><Icon name="arrowRight" size={11} /></span> {agent.name}</button>
      <span class="sep">/</span>
      <span class="st"><span class="d" class:live={inAgent.status === "running"} style="background:{inAgent.status === 'running' ? 'var(--accent-bright)' : inAgent.status === 'error' ? 'var(--danger)' : 'var(--ok)'}"></span>Agent · {inAgent.name}</span>
      <span class="sep">·</span><span>{inAgent.status === "running" ? "running" : "done"}</span>
      <span class="sep">·</span><span>{inAgent.toolCount} tools</span>
      <span class="right">
        {#if session.pending.length}<span class="chip warn">● session needs you</span>{/if}
        <button class="btn" onclick={() => (session.focusAgent = null)}>Back to session<kbd>esc</kbd></button>
      </span>
    {:else}
      <span class="st"><span class="d" class:live={session.status === "working"} style="background:{session.status === 'waiting' ? 'var(--warn)' : session.status === 'working' ? 'var(--accent-bright)' : session.status === 'stopped' ? 'var(--text-ghost)' : 'var(--ok)'}"></span>{statusLabel}</span>
      {#if workspace}<span class="sep">·</span><span class="mono">{workspace.name}</span>{/if}
      {#if modelLabel}<span class="sep">·</span><span>{modelLabel}</span>{/if}
      {#if session.turns}<span class="sep">·</span><span>turn {session.turns} · ${session.costUsd.toFixed(2)}</span>{/if}
      {#if session.subagents.length}
        <span class="sep">·</span>
        <button class="chip" class:live={agentsRunning > 0} onclick={() => (agentsOpen = !agentsOpen)}>⑂ {session.subagents.length} agent{session.subagents.length === 1 ? "" : "s"}{agentsRunning ? ` · ${agentsRunning} running` : ""}</button>
      {/if}
      <span class="sep">·</span>
      <button class="ctx" onclick={() => (usageOpen = !usageOpen)} title="Context and usage">
        <span class="bar"><span class="fill" style="width:{ctxPct}%"></span></span>{k(session.contextTokens)} / {k(session.contextLimit)}
      </button>
      <span class="right">
        {#if session.error}<span class="chip err" title={session.error}>error</span>{/if}
        <button class="btn ghost" class:on={runRailOpen} onclick={() => (runRailOpen = !runRailOpen)} title="Scripts and runners"><Icon name="play" size={11} /> Run{#if runningRuns} <b>{runningRuns}</b>{/if}</button>
        <button class="btn ghost" onclick={toggleSession}>{session.running ? "Stop session" : "Start session"}</button>
        <button class="btn" onclick={openInTerminal}><Icon name="terminal" size={11} /> Open in terminal</button>
      </span>
    {/if}

    {#if usageOpen}
      <div class="pop" role="dialog" aria-label="Context and usage">
        <div class="pl"><span>CONTEXT</span><span class="pv">{k(session.contextTokens)}/{k(session.contextLimit)}</span></div>
        <div class="pbar"><span style="width:{ctxPct}%"></span></div>
        <div class="pf">{ctxPct}% of the window · auto-compacts near the limit</div>
        <div class="pdiv"></div>
        <div class="pl"><span>CLAUDE USAGE</span><span class="pv dim">{rateRows.length ? "" : "no data yet"}</span></div>
        {#each rateRows as r (r.key)}
          <div class="pr"><span>{r.label}</span><span class="dim">{r.pct}% · resets in {r.resets}</span></div>
          <div class="pbar"><span style="width:{r.pct}%"></span></div>
        {/each}
        {#if !rateRows.length}<div class="pf">Usage arrives with the first response of a turn.</div>{/if}
      </div>
    {/if}
    {#if agentsOpen}
      <div class="pop agents" role="dialog" aria-label="Agents in this session">
        {#each session.subagents as a (a.toolUseId)}
          <button class="arow" onclick={() => enterAgent(a.toolUseId)}>
            <span class="d" style="background:{a.status === 'running' ? 'var(--accent-bright)' : a.status === 'error' ? 'var(--danger)' : 'var(--ok)'}"></span>
            <span class="an">{a.name}</span><span class="ad">{a.description || a.prompt.split("\n")[0]}</span><span class="am">{a.status} · {a.toolCount} tools</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <!-- body -->
  <div class="body" class:with-run={runRailOpen} class:with-activity={layout === "split" && !inAgent}>
    <div class="main">
      <div class="tr" class:hidden={activeTab !== "agent"}>
        <ChatTranscript
          {session}
          {items}
          showRequests={!inAgent}
          simple={layout === "simple"}
          narrow={layout === "split"}
          onEnterAgent={enterAgent}
          onOpenRun={(id) => (activeTab = id)}
          onInView={(id) => (inViewUser = id)}
          bind:scrollTo
        />
        {#if userItems.length > 1}
          <div class="nav" role="navigation" aria-label="Your messages" onmouseenter={() => (navOpen = true)} onmouseleave={() => (navOpen = false)}>
            {#each userItems as u (u.id)}
              <button class="tick" class:on={u.id === inViewUser} title={u.text.slice(0, 80)} onclick={() => (scrollTo = u.id)}></button>
            {/each}
            {#if navOpen}
              <div class="navlist">
                {#each userItems as u, i (u.id)}
                  <button class="navrow" class:on={u.id === inViewUser} class:sel={i === navIndex} onclick={() => { scrollTo = u.id; navOpen = false; }}>{u.text.split("\n")[0] || "(attachment)"}</button>
                {/each}
                <div class="navhint">{userItems.length} messages · ↑↓ move · ⏎ jump · ⌘↑ / ⌘↓ from the box</div>
              </div>
            {/if}
          </div>
        {/if}
      </div>
      {#each runTabs as t (t.id)}
        <div class="out" class:hidden={activeTab !== t.id}>
          <div class="outbar">
            <span class="mono">{t.command}</span>
            <span class="right">
              {#if t.status === "running" || t.status === "starting"}<button class="btn danger" onclick={() => runs.stop(t.id)}><Icon name="stop" size={10} /> Stop</button>{:else if !t.sent}<button class="btn" onclick={() => runs.send(t.id)}>Send to session</button>{:else}<span class="dim">sent to session</span>{/if}
            </span>
          </div>
          <div class="outterm" use:mountRun={t.id}></div>
        </div>
      {/each}
    </div>

    {#if layout === "split" && !inAgent}
      <aside class="activity">
        <p class="al">Activity</p>
        <div class="alist">
          {#each activity.slice(-30) as t (t.id)}
            <div class="arow2" class:err={t.status === "error"}><span class="i {t.status}">{t.status === "running" ? "…" : t.status === "error" ? "!" : "✓"}</span><span class="at">{t.name} {toolSummary(t.name, t.input)}</span></div>
          {/each}
          {#if !activity.length}<p class="dim small">Nothing yet.</p>{/if}
        </div>
        {#if changedFiles.length}
          <p class="al">Changed this session</p>
          <div class="alist">
            {#each changedFiles as [f, n] (f)}
              <button class="arow2 file" onclick={() => app.openCodeFile(agent.workspaceId ?? "", f)}><span class="at">{rel(f)}</span><span class="dim">{n} edit{n === 1 ? "" : "s"}</span></button>
            {/each}
          </div>
        {/if}
      </aside>
    {/if}
    {#if runRailOpen && cwd}
      <RunRail {session} root={cwd} projectPath={project?.path ?? cwd} agentId={agent.id} onOpenTab={(id) => (activeTab = id)} />
    {/if}
  </div>

  <!-- composer -->
  {#if activeTab === "agent"}
    <div class="composer">
      {#if session.pending.length && !inAgent}
        <div class="waitbar">
          <span class="d" style="background:var(--warn)"></span><b>Claude is waiting for your answer</b><span class="dim">· {session.pending.length} open</span>
          <button class="btn" style="margin-left:auto" onclick={() => (scrollTo = userItems[userItems.length - 1]?.id ?? null)}>Show</button>
        </div>
      {/if}
      {#if session.queued.length && !inAgent}
        <div class="queue">
          <div class="qh"><span>Queued <span class="dim">· {session.queued.length} · sent when this turn ends</span></span></div>
          {#each session.queued as q (q.id)}
            <div class="qrow">
              <input class="qin" value={q.text} onchange={(e) => session.updateQueued(q.id, e.currentTarget.value)} />
              <button class="mini" title="Delete" onclick={() => session.removeQueued(q.id)}><Icon name="trash" size={12} /></button>
              <button class="mini send" onclick={() => session.sendQueued(q.id)}>Send now</button>
            </div>
          {/each}
        </div>
      {/if}
      <div class="box" class:agent={!!inAgent}>
        {#if pendingAtt.length}
          <div class="atts">
            {#each pendingAtt as a (a.id)}
              <span class="att" onmouseenter={() => (hoverAtt = a.id)} onmouseleave={() => (hoverAtt = null)} role="img" aria-label={a.name}>
                <Icon name={a.isImage ? "image" : "file"} size={12} />{a.name}
                <button class="ax" title="Remove" onclick={() => removePending(a.id)}><Icon name="close" size={10} /></button>
                {#if hoverAtt === a.id}
                  <span class="preview">{#if a.isImage && isThumbnailable(a.path)}<img src={thumbnailSrc(a.path)} alt={a.name} />{/if}<span class="pname">{a.name}</span></span>
                {/if}
              </span>
            {/each}
          </div>
        {/if}
        <textarea
          bind:this={composerEl}
          bind:value={text}
          oninput={autosize}
          onkeydown={onComposerKey}
          onpaste={onPaste}
          placeholder={inAgent ? `Message ${inAgent.name}… it reads this at its next step` : session.status === "working" ? (followUp === "queue" ? "Add a follow up · queued until this turn ends" : "Message Claude… read at its next step") : "Message Claude…"}
          rows="1"
        ></textarea>
        <div class="bar">
          <button class="btn ghost" onclick={addFiles} title="Attach files"><Icon name="paperclip" size={12} /> Attach</button>
          {#if modelLabel}<span class="pill"><span class="d" style="background:var(--ok)"></span>{modelLabel}</span>{/if}
          <span class="pill">{app.claudePermissionMode === "ask" ? "Ask every time" : app.claudePermissionMode === "edits" ? "Auto-accept edits" : "Never ask"}</span>
          <span class="hint">{sendOnEnter ? "⏎ to send · ⇧⏎ new line" : "⌘⏎ to send · ⏎ new line"}{session.status === "working" ? ` · ${sendOnEnter ? "⌘⏎" : "⏎"} to ${followUp === "queue" ? "steer now" : "queue"}` : ""}</span>
          {#if session.status === "working" || session.status === "waiting"}
            <button class="btn danger send" onclick={() => session.interrupt()}><Icon name="stop" size={10} /> Stop<kbd>esc</kbd></button>
          {:else}
            <button class="btn primary send" disabled={!text.trim() && !pendingAtt.length} onclick={() => send("default")}>Send</button>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .chat { position: absolute; inset: 0; display: flex; flex-direction: column; background: var(--term-bg); color: var(--text); }
  .hidden { display: none !important; }
  .mono { font-family: var(--font-mono); font-size: 11px; }
  .dim { color: var(--text-faint); }
  .small { font-size: 12px; }
  .d { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .d.live { box-shadow: 0 0 0 3px rgba(84, 138, 247, 0.25); }
  kbd { font-family: var(--font-sans); font-size: 10px; padding: 1px 5px; border: 1px solid var(--border-strong); border-radius: 4px; color: var(--text-muted); margin-left: 6px; }
  .btn { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 9px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text-secondary); font: inherit; font-size: 11.5px; font-weight: 600; cursor: pointer; white-space: nowrap; flex: none; }
  .btn:hover { color: var(--text); border-color: var(--border-strong); }
  .btn.ghost { background: transparent; }
  .btn.ghost.on { background: var(--accent-soft); color: var(--accent-bright); border-color: var(--accent-line); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
  .btn.primary:disabled { opacity: 0.5; cursor: default; }
  .btn.danger { color: var(--danger); border-color: rgba(247, 84, 100, 0.35); }
  .btn.danger kbd { border-color: currentColor; color: inherit; }

  .otabs { flex: none; display: flex; align-items: center; gap: 6px; padding: 6px 10px 0; }
  .otab { display: inline-flex; align-items: center; gap: 7px; height: 28px; padding: 0 10px; border-radius: 7px; border: 1px solid transparent; background: var(--surface-2); color: var(--text-muted); font: inherit; font-size: 12px; cursor: pointer; max-width: 320px; }
  .otab span:not(.d):not(.ox) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .otab.on { background: var(--accent-soft); color: var(--text); border-color: var(--accent-line); }
  .otab kbd { margin-left: 2px; }
  .ox { display: grid; place-items: center; width: 16px; height: 16px; border-radius: 4px; color: var(--text-faint); }
  .ox:hover { background: var(--surface-4); color: var(--text); }

  .strip { position: relative; flex: none; display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 12px; font-size: 11.5px; color: var(--text-muted); border-bottom: 1px solid var(--border); }
  .strip .st { display: inline-flex; align-items: center; gap: 6px; color: var(--text-secondary); font-weight: 600; white-space: nowrap; }
  .strip .sep { color: var(--border-strong); }
  .strip .right { margin-left: auto; display: flex; gap: 6px; align-items: center; }
  .crumb { display: inline-flex; align-items: center; gap: 4px; background: none; border: 0; color: var(--text-muted); font: inherit; font-size: 11.5px; cursor: pointer; padding: 0; }
  .crumb:hover { color: var(--text); }
  .back { display: inline-grid; transform: rotate(180deg); }
  .chip { display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 8px; border-radius: 6px; background: var(--surface-3); color: var(--text-secondary); border: 0; font: inherit; font-size: 11px; cursor: pointer; white-space: nowrap; }
  .chip.live { background: var(--accent-soft); color: var(--accent-bright); }
  .chip.warn { background: rgba(242, 197, 92, 0.14); color: var(--warn); }
  .chip.err { background: var(--danger-bg); color: var(--danger); }
  .ctx { display: inline-flex; align-items: center; gap: 7px; height: 20px; padding: 0 8px; border-radius: 6px; background: var(--accent-soft); color: var(--accent-bright); border: 0; font-family: var(--font-mono); font-size: 11px; cursor: pointer; white-space: nowrap; }
  .ctx .bar { width: 46px; height: 4px; border-radius: 2px; background: var(--surface-4); position: relative; overflow: hidden; }
  .ctx .fill { position: absolute; inset: 0 auto 0 0; background: var(--accent-bright); }
  .pop { position: absolute; left: 12px; top: 38px; z-index: 30; width: 360px; background: var(--surface-float); border: 1px solid var(--border-strong); border-radius: 12px; box-shadow: var(--shadow-lg); padding: 14px 18px 12px; font-family: var(--font-mono); }
  .pop.agents { left: auto; right: 12px; width: 440px; padding: 8px; font-family: var(--font-sans); }
  .pl { display: flex; justify-content: space-between; align-items: baseline; font-size: 11.5px; letter-spacing: 0.1em; color: #7c8cff; }
  .pv { color: var(--text-secondary); letter-spacing: 0; font-size: 13px; }
  .pbar { height: 4px; border-radius: 2px; background: var(--surface-4); margin: 8px 0 0; position: relative; overflow: hidden; }
  .pbar span { position: absolute; inset: 0 auto 0 0; background: #7c8cff; }
  .pf { font-size: 10.5px; color: var(--text-faint); margin-top: 6px; }
  .pdiv { border-top: 1px solid var(--border); margin: 14px 0 12px; }
  .pr { display: flex; justify-content: space-between; align-items: baseline; margin-top: 12px; font-family: var(--font-sans); font-size: 14px; color: var(--text); }
  .pr .dim { font-family: var(--font-mono); font-size: 11.5px; }
  .arow { display: grid; grid-template-columns: 8px auto 1fr auto; gap: 10px; align-items: center; width: 100%; padding: 8px 10px; border: 0; border-radius: 8px; background: transparent; color: var(--text); font: inherit; font-size: 12.5px; text-align: left; cursor: pointer; }
  .arow:hover { background: var(--surface-3); }
  .an { font-weight: 700; }
  .ad { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .am { color: var(--text-faint); font-size: 11px; white-space: nowrap; }

  .body { position: relative; flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr; }
  .body.with-activity { grid-template-columns: 1fr 280px; }
  .body.with-run { grid-template-columns: 1fr 320px; }
  .body.with-activity.with-run { grid-template-columns: 1fr 260px 320px; }
  .main { position: relative; min-width: 0; min-height: 0; }
  .tr { position: absolute; inset: 0; }
  .out { position: absolute; inset: 0; display: grid; grid-template-rows: 32px 1fr; }
  .outbar { display: flex; align-items: center; gap: 10px; padding: 0 12px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted); }
  .outbar .mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .outbar .right { margin-left: auto; display: flex; gap: 6px; }
  .outterm { position: relative; min-height: 0; }
  .outterm :global(.xterm) { position: absolute; inset: 6px 0 0 8px; }

  .nav { position: absolute; right: 14px; top: 56px; display: flex; flex-direction: column; gap: 6px; align-items: flex-end; padding: 8px 6px; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--border); z-index: 6; }
  .tick { width: 18px; height: 3px; border-radius: 2px; background: var(--surface-4); border: 0; padding: 0; cursor: pointer; }
  .tick.on { width: 26px; background: var(--accent-bright); }
  .navlist { position: absolute; right: calc(100% + 8px); top: -8px; width: 400px; max-height: 60vh; overflow: auto; background: var(--surface-float); border: 1px solid var(--border-strong); border-radius: 12px; box-shadow: var(--shadow-lg); padding: 8px 6px; }
  .navrow { display: block; width: 100%; padding: 6px 12px; border: 0; border-radius: 6px; background: transparent; color: var(--text-secondary); font: inherit; font-size: 13px; text-align: left; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .navrow:hover, .navrow.sel { background: var(--surface-3); color: var(--text); }
  .navrow.on { border-left: 2px solid var(--accent-bright); color: var(--text); }
  .navhint { padding: 6px 12px 2px; font-size: 11px; color: var(--text-faint); }

  .activity { border-left: 1px solid var(--border); background: var(--surface-1); overflow: auto; padding: 12px; font-size: 12px; }
  .al { margin: 0 0 8px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-faint); }
  .alist { display: grid; gap: 4px; margin: 0 0 16px; }
  .arow2 { display: grid; grid-template-columns: 16px 1fr auto; gap: 8px; align-items: center; min-height: 26px; padding: 0 8px; border-radius: 7px; background: var(--surface-2); border: 1px solid var(--border-muted); color: var(--text-muted); font: inherit; font-size: 12px; text-align: left; }
  .arow2.file { grid-template-columns: 1fr auto; cursor: pointer; }
  .arow2.file:hover { color: var(--text); border-color: var(--border-strong); }
  .at { font-family: var(--font-mono); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .i { width: 16px; height: 16px; border-radius: 4px; display: grid; place-items: center; font-size: 9px; font-weight: 800; }
  .i.done { background: rgba(89, 168, 105, 0.18); color: var(--ok); }
  .i.running { background: var(--accent-soft); color: var(--accent-bright); }
  .i.error { background: rgba(247, 84, 100, 0.18); color: var(--danger); }

  .composer { flex: none; padding: 8px 0 12px; border-top: 1px solid var(--border); background: var(--surface-1); }
  .waitbar { width: min(820px, 100% - 48px); margin: 0 auto 8px; display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 10px; background: rgba(242, 197, 92, 0.1); border: 1px solid rgba(242, 197, 92, 0.45); font-size: 12.5px; color: var(--text); }
  .queue { width: min(820px, 100% - 48px); margin: 0 auto 8px; border: 1px solid var(--border-strong); border-radius: 12px; background: var(--surface-2); overflow: hidden; }
  .qh { padding: 8px 14px; font-size: 12.5px; color: var(--text-muted); border-bottom: 1px solid var(--border); }
  .qrow { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; align-items: center; padding: 6px 10px 6px 14px; border-bottom: 1px solid var(--border); }
  .qrow:last-child { border-bottom: 0; }
  .qin { min-width: 0; border: 0; background: transparent; color: var(--text); font: inherit; font-size: 13px; outline: none; }
  .mini { height: 24px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-1); color: var(--text-muted); font: inherit; font-size: 11.5px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; }
  .mini.send { background: var(--accent-soft); color: var(--accent-bright); border-color: transparent; }
  .box { width: min(820px, 100% - 48px); margin: 0 auto; border: 1px solid var(--border-strong); border-radius: 12px; background: var(--surface-2); padding: 10px 12px 8px; display: grid; gap: 8px; }
  .box:focus-within { box-shadow: 0 0 0 3px rgba(53, 116, 240, 0.14); border-color: var(--accent-line); }
  .box.agent { border-color: rgba(84, 138, 247, 0.6); }
  .simple .box, .simple .queue, .simple .waitbar { width: min(680px, 100% - 48px); }
  textarea { width: 100%; box-sizing: border-box; min-height: 44px; max-height: 220px; resize: none; border: 0; outline: 0; background: transparent; color: var(--text); font: inherit; font-size: 13.5px; line-height: 1.5; }
  .bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .pill { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--border); font-size: 11px; color: var(--text-muted); }
  .pill .d { width: 6px; height: 6px; }
  .hint { font-size: 11px; color: var(--text-faint); }
  .send { margin-left: auto; height: 28px; padding: 0 12px; font-size: 12.5px; }
  .atts { display: flex; gap: 6px; flex-wrap: wrap; }
  .att { position: relative; display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 6px 0 9px; border-radius: 6px; background: var(--surface-1); border: 1px solid var(--border-strong); font-size: 12px; color: var(--text); white-space: nowrap; }
  .ax { display: grid; place-items: center; width: 16px; height: 16px; border: 0; border-radius: 4px; background: transparent; color: var(--text-faint); cursor: pointer; }
  .ax:hover { background: var(--surface-4); color: var(--text); }
  .preview { position: absolute; left: 0; bottom: calc(100% + 6px); z-index: 20; width: 320px; background: var(--surface-float); border: 1px solid var(--border-strong); border-radius: 10px; box-shadow: var(--shadow-lg); overflow: hidden; display: grid; }
  .preview img { max-width: 100%; max-height: 220px; object-fit: contain; background: #0b0c0e; }
  .pname { padding: 8px 10px; font-size: 12px; white-space: normal; }
</style>
