<script lang="ts">
  import {
    app,
    dayKey,
    ACTIVITY_ACTION_META,
    type ActivityEntry,
    type TaskItem,
  } from "$lib/store/app.svelte";
  import Icon from "./Icon.svelte";

  let {
    onOpenAgent,
    onOpenNote,
  }: { onOpenAgent: (agentId: string) => void; onOpenNote: (noteId: string) => void } = $props();

  /** The idea/note an activity entry traces back to (via the agent's forked task). */
  function noteFor(e: ActivityEntry): TaskItem | undefined {
    let task: TaskItem | undefined;
    if (e.entity === "task") {
      task = app.tasks.find((t) => t.id === e.refId);
    } else {
      const agent = app.agents.find((a) => a.id === e.refId);
      if (agent?.taskId) task = app.tasks.find((t) => t.id === agent.taskId);
      if (!task) {
        const linked = app.tasks.find((t) => t.status === "idea" && t.agentIds.includes(e.refId));
        if (linked) return linked;
      }
    }
    if (!task) return undefined;
    if (task.status === "idea") return task;
    if (task.parentId) {
      const p = app.tasks.find((t) => t.id === task!.parentId);
      if (p?.status === "idea") return p;
    }
    return undefined;
  }
  function noteTitle(t: TaskItem): string {
    if (t.title.trim()) return t.title.trim();
    const line = t.details.split("\n").map((l) => l.trim()).find(Boolean);
    return line || "Untitled note";
  }

  const today = dayKey();
  let selected = $state(today);
  let copied = $state(false);

  // ---- custom calendar popover ----
  let showCal = $state(false);
  let calCursor = $state(today); // "YYYY-MM-DD" anchor for the displayed month
  const DOW = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

  function openCal() {
    calCursor = selected;
    showCal = true;
  }
  function calShiftMonth(delta: number) {
    const d = parse(calCursor);
    calCursor = dayKey(new Date(d.getFullYear(), d.getMonth() + delta, 1).getTime());
  }
  function pickDay(key: string) {
    if (key > today) return;
    selected = key;
    showCal = false;
  }
  const monthLabel = $derived(
    parse(calCursor).toLocaleDateString(undefined, { month: "long", year: "numeric" }),
  );
  const calDays = $derived.by(() => {
    const d = parse(calCursor);
    const month = d.getMonth();
    const first = new Date(d.getFullYear(), month, 1);
    const startOffset = (first.getDay() + 6) % 7; // Monday-first
    const gridStart = new Date(d.getFullYear(), month, 1 - startOffset);
    return Array.from({ length: 42 }, (_, i) => {
      const cur = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      const key = dayKey(cur.getTime());
      return {
        key,
        day: cur.getDate(),
        inMonth: cur.getMonth() === month,
        future: key > today,
        isToday: key === today,
        isSel: key === selected,
      };
    });
  });

  // ---- date helpers ----
  function parse(key: string): Date {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  function shift(key: string, delta: number): string {
    const d = parse(key);
    d.setDate(d.getDate() + delta);
    return dayKey(d.getTime());
  }
  function relLabel(key: string): string {
    const diff = Math.round((parse(today).getTime() - parse(key).getTime()) / 86_400_000);
    if (diff === 0) return "Today";
    if (diff === 1) return "Yesterday";
    if (diff === -1) return "Tomorrow";
    if (diff > 1 && diff < 7) return `${diff} days ago`;
    return parse(key).toLocaleDateString(undefined, { weekday: "long" });
  }
  function fullLabel(key: string): string {
    return parse(key).toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }
  function chipLabel(key: string): string {
    const diff = Math.round((parse(today).getTime() - parse(key).getTime()) / 86_400_000);
    if (diff === 0) return "Today";
    if (diff === 1) return "Yesterday";
    return parse(key).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function fmtTime(ts: number): string {
    try {
      return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  }

  // ---- derived report data ----
  const entries = $derived(app.activityOn(selected));
  /**
   * The same work is often logged twice — once as a "task" entry and once as its
   * "agent" entry (different refIds). Collapse both to one row by keying on the
   * agent (or its note) the entry resolves to, so no item is shown twice.
   */
  function canonKey(e: ActivityEntry): string {
    const agentId = targetAgent(e);
    if (agentId) return "a:" + agentId;
    const note = noteFor(e);
    if (note) return "n:" + note.id;
    return e.entity + ":" + e.refId;
  }
  function dedupe(list: ActivityEntry[]): ActivityEntry[] {
    const seen = new Set<string>();
    return list.filter((e) => {
      const k = canonKey(e);
      return seen.has(k) ? false : (seen.add(k), true);
    });
  }
  const completed = $derived(dedupe(entries.filter((e) => e.action === "completed")));
  const completedKeys = $derived(new Set(completed.map(canonKey)));
  // Completed wins over Worked — an item finished today never also shows as worked.
  const worked = $derived(
    dedupe(entries.filter((e) => e.action === "worked" && !completedKeys.has(canonKey(e)))),
  );
  const workspaceCount = $derived(
    new Set(entries.map((e) => e.workspaceName).filter(Boolean)).size,
  );
  const isFuture = $derived(parse(selected).getTime() > parse(today).getTime());

  // ---- entry → openable agent ----
  function targetAgent(e: ActivityEntry): string | null {
    if (e.entity === "agent") return app.agents.some((a) => a.id === e.refId) ? e.refId : null;
    const t = app.tasks.find((x) => x.id === e.refId);
    const agent = t ? app.primaryAgent(t) : undefined;
    return agent ? agent.id : null;
  }
  function openEntry(e: ActivityEntry) {
    const id = targetAgent(e);
    if (!id) return;
    const agent = app.agents.find((a) => a.id === id);
    if (agent && app.effectiveLane(agent) === "done") app.restoreFromHistory(id);
    onOpenAgent(id);
  }

  // ---- copy for standup ----
  async function copyReport() {
    const lines: string[] = [`Daily report — ${fullLabel(selected)}`, ""];
    const section = (title: string, list: ActivityEntry[]) => {
      if (!list.length) return;
      lines.push(`${title} (${list.length})`);
      for (const e of list) {
        const ws = e.workspaceName ? ` — ${e.workspaceName}` : "";
        lines.push(`  • ${e.name} [${e.entity}]${ws}`);
      }
      lines.push("");
    };
    section("Completed", completed);
    section("Worked on", worked);
    if (!completed.length && !worked.length) lines.push("No tracked activity.");
    const text = lines.join("\n").trim();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for webviews without async clipboard permission.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* ignore */
      }
      ta.remove();
    }
    copied = true;
    setTimeout(() => (copied = false), 1600);
  }

</script>

<div class="report">
  <header class="page-head">
    <div class="titles">
      <h1>Daily Report</h1>
      <p>What you worked on and completed, day by day — ready for standup.</p>
    </div>
  </header>

  <!-- Toolbar: date navigation + actions -->
  <header class="toolbar">
    <div class="datenav">
      <button class="nav-arrow" title="Previous day" aria-label="Previous day" onclick={() => (selected = shift(selected, -1))}>
        <Icon name="arrowRight" size={16} />
      </button>

      <div class="datefield-wrap">
        <button class="datefield" class:open={showCal} title="Pick a date" onclick={() => (showCal ? (showCal = false) : openCal())}>
          <Icon name="history" size={14} />
          <span class="df-text">
            <span class="df-rel">{relLabel(selected)}</span>
            <span class="df-full">{parse(selected).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span>
          </span>
          <span class="df-chev" class:up={showCal}><Icon name="chevronDown" size={14} /></span>
        </button>

        {#if showCal}
          <button class="cal-backdrop" aria-label="Close calendar" onclick={() => (showCal = false)}></button>
          <div class="cal-pop" role="dialog" aria-label="Choose a date">
            <div class="cal-head">
              <button class="cal-nav prev" aria-label="Previous month" onclick={() => calShiftMonth(-1)}>
                <Icon name="arrowRight" size={15} />
              </button>
              <span class="cal-month">{monthLabel}</span>
              <button class="cal-nav" aria-label="Next month" onclick={() => calShiftMonth(1)}>
                <Icon name="arrowRight" size={15} />
              </button>
            </div>
            <div class="cal-dow">
              {#each DOW as d}<span>{d}</span>{/each}
            </div>
            <div class="cal-grid">
              {#each calDays as c (c.key)}
                <button
                  class="cal-day"
                  class:out={!c.inMonth}
                  class:today={c.isToday}
                  class:sel={c.isSel}
                  disabled={c.future}
                  onclick={() => pickDay(c.key)}
                >
                  {c.day}
                </button>
              {/each}
            </div>
            <div class="cal-foot">
              <button class="cal-todaybtn" onclick={() => pickDay(today)}>Jump to today</button>
            </div>
          </div>
        {/if}
      </div>

      <button
        class="nav-arrow"
        title="Next day"
        aria-label="Next day"
        disabled={selected >= today}
        onclick={() => (selected = shift(selected, 1))}
      >
        <Icon name="arrowRight" size={16} />
      </button>

      {#if selected !== today}
        <button class="today-btn" onclick={() => (selected = today)}>Today</button>
      {/if}
    </div>

    <div class="tools">
      <button class="copy-btn" class:done={copied} disabled={entries.length === 0} onclick={copyReport}>
        <Icon name={copied ? "check" : "clipboard"} size={14} />
        {copied ? "Copied!" : "Copy report"}
      </button>
    </div>
  </header>

  <div class="scroll">
    <div class="sheet">
      <!-- Report title + summary -->
      <div class="rep-head">
        <div class="rep-title">
          <span class="rep-rel">{relLabel(selected)}</span>
          <h2>{fullLabel(selected)}</h2>
        </div>
        <div class="stats">
          <div class="stat" style="--c:var(--ok)">
            <span class="stat-n">{completed.length}</span>
            <span class="stat-l">Completed</span>
          </div>
          <div class="stat" style="--c:var(--accent)">
            <span class="stat-n">{worked.length}</span>
            <span class="stat-l">Worked on</span>
          </div>
          <div class="stat" style="--c:var(--text-muted)">
            <span class="stat-n">{workspaceCount}</span>
            <span class="stat-l">{workspaceCount === 1 ? "Workspace" : "Workspaces"}</span>
          </div>
        </div>
      </div>

      {#if entries.length === 0}
        <div class="empty">
          <div class="glyph"><Icon name={isFuture ? "history" : "inbox"} size={38} stroke={1.4} /></div>
          <h3>{isFuture ? "Nothing here yet" : "No activity this day"}</h3>
          <p>
            {isFuture
              ? "This day hasn’t happened yet."
              : "Work with an agent or move a task, and it’ll be logged here."}
          </p>
        </div>
      {:else}
        {#each [{ key: "completed", title: "Completed", list: completed }, { key: "worked", title: "Worked on", list: worked }] as sec (sec.key)}
          {#if sec.list.length}
            {@const meta = ACTIVITY_ACTION_META[sec.key as ActivityEntry["action"]]}
            <section class="group">
              <h3 class="group-title" style="--c:{meta.color}">
                <span class="gt-dot"></span>
                {sec.title}
                <span class="gt-c">{sec.list.length}</span>
              </h3>
              <ul class="rows">
                {#each sec.list as e (e.id)}
                  {@const target = targetAgent(e)}
                  {@const note = noteFor(e)}
                  <li class="row" style="--c:{meta.color}">
                    <span class="ent-ico"><Icon name={e.entity === "task" ? "tasks" : "agents"} size={16} /></span>
                    <div class="info">
                      <span class="name">{e.name}</span>
                      <div class="meta">
                        <span class="kind">{e.entity}</span>
                        {#if e.workspaceName}
                          <span class="sep">·</span>
                          <span class="ws"><span class="wsd"></span>{e.workspaceName}</span>
                        {/if}
                        <span class="sep">·</span>
                        <span class="time">{fmtTime(e.at)}</span>
                      </div>
                      {#if note && note.id !== e.refId}
                        <button class="note-chip" onclick={() => onOpenNote(note.id)} title="Open note">
                          <Icon name="notes" size={12} /> <span class="nc-text">{noteTitle(note)}</span>
                        </button>
                      {/if}
                    </div>
                    <div class="row-acts">
                      {#if note}
                        <button class="rbtn" onclick={() => onOpenNote(note.id)} title="Open note">
                          <Icon name="notes" size={13} /> Note
                        </button>
                      {/if}
                      {#if target}
                        <button class="rbtn accent" onclick={() => openEntry(e)} title="Open agent">
                          <Icon name="open" size={13} /> Agent
                        </button>
                      {:else if !note}
                        <span class="closed">closed</span>
                      {/if}
                    </div>
                  </li>
                {/each}
              </ul>
            </section>
          {/if}
        {/each}
      {/if}
    </div>

    <!-- Recent active days rail -->
    {#if app.activityByDay.length}
      <aside class="rail">
        <h4 class="rail-title">Recent days</h4>
        <ul class="rail-list">
          {#each app.activityByDay as g (g.day)}
            <li>
              <button class="rail-day" class:on={g.day === selected} onclick={() => (selected = g.day)}>
                <span class="rd-label">{chipLabel(g.day)}</span>
                <span class="rd-count">{g.entries.length}</span>
              </button>
            </li>
          {/each}
        </ul>
      </aside>
    {/if}
  </div>
</div>

<style>
  .report {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }

  /* ---- page header ---- */
  .page-head {
    padding: 20px 24px 12px;
  }
  .titles h1 {
    margin: 0;
    font-size: 20px;
    font-weight: 700;
    color: var(--text);
  }
  .titles p {
    margin: 3px 0 0;
    font-size: 12.5px;
    color: var(--text-muted);
  }

  /* ---- toolbar ---- */
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    padding: 12px 24px;
    border-bottom: 1px solid var(--border-muted);
  }
  .datenav {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .nav-arrow {
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-3);
    color: var(--text-secondary);
    cursor: pointer;
    transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
  }
  .nav-arrow:hover:not(:disabled) {
    background: var(--surface-4);
    border-color: var(--accent-line);
    color: var(--text);
  }
  .nav-arrow:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .nav-arrow:first-child :global(svg) {
    transform: rotate(180deg);
  }

  .datefield-wrap {
    position: relative;
  }
  .datefield {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 200px;
    padding: 6px 12px;
    border: 1px solid var(--border-strong);
    border-radius: var(--r-md);
    background: var(--surface-float);
    color: var(--text-muted);
    cursor: pointer;
    text-align: left;
    transition: border-color var(--t-fast), background var(--t-fast);
  }
  .datefield:hover,
  .datefield.open {
    border-color: var(--accent-line);
    background: var(--surface-3);
  }
  .df-text {
    display: flex;
    flex-direction: column;
    line-height: 1.15;
    flex: 1;
    min-width: 0;
  }
  .df-rel {
    font-size: 13px;
    font-weight: 700;
    color: var(--text);
  }
  .df-full {
    font-size: 11px;
    color: var(--text-muted);
  }
  .df-chev {
    display: grid;
    place-items: center;
    color: var(--text-muted);
    transition: transform var(--t-fast);
  }
  .df-chev.up {
    transform: rotate(180deg);
  }

  /* ---- custom calendar popover ---- */
  .cal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    border: none;
    background: transparent;
    cursor: default;
  }
  .cal-pop {
    position: absolute;
    z-index: 41;
    top: calc(100% + 8px);
    left: 0;
    width: 280px;
    padding: 12px;
    background: var(--surface-float);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-lg);
  }
  .cal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }
  .cal-month {
    font-size: 13px;
    font-weight: 700;
    color: var(--text);
  }
  .cal-nav {
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border: 1px solid var(--border-strong);
    border-radius: var(--r-sm);
    background: var(--surface-2);
    color: var(--text-secondary);
    cursor: pointer;
    transition: border-color var(--t-fast), color var(--t-fast), background var(--t-fast);
  }
  .cal-nav:hover {
    border-color: var(--accent-line);
    color: var(--text);
    background: var(--surface-3);
  }
  .cal-nav.prev :global(svg) {
    transform: rotate(180deg);
  }
  .cal-dow {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 2px;
    margin-bottom: 4px;
  }
  .cal-dow span {
    text-align: center;
    font-size: 10.5px;
    font-weight: 700;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .cal-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 2px;
  }
  .cal-day {
    aspect-ratio: 1;
    display: grid;
    place-items: center;
    border: 1px solid transparent;
    border-radius: var(--r-sm);
    background: transparent;
    color: var(--text-secondary);
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    transition: background var(--t-fast), color var(--t-fast), border-color var(--t-fast);
  }
  .cal-day:hover:not(:disabled) {
    background: var(--surface-4);
    color: var(--text);
  }
  .cal-day.out {
    color: var(--text-ghost);
  }
  .cal-day.today:not(.sel) {
    border-color: var(--accent-line);
    color: var(--accent-bright);
  }
  .cal-day.sel {
    background: var(--accent);
    color: var(--accent-fg);
    font-weight: 700;
  }
  .cal-day:disabled {
    color: var(--text-ghost);
    opacity: 0.4;
    cursor: default;
  }
  .cal-foot {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--border-muted);
    display: flex;
    justify-content: center;
  }
  .cal-todaybtn {
    border: none;
    background: transparent;
    color: var(--accent-bright);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: var(--r-sm);
  }
  .cal-todaybtn:hover {
    background: var(--accent-softer);
  }
  .today-btn {
    padding: 6px 12px;
    border: 1px solid var(--border-strong);
    border-radius: var(--r-sm);
    background: transparent;
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .today-btn:hover {
    background: var(--surface-4);
    color: var(--text);
  }

  .tools {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .copy-btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    border: 1px solid transparent;
    border-radius: var(--r-sm);
    background: var(--accent);
    color: var(--accent-fg);
    font-size: 12.5px;
    font-weight: 700;
    padding: 7px 14px;
    cursor: pointer;
    transition: filter var(--t-fast), background var(--t-fast);
  }
  .copy-btn:hover:not(:disabled) {
    filter: brightness(1.08);
  }
  .copy-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .copy-btn.done {
    background: var(--ok);
  }

  /* ---- scroll area ---- */
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    gap: 22px;
    padding: 22px 24px 36px;
    align-items: flex-start;
    justify-content: center;
  }
  .sheet {
    flex: 1;
    max-width: 720px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  /* ---- report head ---- */
  .rep-head {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding-bottom: 18px;
    border-bottom: 1px solid var(--border-muted);
  }
  .rep-title {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .rep-rel {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--accent);
  }
  .rep-title h2 {
    margin: 0;
    font-size: 24px;
    font-weight: 700;
    color: var(--text);
    letter-spacing: -0.01em;
  }
  .stats {
    display: flex;
    gap: 10px;
  }
  .stat {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 12px 14px;
    border: 1px solid var(--surface-4);
    border-left: 3px solid var(--c);
    border-radius: var(--r-md);
    background: var(--surface-float);
  }
  .stat-n {
    font-size: 22px;
    font-weight: 800;
    color: var(--c);
    line-height: 1;
  }
  .stat-l {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  /* ---- groups ---- */
  .group {
    display: flex;
    flex-direction: column;
    gap: 9px;
  }
  .group-title {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--text-secondary);
  }
  .gt-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--c);
    box-shadow: 0 0 8px color-mix(in srgb, var(--c) 60%, transparent);
  }
  .gt-c {
    font-size: 10.5px;
    font-weight: 800;
    color: var(--text-muted);
    background: var(--surface-4);
    border-radius: 8px;
    padding: 1px 7px;
    letter-spacing: 0;
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 11px 14px;
    border: 1px solid var(--surface-4);
    border-radius: var(--r-lg);
    background: var(--surface-float);
    box-shadow: var(--shadow-sm);
    transition: border-color var(--t-fast), transform var(--t-fast);
  }
  .row:hover {
    border-color: var(--border-strong);
    transform: translateX(2px);
  }
  .ent-ico {
    flex-shrink: 0;
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--c) 14%, transparent);
    color: var(--c);
  }
  .info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .name {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 11.5px;
    color: var(--text-muted);
  }
  .kind {
    text-transform: capitalize;
  }
  .sep {
    color: var(--text-ghost);
  }
  .ws {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .wsd {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-faint);
  }
  .time {
    font-variant-numeric: tabular-nums;
  }
  .note-chip {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 100%;
    margin-top: 2px;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    background: var(--surface-1);
    color: var(--text-muted);
    font-size: 11px;
    padding: 2px 7px;
    cursor: pointer;
    transition: border-color var(--t-fast), color var(--t-fast), background var(--t-fast);
  }
  .note-chip :global(svg) {
    color: var(--accent);
    flex-shrink: 0;
  }
  .note-chip .nc-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .note-chip:hover {
    border-color: var(--accent-line);
    background: var(--accent-softer);
    color: var(--text);
  }
  .row-acts {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    opacity: 0.7;
    transition: opacity var(--t-fast);
  }
  .row:hover .row-acts {
    opacity: 1;
  }
  .rbtn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--border-strong);
    border-radius: var(--r-sm);
    background: transparent;
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 600;
    padding: 6px 10px;
    cursor: pointer;
    transition: background var(--t-fast), border-color var(--t-fast), color var(--t-fast);
  }
  .rbtn:hover {
    background: var(--surface-4);
    border-color: var(--accent-line);
    color: var(--text);
  }
  .rbtn.accent {
    border-color: var(--accent-line);
    color: var(--accent-bright);
    background: var(--accent-softer);
  }
  .rbtn.accent:hover {
    background: var(--accent-soft);
    color: var(--text);
  }
  .closed {
    flex-shrink: 0;
    font-size: 11px;
    font-style: italic;
    color: var(--text-ghost);
  }

  /* ---- empty ---- */
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    text-align: center;
    padding: 8vh 0 4vh;
    color: var(--text-faint);
  }
  .empty .glyph {
    opacity: 0.35;
  }
  .empty h3 {
    margin: 0;
    font-size: 15px;
    color: var(--text-muted);
  }
  .empty p {
    margin: 0;
    font-size: 12.5px;
    max-width: 320px;
  }

  /* ---- recent-days rail ---- */
  .rail {
    flex-shrink: 0;
    width: 150px;
    position: sticky;
    top: 0;
  }
  .rail-title {
    margin: 0 0 10px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .rail-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .rail-day {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 11px;
    border: 1px solid transparent;
    border-radius: var(--r-sm);
    background: transparent;
    color: var(--text-secondary);
    font-size: 12.5px;
    font-weight: 500;
    cursor: pointer;
    transition: background var(--t-fast), color var(--t-fast);
  }
  .rail-day:hover {
    background: var(--surface-3);
    color: var(--text);
  }
  .rail-day.on {
    background: var(--surface-4);
    border-color: var(--accent-line);
    color: var(--text);
    font-weight: 700;
  }
  .rd-count {
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    display: grid;
    place-items: center;
    border-radius: 9px;
    background: var(--surface-1);
    color: var(--text-muted);
    font-size: 10.5px;
    font-weight: 800;
  }
  .rail-day.on .rd-count {
    background: var(--accent);
    color: var(--accent-fg);
  }

  @media (max-width: 720px) {
    .rail {
      display: none;
    }
  }
</style>
