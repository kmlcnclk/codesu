<script lang="ts">
  /**
   * What Claude stopped for: a tool permission, a multiple-choice question, or a plan to
   * approve. One card per request, answered by click or by key (Y / A / N, digits for
   * options, ⏎ to confirm).
   */
  import type { ChatSession, PendingRequest } from "$lib/chat/session.svelte";
  import { toolSummary } from "$lib/chat/session.svelte";
  import { renderMarkdown } from "$lib/markdown";
  import Icon from "../Icon.svelte";

  let { request, session, index = 0, total = 1 }: { request: PendingRequest; session: ChatSession; index?: number; total?: number } = $props();

  // ---- permission ----
  const detail = $derived.by(() => {
    const i = request.input;
    if (request.toolName === "Bash") return String(i.command ?? "");
    if (request.toolName === "Edit") return `${i.file_path}\n--- old\n${i.old_string ?? ""}\n+++ new\n${i.new_string ?? ""}`;
    if (request.toolName === "Write") return `${i.file_path}\n\n${String(i.content ?? "").slice(0, 2000)}`;
    const s = toolSummary(request.toolName, i);
    return s || JSON.stringify(i, null, 2);
  });
  const verb = $derived.by(() => {
    switch (request.toolName) {
      case "Bash": return "run a command";
      case "Edit": return "edit a file";
      case "Write": return "write a file";
      case "WebFetch": return "fetch a page";
      case "WebSearch": return "search the web";
      default: return `use ${request.toolName}`;
    }
  });
  function allowOnce() { session.answerPermission(request, { behavior: "allow", updatedInput: request.input }); }
  function allowSession() { session.answerPermission(request, { behavior: "allow", updatedInput: request.input }, true); }
  function deny() {
    session.answerPermission(request, { behavior: "deny", message: denyNote.trim() || "The user declined this action. Ask before trying another way.", interrupt: false });
  }
  let denyNote = $state("");
  let denying = $state(false);

  // ---- question ----
  let answers = $state<Record<string, string[]>>({});
  let other = $state<Record<string, string>>({});
  const qIndex = $state(0);
  const q = $derived(request.questions[qIndex]);
  function pick(question: string, label: string, multi: boolean) {
    const cur = answers[question] ?? [];
    if (multi) answers[question] = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
    else answers[question] = [label];
  }
  const allAnswered = $derived(request.questions.every((x) => (answers[x.question]?.length ?? 0) > 0 || other[x.question]?.trim()));
  function submitQuestion() {
    if (!allAnswered) return;
    const out: Record<string, string> = {};
    for (const x of request.questions) {
      const o = other[x.question]?.trim();
      out[x.question] = o ? o : (answers[x.question] ?? []).join(", ");
    }
    session.answerQuestion(request, out);
  }

  // ---- plan ----
  const plan = $derived(String(request.input.plan ?? ""));
  const planStats = $derived.by(() => {
    const steps = (plan.match(/^\s*(\d+\.|[-*])\s+/gm) ?? []).length;
    const files = new Set((plan.match(/[\w./-]+\.[a-z]{1,5}\b/g) ?? []).filter((f) => f.includes("/") || f.includes("."))).size;
    return { steps, files };
  });
  let changeNote = $state("");
  let asking = $state(false);

  // ---- keys (only when nothing editable has focus) ----
  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (t && t.closest("input, textarea, [contenteditable]")) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (request.kind === "permission") {
      if (k === "y") { e.preventDefault(); allowOnce(); }
      else if (k === "a") { e.preventDefault(); allowSession(); }
      else if (k === "n") { e.preventDefault(); denying = true; }
    } else if (request.kind === "plan") {
      if (k === "y") { e.preventDefault(); session.answerPlan(request, "approve"); }
      else if (k === "a") { e.preventDefault(); session.answerPlan(request, "approve-edits"); }
      else if (k === "n") { e.preventDefault(); asking = true; }
    } else if (request.kind === "question" && q) {
      const n = Number(k);
      if (n >= 1 && n <= q.options.length) { e.preventDefault(); pick(q.question, q.options[n - 1].label, !!q.multiSelect); }
      else if (k === "enter") { e.preventDefault(); submitQuestion(); }
    }
  }
</script>

<svelte:window onkeydown={index === 0 ? onKey : undefined} />

{#if request.kind === "permission"}
  <div class="card perm">
    <div class="head"><span class="dot warn"></span>Claude wants to {verb}{#if total > 1}<span class="count">· {index + 1} of {total}</span>{/if}</div>
    <pre class="detail">{detail}</pre>
    {#if denying}
      <div class="note">
        <input class="note-in" bind:value={denyNote} placeholder="Tell Claude what to do instead (optional)" onkeydown={(e) => { if (e.key === "Enter") deny(); if (e.key === "Escape") denying = false; }} />
        <button class="btn danger" onclick={deny}>Deny</button>
        <button class="btn" onclick={() => (denying = false)}>Back</button>
      </div>
    {:else}
      <div class="acts">
        <button class="btn primary" onclick={allowOnce}>Allow once<kbd>Y</kbd></button>
        <button class="btn" onclick={allowSession}>Allow for this session<kbd>A</kbd></button>
        <button class="btn danger" onclick={() => (denying = true)}>Deny<kbd>N</kbd></button>
        <span class="hint">Deny lets you say what to do instead</span>
      </div>
    {/if}
  </div>
{:else if request.kind === "question" && q}
  <div class="card ask">
    <div class="head"><span class="dot ask"></span>{q.header ? `${q.header} · ` : ""}{q.question}{#if request.questions.length > 1}<span class="count">· question {qIndex + 1} of {request.questions.length}</span>{/if}</div>
    <div class="opts">
      {#each q.options as o, i (o.label)}
        {@const on = (answers[q.question] ?? []).includes(o.label)}
        <button class="opt" class:on onclick={() => pick(q.question, o.label, !!q.multiSelect)}>
          <span class="radio" class:on class:multi={q.multiSelect}></span>
          <span class="lbl"><b>{o.label}</b>{#if o.description}<span class="desc"> · {o.description}</span>{/if}</span>
          <kbd>{i + 1}</kbd>
        </button>
      {/each}
      <label class="opt other">
        <span class="radio" class:on={!!other[q.question]?.trim()}></span>
        <input class="other-in" placeholder="Other… type your own answer" bind:value={other[q.question]} onkeydown={(e) => e.key === "Enter" && submitQuestion()} />
      </label>
    </div>
    {#each request.questions as x, i (x.question)}
      {#if i !== qIndex && i > 0}
        <div class="more">{x.header ? `${x.header}: ` : ""}{x.question}
          <span class="more-opts">{#each x.options as o (o.label)}<button class="chip" class:on={(answers[x.question] ?? []).includes(o.label)} onclick={() => pick(x.question, o.label, !!x.multiSelect)}>{o.label}</button>{/each}</span>
        </div>
      {/if}
    {/each}
    <div class="acts">
      <button class="btn primary" disabled={!allAnswered} onclick={submitQuestion}>Answer<kbd>⏎</kbd></button>
      <span class="hint">{q.multiSelect ? "Pick one or more" : "Pick one"} · number keys select</span>
    </div>
  </div>
{:else if request.kind === "plan"}
  <div class="card plan">
    <div class="head"><span class="dot plan"></span>Claude proposes a plan <span class="count">· {planStats.steps} step{planStats.steps === 1 ? "" : "s"}{#if planStats.files} · {planStats.files} file{planStats.files === 1 ? "" : "s"}{/if} · nothing changed yet</span></div>
    <div class="plan-body md">{@html renderMarkdown(plan)}</div>
    {#if asking}
      <div class="note">
        <input class="note-in" bind:value={changeNote} placeholder="What should change in the plan?" onkeydown={(e) => { if (e.key === "Enter") session.answerPlan(request, "changes", changeNote); if (e.key === "Escape") asking = false; }} />
        <button class="btn" onclick={() => session.answerPlan(request, "changes", changeNote)}>Send</button>
        <button class="btn" onclick={() => (asking = false)}>Back</button>
      </div>
    {:else}
      <div class="acts">
        <button class="btn primary" onclick={() => session.answerPlan(request, "approve")}>Approve<kbd>Y</kbd></button>
        <button class="btn" onclick={() => session.answerPlan(request, "approve-edits")}>Approve and auto-accept edits<kbd>A</kbd></button>
        <button class="btn" onclick={() => (asking = true)}>Request changes<kbd>N</kbd></button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .card { border-radius: 10px; padding: 12px 14px; display: grid; gap: 10px; margin: 6px 0 10px; }
  .perm { border: 1px solid rgba(242, 197, 92, 0.45); background: rgba(242, 197, 92, 0.07); }
  .ask { border: 1px solid rgba(84, 138, 247, 0.5); background: rgba(53, 116, 240, 0.07); }
  .plan { border: 1px solid rgba(180, 142, 247, 0.5); background: rgba(180, 142, 247, 0.07); }
  .head { display: flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 600; color: var(--text); flex-wrap: wrap; }
  .count { color: var(--text-faint); font-weight: 500; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .dot.warn { background: var(--warn); box-shadow: 0 0 0 3px rgba(242, 197, 92, 0.22); }
  .dot.ask { background: var(--accent-bright); box-shadow: 0 0 0 3px rgba(84, 138, 247, 0.22); }
  .dot.plan { background: var(--hue-violet); box-shadow: 0 0 0 3px rgba(180, 142, 247, 0.22); }
  .detail { margin: 0; font-family: var(--font-mono); font-size: 12px; line-height: 1.5; background: var(--surface-1); border: 1px solid var(--border); border-radius: 7px; padding: 9px 11px; color: var(--text); white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow: auto; }
  .acts { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; row-gap: 8px; }
  .hint { font-size: 11px; color: var(--text-faint); margin-left: auto; }
  .btn { display: inline-flex; align-items: center; height: 28px; padding: 0 11px; border-radius: 7px; border: 1px solid var(--border-strong); background: var(--surface-2); color: var(--text); font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; white-space: nowrap; flex: none; }
  .btn:hover { background: var(--surface-3); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
  .btn.primary:hover { background: var(--accent-bright); }
  .btn.danger { color: var(--danger); border-color: rgba(247, 84, 100, 0.35); }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .btn kbd, .opt kbd { font-family: var(--font-sans); font-size: 10px; padding: 1px 5px; border: 1px solid var(--border-strong); border-radius: 4px; color: var(--text-muted); margin-left: 7px; }
  .btn.primary kbd { border-color: rgba(255, 255, 255, 0.4); color: #fff; }
  .note { display: flex; gap: 8px; align-items: center; }
  .note-in, .other-in { flex: 1; min-width: 0; height: 30px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: 7px; background: var(--surface-1); color: var(--text); font: inherit; font-size: 13px; outline: none; }
  .note-in:focus, .other-in:focus { border-color: var(--accent); }
  .opts { display: grid; gap: 6px; }
  .opt { display: grid; grid-template-columns: 18px 1fr auto; gap: 10px; align-items: center; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: var(--text); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
  .opt:hover { background: var(--surface-2); }
  .opt.on { border-color: var(--accent); background: var(--accent-soft); }
  .opt.other { grid-template-columns: 18px 1fr; cursor: text; }
  .other-in { height: 26px; border: 0; background: transparent; padding: 0; }
  .radio { width: 14px; height: 14px; border-radius: 50%; border: 1.5px solid var(--border-strong); }
  .radio.multi { border-radius: 4px; }
  .radio.on { border-color: var(--accent); box-shadow: inset 0 0 0 3.5px var(--accent); background: #fff; }
  .desc { color: var(--text-muted); }
  .more { font-size: 12.5px; color: var(--text-secondary); display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .chip { height: 24px; padding: 0 9px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; font-size: 12px; cursor: pointer; }
  .chip.on { border-color: var(--accent); background: var(--accent-soft); }
  .plan-body { font-size: 13px; line-height: 1.6; color: var(--text-secondary); background: var(--surface-1); border: 1px solid var(--border); border-radius: 7px; padding: 10px 14px; max-height: 320px; overflow: auto; }
  .plan-body :global(ol), .plan-body :global(ul) { margin: 0; padding-left: 22px; }
  .plan-body :global(p) { margin: 0 0 8px; }
  .plan-body :global(code) { font-family: var(--font-mono); font-size: 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; }
</style>
