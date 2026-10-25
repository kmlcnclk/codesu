<script lang="ts">
  /**
   * The scrolling conversation: items, then whatever Claude is waiting on. Used for the
   * session and, with a subagent's items, for the drill-in view. Owns the "jump to
   * latest" button and reports which user message is in view for the navigator.
   */
  import { onDestroy } from "svelte";
  import type { ChatSession, TranscriptItem } from "$lib/chat/session.svelte";
  import ChatMessage from "./ChatMessage.svelte";
  import RequestCard from "./RequestCard.svelte";
  import Icon from "../Icon.svelte";

  let {
    session,
    items,
    showRequests = true,
    simple = false,
    narrow = false,
    onEnterAgent,
    onOpenRun,
    onInView,
    scrollTo = $bindable<string | null>(null),
  }: {
    session: ChatSession;
    items: TranscriptItem[];
    showRequests?: boolean;
    simple?: boolean;
    narrow?: boolean;
    onEnterAgent: (toolUseId: string) => void;
    onOpenRun: (tabId: string) => void;
    onInView?: (userItemId: string | null) => void;
    /** Set to a user item's id to scroll it into view (cleared once done). */
    scrollTo?: string | null;
  } = $props();

  let scroller = $state<HTMLDivElement | null>(null);
  let atBottom = $state(true);
  let unseen = $state(0);
  let lastCount = 0;

  function onScroll() {
    if (!scroller) return;
    const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    const was = atBottom;
    atBottom = gap < 40;
    if (atBottom && !was) unseen = 0;
    reportInView();
  }
  function reportInView() {
    if (!onInView || !scroller) return;
    const top = scroller.getBoundingClientRect().top + 60;
    let current: string | null = null;
    for (const el of scroller.querySelectorAll<HTMLElement>("[data-user-id]")) {
      if (el.getBoundingClientRect().top <= top) current = el.dataset.userId ?? null;
      else break;
    }
    onInView(current);
  }
  export function jumpToLatest() {
    if (!scroller) return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    atBottom = true;
    unseen = 0;
  }

  // Follow the conversation while the user is at the bottom; count what they missed
  // otherwise. Streaming bumps `version` many times a second, so the scroll (a forced
  // layout of the whole transcript) runs at most once per animation frame.
  let frame = 0;
  $effect(() => {
    void session.version;
    const n = items.length + session.pending.length;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!scroller) return;
      if (atBottom) scroller.scrollTop = scroller.scrollHeight;
      else if (n > lastCount) unseen += n - lastCount;
      lastCount = n;
    });
  });
  onDestroy(() => cancelAnimationFrame(frame));
  $effect(() => {
    const id = scrollTo;
    if (!id || !scroller) return;
    const el = scroller.querySelector<HTMLElement>(`[data-user-id="${id}"]`);
    el?.scrollIntoView({ block: "start", behavior: "smooth" });
    scrollTo = null;
  });
</script>

<div class="transcript" class:narrow bind:this={scroller} onscroll={onScroll}>
  <div class="col">
    {#if items.length === 0 && session.pending.length === 0}
      <div class="empty">
        <div class="glyph"><Icon name="agents" size={30} stroke={1.3} /></div>
        {#if !showRequests}
          <h3>Nothing recorded for this agent</h3>
          <p>Steps are kept only for agents that ran while this view was open. Its result is on the card in the session.</p>
        {:else}
          <h3>{session.running ? "Say what to do" : "Start the session"}</h3>
          <p>{session.running ? "Claude Code is running in the background. Type below; files can be dropped onto the pane." : "The conversation continues where this session left off."}</p>
        {/if}
      </div>
    {/if}
    {#each items as item (item.id)}
      {#if item.kind === "user"}
        <div data-user-id={item.id}><ChatMessage {item} {session} {simple} {onEnterAgent} {onOpenRun} /></div>
      {:else}
        <ChatMessage {item} {session} {simple} {onEnterAgent} {onOpenRun} />
      {/if}
    {/each}
    {#if showRequests}
      {#each session.pending as req, i (req.requestId)}
        <div class="req"><RequestCard request={req} {session} index={i} total={session.pending.length} /></div>
      {/each}
    {/if}
    {#if session.status === "working" && showRequests}
      {@const last = items[items.length - 1]}
      {#if !(last && last.kind === "assistant" && last.streaming)}
        <div class="working"><span class="pulse"></span>Claude is working</div>
      {/if}
    {/if}
  </div>
</div>
{#if !atBottom}
  <button class="jump" onclick={jumpToLatest} title="Jump to latest (End)">
    <Icon name="chevronDown" size={14} />{#if unseen}<span class="n">{unseen}</span>{/if}
  </button>
{/if}

<style>
  .transcript { position: absolute; inset: 0; overflow: auto; padding: 20px 0 16px; }
  .col { width: min(820px, 100% - 48px); margin: 0 auto; display: flex; flex-direction: column; gap: 18px; }
  .narrow .col { width: min(720px, 100% - 40px); }
  .req { margin-left: 38px; }
  .empty { text-align: center; color: var(--text-muted); padding: 60px 0 20px; }
  .empty .glyph { color: var(--text-ghost); margin-bottom: 10px; }
  .empty h3 { margin: 0 0 6px; font-size: 15px; color: var(--text); }
  .empty p { margin: 0; font-size: 13px; }
  .working { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-faint); padding-left: 38px; }
  .pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--accent-bright); animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .pulse { animation: none; } }
  .jump { position: absolute; left: 22px; bottom: 14px; z-index: 5; display: inline-flex; align-items: center; gap: 4px; height: 34px; min-width: 34px; padding: 0 9px; border-radius: 9px; background: var(--surface-3); border: 1px solid var(--border-strong); box-shadow: var(--shadow-md); color: var(--text-secondary); cursor: pointer; }
  .jump:hover { color: var(--text); background: var(--surface-4); }
  .jump .n { font-size: 11px; font-weight: 700; color: var(--accent-bright); }
</style>
