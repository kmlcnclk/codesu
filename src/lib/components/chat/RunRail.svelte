<script lang="ts">
  /**
   * The Run rail: the repo's scripts, and the runner classes this session wrote or
   * changed. Scripts run on click; a runner entry point opens the launch dialog.
   */
  import { invoke } from "@tauri-apps/api/core";
  import { untrack } from "svelte";
  import type { ChatSession } from "$lib/chat/session.svelte";
  import { runs } from "$lib/chat/runs.svelte";
  import LaunchDialog, { type Runner } from "./LaunchDialog.svelte";
  import Icon from "../Icon.svelte";

  interface Script {
    id: string;
    name: string;
    command: string;
    source: string;
    cwd: string;
    file: string;
  }

  let {
    session,
    root,
    projectPath,
    agentId,
    onOpenTab,
  }: { session: ChatSession; root: string; projectPath: string; agentId: string; onOpenTab: (tabId: string) => void } = $props();

  let tab = $state<"scripts" | "runners">("runners");
  let scripts = $state<Script[]>([]);
  let runners = $state<Runner[]>([]);
  let baseline = $state<Set<string> | null>(null);
  let filter = $state("");
  let loading = $state(false);
  let launching = $state<{ runner: Runner; entry: string } | null>(null);
  let lastRuns = $state<Record<string, { target: string; at: number; exitCode: number | null }>>({});

  /** Files this session's Edit/Write calls touched, by path. */
  const touched = $derived.by(() => {
    const set = new Set<string>();
    const scan = (items: typeof session.items) => {
      for (const it of items) {
        if (it.kind !== "assistant") continue;
        for (const p of it.parts) {
          if (p.type !== "tool") continue;
          if ((p.name === "Edit" || p.name === "Write") && typeof p.input.file_path === "string") set.add(p.input.file_path);
          if (p.agent) scan(p.agent.items);
        }
      }
    };
    scan(session.items);
    return set;
  });
  function mark(r: Runner): "new" | "changed" | null {
    const abs = `${root.replace(/\/$/, "")}/${r.file}`;
    if (!touched.has(abs)) return null;
    return baseline && !baseline.has(r.file) ? "new" : "changed";
  }
  // Runners this session wrote come first; the rest keep module/class order.
  const shownRunners = $derived.by(() => {
    const list = runners.filter((r) => !filter.trim() || `${r.class} ${r.moduleName}`.toLowerCase().includes(filter.toLowerCase()));
    const rank = (r: Runner) => (mark(r) === "new" ? 0 : mark(r) === "changed" ? 1 : 2);
    return [...list].sort((a, b) => rank(a) - rank(b));
  });
  const shownScripts = $derived(scripts.filter((s) => !filter.trim() || `${s.name} ${s.source}`.toLowerCase().includes(filter.toLowerCase())));

  async function refresh() {
    if (!root || loading) return;
    loading = true;
    try {
      const [sc, rn] = await Promise.all([
        invoke<Script[]>("discover_scripts", { root }).catch(() => [] as Script[]),
        invoke<Runner[]>("discover_runners", { root }).catch(() => [] as Runner[]),
      ]);
      scripts = sc;
      runners = rn;
      if (!baseline) baseline = new Set(rn.map((r) => r.file));
    } finally {
      loading = false;
    }
  }
  // `refresh` reads and writes `loading`; untracked, or the effect would re-run on its
  // own completion and walk the repo without end.
  $effect(() => {
    void root;
    untrack(() => {
      baseline = null;
      void refresh();
    });
  });
  // Claude writes files during a turn; re-scan once when a turn ENDS (idle after
  // working), not on every render while idle.
  let wasBusy = false;
  $effect(() => {
    const busy = session.status === "working" || session.status === "waiting";
    if (wasBusy && !busy) untrack(() => void refresh());
    wasBusy = busy;
  });

  function runScript(s: Script) {
    const tabRun = runs.start(agentId, { name: s.name, target: "local", command: s.command, cwd: s.cwd });
    onOpenTab(tabRun.id);
  }
  function startRunner(opts: { target: string; env: Record<string, string>; command: string; label: string }) {
    const l = launching!;
    const key = `${l.runner.fqcn}.${l.entry}`;
    const tabRun = runs.start(agentId, { name: `${l.entry} · ${l.runner.class}`, target: opts.target, command: opts.command, cwd: root, env: opts.env });
    lastRuns[key] = { target: opts.target, at: Date.now(), exitCode: null };
    launching = null;
    onOpenTab(tabRun.id);
  }
  function isProd(entry: string) {
    return /prod/i.test(entry);
  }
</script>

<aside class="rail">
  <div class="head">
    <h4>Run</h4>
    <div class="seg">
      <button class:on={tab === "scripts"} onclick={() => (tab = "scripts")}>Scripts<b>{scripts.length}</b></button>
      <button class:on={tab === "runners"} onclick={() => (tab = "runners")}>Runners<b>{runners.length}</b></button>
    </div>
    <button class="mini" title="Rescan" onclick={refresh}><Icon name="restore" size={12} /></button>
  </div>
  <div class="filter"><Icon name="search" size={12} /><input placeholder={tab === "runners" ? "Filter runners…" : "Filter scripts…"} bind:value={filter} /></div>
  <div class="body">
    {#if tab === "runners"}
      {#if !shownRunners.length}
        <p class="empty">{loading ? "Scanning…" : runners.length ? "No runner matches." : "No runner classes in this workspace. A `*Runner.kt` with @Test entry points shows up here."}</p>
      {/if}
      {#each shownRunners as r (r.file)}
        {@const m = mark(r)}
        <div class="card" class:hot={m === "new"}>
          <div class="ch">
            <div class="cn" title={r.file}>{r.class}</div>
            <div class="cm">{r.moduleName}{#if m}<span class="tag {m}">{m}</span>{/if}</div>
            <span class="cnt">{r.entries.length} entry point{r.entries.length === 1 ? "" : "s"}</span>
          </div>
          {#each r.entries as e (e)}
            {@const last = lastRuns[`${r.fqcn}.${e}`]}
            <button class="row" onclick={() => (launching = { runner: r, entry: e })}>
              <span class="rn">{e}</span>
              {#if last}<span class="st ok">✓ {last.target} · {new Date(last.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>{:else if isProd(e)}<span class="tag prod">prod</span>{:else}<span></span>{/if}
              <span class="go"><Icon name="play" size={10} /></span>
            </button>
          {/each}
        </div>
      {/each}
    {:else}
      {#if !shownScripts.length}<p class="empty">{loading ? "Scanning…" : "No scripts found (package.json, Makefile, Cargo, Gradle, Go, Python, shell)."}</p>{/if}
      {#each shownScripts as s (s.id)}
        <button class="row script" onclick={() => runScript(s)} title={s.command}>
          <span class="rn">{s.name}</span><span class="src">{s.source}{s.file ? ` · ${s.file}` : ""}</span><span class="go"><Icon name="play" size={10} /></span>
        </button>
      {/each}
    {/if}
  </div>
  <div class="foot"><span>Prod runs always confirm first.</span></div>
</aside>

{#if launching}
  <LaunchDialog runner={launching.runner} entry={launching.entry} {projectPath} lastRun={lastRuns[`${launching.runner.fqcn}.${launching.entry}`] ?? null} onClose={() => (launching = null)} onStart={startRunner} />
{/if}

<style>
  .rail { border-left: 1px solid var(--border); background: var(--surface-1); display: grid; grid-template-rows: auto auto 1fr auto; min-height: 0; overflow: hidden; height: 100%; }
  .foot { font-size: 11.5px; color: var(--text-faint); }
  .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px 8px; }
  h4 { margin: 0; font-size: 13px; font-weight: 700; color: var(--text); margin-right: auto; }
  .seg { display: flex; gap: 2px; padding: 2px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); }
  .seg button { padding: 4px 9px; border-radius: 6px; border: 0; background: transparent; color: var(--text-muted); font: inherit; font-size: 12px; cursor: pointer; }
  .seg button.on { background: var(--surface-4); color: var(--text); }
  .seg b { font-weight: 600; color: var(--text-faint); margin-left: 4px; }
  .mini { width: 24px; height: 24px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text-muted); display: grid; place-items: center; cursor: pointer; }
  .filter { margin: 0 12px 8px; height: 28px; display: flex; align-items: center; gap: 8px; padding: 0 10px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface-2); color: var(--text-ghost); }
  .filter input { flex: 1; min-width: 0; border: 0; background: transparent; color: var(--text); font: inherit; font-size: 12px; outline: none; }
  .body { overflow: auto; padding: 0 12px 12px; display: grid; gap: 10px; align-content: start; }
  .empty { font-size: 12px; color: var(--text-faint); margin: 8px 2px; line-height: 1.5; }
  .card { border: 1px solid var(--border); border-radius: 10px; background: var(--surface-2); overflow: hidden; }
  .card.hot { border-color: rgba(89, 168, 105, 0.35); }
  .ch { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; padding: 10px 12px 8px; }
  .cn { font-family: var(--font-mono); font-size: 12.5px; font-weight: 700; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cm { grid-column: 1; display: flex; gap: 6px; align-items: center; font-size: 11px; color: var(--text-faint); }
  .cnt { grid-column: 2; grid-row: 1; font-size: 11px; color: var(--text-faint); white-space: nowrap; }
  .tag { display: inline-flex; align-items: center; height: 17px; padding: 0 6px; border-radius: 4px; font-size: 10.5px; font-weight: 600; }
  .tag.new { background: rgba(89, 168, 105, 0.16); color: var(--ok); }
  .tag.changed { background: rgba(232, 176, 75, 0.16); color: var(--hue-amber); }
  .tag.prod { background: rgba(247, 84, 100, 0.14); color: var(--danger); }
  .row { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; align-items: center; width: 100%; height: 32px; padding: 0 8px 0 12px; border: 0; border-top: 1px solid var(--border-muted); background: transparent; color: var(--text-secondary); font: inherit; font-family: var(--font-mono); font-size: 12px; text-align: left; cursor: pointer; }
  .row:hover { background: var(--surface-3); color: var(--text); }
  .row.script { border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); }
  .rn { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .src { font-family: var(--font-sans); font-size: 11px; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 140px; }
  .st { font-family: var(--font-sans); font-size: 11px; color: var(--text-faint); white-space: nowrap; }
  .st.ok { color: var(--ok); }
  .go { width: 24px; height: 24px; border-radius: 6px; display: grid; place-items: center; color: var(--text-faint); border: 1px solid transparent; }
  .row:hover .go { background: var(--accent); color: #fff; border-color: var(--accent); }
</style>
