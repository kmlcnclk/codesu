<script lang="ts">
  /**
   * One transcript item. Assistant messages render Markdown, fold thinking to a line,
   * and show each tool call as a row (opened on click, or always, per the setting); an
   * Agent call becomes a subagent card with its own nested rows and an "Enter" button.
   */
  import type { AssistantItem, ChatSession, SubagentRun, ToolCall, TranscriptItem } from "$lib/chat/session.svelte";
  import { toolSummary } from "$lib/chat/session.svelte";
  import { app } from "$lib/store/app.svelte";
  import { runs } from "$lib/chat/runs.svelte";
  import { renderMarkdown } from "$lib/markdown";
  import { isThumbnailable, thumbnailSrc } from "$lib/terminal/attachments.svelte";
  import Icon from "../Icon.svelte";

  let {
    item,
    session,
    simple = false,
    onEnterAgent,
    onOpenRun,
  }: {
    item: TranscriptItem;
    session: ChatSession;
    /** Simple layout: fold every tool step of a message into one summary line. */
    simple?: boolean;
    onEnterAgent: (toolUseId: string) => void;
    onOpenRun: (tabId: string) => void;
  } = $props();

  let openTools = $state<Record<string, boolean>>({});
  let openThinking = $state(false);
  let openAgents = $state<Record<string, boolean>>({});
  let hoverAtt = $state<string | null>(null);

  function fmtTime(ts: number): string {
    try {
      return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    } catch {
      return "";
    }
  }
  function elapsed(a: number, b: number | null): string {
    const s = Math.max(0, Math.round(((b ?? Date.now()) - a) / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  }
  function tokens(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }
  function resultMeta(t: ToolCall): string {
    if (!t.result) return t.status === "running" ? `running ${elapsed(t.startedAt, null)}` : "";
    const text = t.result.text;
    if (t.name === "Read" || t.name === "Grep" || t.name === "Glob") {
      const n = text.split("\n").filter(Boolean).length;
      return `${n} line${n === 1 ? "" : "s"}`;
    }
    if (t.name === "Edit" || t.name === "Write") return "applied";
    if (t.endedAt) return elapsed(t.startedAt, t.endedAt);
    return "";
  }
  /** Counts for the Simple layout's one-line summary. */
  function summary(it: AssistantItem): string {
    const tools = it.parts.filter((p): p is ToolCall => p.type === "tool");
    if (!tools.length) return "";
    const by = new Map<string, number>();
    for (const t of tools) by.set(t.name, (by.get(t.name) ?? 0) + 1);
    return [...by.entries()].map(([n, c]) => `${n}${c > 1 ? ` ×${c}` : ""}`).join(" · ");
  }
  const toolsOpenByDefault = $derived(app.chatToolOutput === "expanded");
  function toolOpen(id: string): boolean {
    return openTools[id] ?? toolsOpenByDefault;
  }
</script>

{#if item.kind === "user"}
  <div class="msg user">
    <span class="av" class:me={!item.fromSession} class:cl={item.fromSession}>{item.fromSession ? "✱" : "You"}</span>
    <div class="body">
      <p class="who"><b>{item.fromSession ? "Claude (session)" : item.to ? `You → ${item.to}` : "You"}</b> {fmtTime(item.at)}{#if item.fromSession} · the prompt this agent was given{/if}</p>
      <div class="bubble" class:from-session={item.fromSession}>{item.text}
        {#if item.attachments.length}
          <div class="atts">
            {#each item.attachments as a (a.id)}
              <span class="att" role="img" aria-label={a.name} onmouseenter={() => (hoverAtt = a.id)} onmouseleave={() => (hoverAtt = null)}>
                <Icon name={a.isImage ? "image" : "file"} size={12} />{a.name}
                {#if hoverAtt === a.id}
                  <span class="preview">
                    {#if a.isImage && isThumbnailable(a.path)}<img src={thumbnailSrc(a.path)} alt={a.name} />{/if}
                    <span class="pname">{a.name}</span>
                  </span>
                {/if}
              </span>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </div>
{:else if item.kind === "assistant"}
  <div class="msg claude" class:streaming={item.streaming}>
    <span class="av cl">✱</span>
    <div class="body">
      <p class="who"><b>{item.speaker}</b> {fmtTime(item.at)}</p>
      {#if simple && summary(item)}
        <p class="sum">{summary(item)}</p>
      {/if}
      {#each item.parts as part, i (i)}
        {#if part.type === "text"}
          {#if item.streaming}
            <!-- Rendered as plain text while the deltas arrive; Markdown once the message
                 is complete — re-rendering the whole message per delta is what made
                 long replies stutter. -->
            <div class="md plain">{part.text}</div>
          {:else}
            <div class="md">{@html renderMarkdown(part.text)}</div>
          {/if}
        {:else if part.type === "thinking"}
          {#if part.text.trim()}
            <button class="think" onclick={() => (openThinking = !openThinking)}>
              <Icon name={openThinking ? "chevronDown" : "arrowRight"} size={11} /> Thinking
            </button>
            {#if openThinking}<div class="think-body">{part.text}</div>{/if}
          {/if}
        {:else if part.type === "tool" && part.agent}
          {@const run = part.agent}
          <div class="agent" class:running={run.status === "running"} class:error={run.status === "error"}>
            <button class="agent-h" onclick={() => (openAgents[run.toolUseId] = !(openAgents[run.toolUseId] ?? false))}>
              <span class="agent-name"><span class="adot"></span>Agent · {run.name}</span>
              <span class="agent-desc">{run.description || run.prompt.split("\n")[0]}</span>
              <span class="agent-meta">{run.status === "running" ? elapsed(run.startedAt, null) : `done · ${elapsed(run.startedAt, run.endedAt)}`} · {tokens(run.outputTokens)} tokens · {run.toolCount} tool{run.toolCount === 1 ? "" : "s"}</span>
              <span class="enter" role="button" tabindex="0" onclick={(e) => { e.stopPropagation(); onEnterAgent(run.toolUseId); }} onkeydown={(e) => e.key === "Enter" && onEnterAgent(run.toolUseId)}>Enter <Icon name="arrowRight" size={11} /></span>
            </button>
            {#if run.status === "running" && run.lastText}
              <div class="agent-now">{run.lastText}</div>
            {/if}
            {#if openAgents[run.toolUseId] ?? false}
              <div class="agent-tools">
                {#each run.items as sub (sub.id)}
                  {#if sub.kind === "assistant"}
                    {#each sub.parts as sp, j (j)}
                      {#if sp.type === "tool"}
                        <div class="tool"><span class="i {sp.status}">{sp.status === "running" ? "…" : sp.status === "error" ? "!" : "✓"}</span><span class="k">{sp.name}</span><span class="t">{toolSummary(sp.name, sp.input)}</span><span class="r">{resultMeta(sp)}</span></div>
                      {/if}
                    {/each}
                  {/if}
                {/each}
              </div>
            {/if}
            {#if run.status !== "running" && run.result}
              <div class="agent-result md">{@html renderMarkdown(run.result.length > 1200 ? run.result.slice(0, 1200) + "…" : run.result)}</div>
            {/if}
          </div>
        {:else if part.type === "tool" && !simple}
          <div class="tool" class:open={toolOpen(part.id)} role="button" tabindex="0" onclick={() => (openTools[part.id] = !toolOpen(part.id))} onkeydown={(e) => e.key === "Enter" && (openTools[part.id] = !toolOpen(part.id))}>
            <span class="i {part.status}">{part.status === "running" ? "…" : part.status === "error" ? "!" : "✓"}</span>
            <span class="k">{part.name}</span>
            <span class="t">{toolSummary(part.name, part.input)}</span>
            <span class="r">{resultMeta(part)}</span>
            {#if toolOpen(part.id)}
              <div class="out">{part.result ? part.result.text.slice(0, 6000) : part.status === "running" ? "running…" : "(no output)"}</div>
            {/if}
          </div>
        {/if}
      {/each}
      {#if item.streaming && !item.parts.length}
        <div class="thinking-line"><span class="pulse"></span>Thinking</div>
      {/if}
    </div>
  </div>
{:else if item.kind === "result"}
  <div class="result" class:err={item.isError}>
    {#if item.isError}
      <span class="rdot err"></span>Turn ended with an error{item.text ? `: ${item.text}` : ""}
    {:else}
      <span class="rdot"></span>Done in {elapsed(item.at - item.durationMs, item.at)} · ${item.costUsd.toFixed(2)} so far
    {/if}
  </div>
{:else if item.kind === "notice"}
  <div class="notice {item.tone}">{item.text}</div>
{:else if item.kind === "run"}
  <div class="msg run">
    <span class="av rn"><Icon name="play" size={12} /></span>
    <div class="body">
      <p class="who"><b>Run finished</b> {fmtTime(item.at)}{#if item.sent} · sent to the session{/if}</p>
      <div class="run-card" class:bad={item.exitCode !== 0}>
        <div class="run-top"><b>{item.name}</b><span class="dim">{item.target} · exit {item.exitCode ?? "?"} · {Math.round(item.durationMs / 1000)}s</span>
          <span class="run-acts">
            {#if !item.sent}<button class="mini" onclick={() => runs.sendItem(session, item)}>Send to session</button>{/if}
            <button class="mini" onclick={() => onOpenRun(item.tabId)}>Open output</button>
          </span>
        </div>
        <pre class="run-tail">{item.tail.trim().split("\n").slice(-12).join("\n")}</pre>
      </div>
    </div>
  </div>
{/if}

<style>
  .msg { display: grid; grid-template-columns: 26px 1fr; gap: 12px; }
  .body { min-width: 0; }
  .av { width: 26px; height: 26px; border-radius: 7px; display: grid; place-items: center; font-size: 10px; font-weight: 700; }
  .av.me { background: var(--surface-3); color: var(--text-secondary); }
  .av.cl { background: rgba(180, 142, 247, 0.18); color: var(--hue-violet); font-size: 13px; }
  .av.rn { background: rgba(89, 168, 105, 0.16); color: var(--ok); }
  .who { font-size: 11px; color: var(--text-faint); margin: 0 0 6px; }
  .who b { color: var(--text-muted); font-weight: 600; }
  .bubble.from-session { border-color: rgba(53, 116, 240, 0.35); }
  .bubble { background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; font-size: 13.5px; line-height: 1.5; color: var(--text); white-space: pre-wrap; word-break: break-word; }
  .atts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
  .att { position: relative; display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 9px; border-radius: 6px; background: var(--surface-1); border: 1px solid var(--border-strong); font-size: 12px; white-space: nowrap; }
  .preview { position: absolute; left: 0; bottom: calc(100% + 6px); z-index: 20; width: 320px; background: var(--surface-float); border: 1px solid var(--border-strong); border-radius: 10px; box-shadow: var(--shadow-lg); overflow: hidden; display: grid; }
  .preview img { max-width: 100%; max-height: 220px; object-fit: contain; background: #0b0c0e; }
  .pname { padding: 8px 10px; font-size: 12px; color: var(--text); white-space: normal; }
  .md { font-size: 13.5px; line-height: 1.58; color: var(--text-secondary); }
  .md.plain { white-space: pre-wrap; word-break: break-word; margin-bottom: 10px; }
  .md :global(p) { margin: 0 0 10px; }
  .md :global(ul), .md :global(ol) { margin: 0 0 10px; padding-left: 22px; }
  .md :global(code) { font-family: var(--font-mono); font-size: 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; color: var(--text); }
  .md :global(pre) { font-family: var(--font-mono); font-size: 12px; line-height: 1.5; background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin: 8px 0 12px; overflow-x: auto; color: var(--text); }
  .md :global(pre code) { background: none; border: 0; padding: 0; }
  .md :global(h1), .md :global(h2), .md :global(h3) { font-size: 14px; margin: 12px 0 6px; color: var(--text); }
  .md :global(blockquote) { margin: 0 0 10px; padding-left: 12px; border-left: 2px solid var(--border-strong); color: var(--text-muted); }
  .md :global(a) { color: var(--accent-bright); }
  .md :global(table) { border-collapse: collapse; font-size: 12.5px; margin: 0 0 10px; }
  .md :global(td), .md :global(th) { border: 1px solid var(--border); padding: 4px 8px; }
  .sum { font-size: 12px; color: var(--text-faint); margin: 0 0 6px; }
  .think { display: inline-flex; align-items: center; gap: 5px; font: inherit; font-size: 12px; color: var(--text-faint); background: none; border: 0; padding: 0; cursor: pointer; margin: 0 0 8px; }
  .think-body { font-size: 12.5px; line-height: 1.5; color: var(--text-muted); border-left: 2px solid var(--border-strong); padding-left: 10px; margin: 0 0 10px; white-space: pre-wrap; }
  .thinking-line { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-faint); }
  .pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--accent-bright); animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .pulse { animation: none; } }

  .tool { display: grid; grid-template-columns: 16px 64px 1fr auto; align-items: center; gap: 10px; min-height: 26px; padding: 0 10px; margin: 0 0 4px; border-radius: 7px; background: var(--surface-2); border: 1px solid var(--border-muted); font-size: 12px; color: var(--text-muted); cursor: pointer; }
  .tool.open { padding: 4px 10px 6px; }
  .tool .k { color: var(--text-secondary); font-weight: 600; }
  .tool .t { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .tool .r { font-variant-numeric: tabular-nums; color: var(--text-faint); font-size: 11px; white-space: nowrap; }
  .tool .i { width: 16px; height: 16px; border-radius: 4px; display: grid; place-items: center; font-size: 9px; font-weight: 800; }
  .i.done { background: rgba(89, 168, 105, 0.18); color: var(--ok); }
  .i.running { background: var(--accent-soft); color: var(--accent-bright); }
  .i.error { background: rgba(247, 84, 100, 0.18); color: var(--danger); }
  .tool .out { grid-column: 1 / -1; font-family: var(--font-mono); font-size: 11.5px; line-height: 1.5; color: var(--text-muted); border-top: 1px solid var(--border); padding-top: 6px; margin-top: 4px; white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow: auto; cursor: text; }

  .agent { border: 1px solid var(--border); border-left: 3px solid var(--ok); border-radius: 9px; background: var(--surface-2); margin: 0 0 8px; overflow: hidden; }
  .agent.running { border-color: rgba(53, 116, 240, 0.45); border-left-color: var(--accent); }
  .agent.error { border-left-color: var(--danger); }
  .agent-h { display: grid; grid-template-columns: auto 1fr auto auto; gap: 10px; align-items: center; width: 100%; padding: 8px 12px; background: none; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .agent-name { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; color: var(--ok); white-space: nowrap; }
  .agent.running .agent-name { color: var(--accent-bright); }
  .adot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .agent.running .adot { animation: pulse 1.2s ease-in-out infinite; }
  .agent-desc { font-size: 12.5px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .agent-meta { font-size: 11px; color: var(--text-faint); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .enter { display: inline-flex; align-items: center; gap: 3px; height: 22px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-1); font-size: 11.5px; font-weight: 600; color: var(--text-secondary); }
  .enter:hover { border-color: var(--accent); color: var(--accent-bright); }
  .agent-now { font-size: 11.5px; color: var(--text-muted); padding: 0 12px 8px; font-style: italic; }
  .agent-tools { padding: 0 12px 8px; }
  .agent-result { padding: 0 12px 10px; font-size: 12.5px; color: var(--text-secondary); }

  .result { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--text-faint); padding: 2px 0 0 38px; }
  .rdot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); }
  .rdot.err { background: var(--danger); }
  .result.err { color: var(--danger); }
  .notice { font-size: 12px; color: var(--text-muted); background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; margin-left: 38px; }
  .notice.error { color: var(--danger); border-color: var(--danger-line); background: var(--danger-bg); }
  .notice.warn { color: var(--warn); }
  .run-card { border: 1px solid var(--border); border-left: 3px solid var(--ok); border-radius: 9px; background: var(--surface-2); padding: 10px 12px; font-size: 12.5px; }
  .run-card.bad { border-left-color: var(--danger); }
  .run-top { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
  .run-top b { color: var(--text); }
  .dim { color: var(--text-faint); }
  .run-acts { margin-left: auto; display: flex; gap: 6px; }
  .mini { height: 22px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-1); color: var(--text-secondary); font: inherit; font-size: 11.5px; font-weight: 600; cursor: pointer; }
  .mini:hover { color: var(--text); border-color: var(--border-strong); }
  .run-tail { margin: 8px 0 0; font-family: var(--font-mono); font-size: 11.5px; line-height: 1.5; color: var(--text-muted); background: var(--surface-1); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow: auto; }
</style>
