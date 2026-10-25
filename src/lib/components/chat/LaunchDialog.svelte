<script lang="ts">
  /**
   * Launch one runner entry point: pick the target (dev / prod), toggle a dry run, see
   * and fix the variables that will be injected, read the exact command, and go.
   * Variables come from the project's environment profile, kept in Codesu's data folder
   * (never in the repo); the dialog can write to it ("Set…", extra variables).
   */
  import { invoke } from "@tauri-apps/api/core";
  import { app } from "$lib/store/app.svelte";
  import Icon from "../Icon.svelte";

  export interface Runner {
    class: string;
    fqcn: string;
    module: string;
    moduleName: string;
    file: string;
    entries: string[];
  }
  interface Profile {
    targets: Record<string, Record<string, string>>;
    runners: Record<string, Record<string, string>>;
  }

  let {
    runner,
    entry,
    projectPath,
    lastRun = null,
    onClose,
    onStart,
  }: {
    runner: Runner;
    entry: string;
    projectPath: string;
    lastRun?: { target: string; at: number; exitCode: number | null } | null;
    onClose: () => void;
    onStart: (opts: { target: string; env: Record<string, string>; command: string; label: string }) => void;
  } = $props();

  let target = $state<"dev" | "prod">("dev");
  let dryRun = $state(true);
  let memory = $state("1g");
  let profile = $state<Profile>({ targets: { dev: {}, prod: {} }, runners: {} });
  let loaded = $state(false);
  let command = $state("");
  let prodConfirmed = $state(false);
  let fixing = $state<string | null>(null);
  let fixValue = $state("");
  let newName = $state("");
  let newValue = $state("");
  let error = $state<string | null>(null);

  const runnerKey = $derived(`${runner.fqcn}.${entry}`);
  /** Variables the repo's own conventions say a runner needs. */
  const REQUIRED = ["MICRONAUT_ENVIRONMENTS", "AWS_PROFILE"];

  const injected = $derived.by(() => {
    const t = profile.targets[target] ?? {};
    const rows: { k: string; v: string | null; source: string }[] = [];
    for (const k of REQUIRED) rows.push({ k, v: t[k] ?? null, source: t[k] != null ? `profile · ${target}` : "missing" });
    for (const [k, v] of Object.entries(t)) if (!REQUIRED.includes(k)) rows.push({ k, v, source: `profile · ${target}` });
    return rows;
  });
  const extra = $derived(Object.entries(profile.runners[runnerKey] ?? {}));
  const env = $derived.by(() => {
    const e: Record<string, string> = { ...(profile.targets[target] ?? {}), ...(profile.runners[runnerKey] ?? {}) };
    e.DRY_RUN = dryRun ? "1" : "0";
    e.JAVA_TOOL_OPTIONS = `-Xmx${memory}`;
    return e;
  });
  const missing = $derived(injected.filter((r) => r.v == null).map((r) => r.k));
  const label = $derived(`${dryRun ? "dry run" : "run"} ${entry} on ${target}`);
  const canStart = $derived(target === "dev" || prodConfirmed);
  // A tick given for one target/mode does not carry over to another.
  $effect(() => {
    void target;
    void dryRun;
    prodConfirmed = false;
  });

  $effect(() => {
    void (async () => {
      try {
        profile = await invoke<Profile>("env_profile_load", { project: projectPath });
      } catch (e) {
        error = String(e);
      }
      try {
        command = await invoke<string>("runner_command", { runner, entry });
      } catch (e) {
        error = String(e);
      }
      loaded = true;
    })();
  });

  async function save() {
    try {
      await invoke("env_profile_save", { project: projectPath, profile });
    } catch (e) {
      error = String(e);
    }
  }
  function setVar(k: string) {
    if (!profile.targets[target]) profile.targets[target] = {};
    profile.targets[target][k] = fixValue.trim();
    fixing = null;
    fixValue = "";
    void save();
  }
  function addExtra() {
    const k = newName.trim();
    if (!k) return;
    if (!profile.runners[runnerKey]) profile.runners[runnerKey] = {};
    profile.runners[runnerKey][k] = newValue;
    newName = "";
    newValue = "";
    void save();
  }
  function setExtra(k: string, v: string) {
    profile.runners[runnerKey][k] = v;
    void save();
  }
  function removeExtra(k: string) {
    delete profile.runners[runnerKey][k];
    void save();
  }
  function start() {
    if (!canStart) return;
    onStart({ target, env, command, label });
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") onClose();
    if (e.key === "Enter" && e.metaKey) start();
  }
  const preview = $derived(
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ") +
      (missing.length ? " " + missing.map((k) => `${k}=?`).join(" ") : "") +
      " " +
      command,
  );
</script>

<svelte:window onkeydown={onKey} />

<div class="backdrop" role="presentation" onclick={onClose}></div>
<div class="dlg" role="dialog" aria-label="Run {entry}">
  <div class="h">
    <span class="ico"><Icon name="play" size={14} /></span>
    <div class="titles">
      <div class="t">{entry} <code>· {runner.class}</code></div>
      <div class="sub"><span>{runner.moduleName}</span>{#if lastRun}<span>·</span><span>last run on {lastRun.target} {new Date(lastRun.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}, exit {lastRun.exitCode ?? "?"}</span>{/if}</div>
    </div>
    <button class="x" onclick={onClose} title="Close (esc)"><Icon name="close" size={14} /></button>
  </div>

  <div class="ctl">
    <div class="tgt">
      <button class:on={target === "dev"} class="dev" onclick={() => (target = "dev")}><i></i>Dev</button>
      <button class:on={target === "prod"} class="prod" onclick={() => (target = "prod")}><i></i>Prod</button>
    </div>
    <div class="sw-l"><span class="sw" class:on={dryRun} role="switch" aria-checked={dryRun} tabindex="0" onclick={() => (dryRun = !dryRun)} onkeydown={(e) => e.key === " " && (dryRun = !dryRun)}></span>Dry run <small>· DRY_RUN={dryRun ? 1 : 0}{dryRun ? ", no writes" : ""}</small></div>
    <label class="sw-l mem"><span class="dim">Memory</span>
      <select bind:value={memory}><option value="512m">512 MB</option><option value="1g">1 GB</option><option value="2g">2 GB</option><option value="4g">4 GB</option></select>
    </label>
  </div>

  <div class="b">
    <div>
      <div class="sec">Variables <small>for {target} · names and non-secret values only; the profile is a plain file</small></div>
      <div class="vt">
        {#each injected as row (row.k)}
          <div>
            <span class="k">{row.k}</span>
            {#if fixing === row.k}
              <span class="v"><input bind:value={fixValue} placeholder="value" onkeydown={(e) => { if (e.key === "Enter") setVar(row.k); if (e.key === "Escape") fixing = null; }} /></span>
              <span class="src"><button class="link" onclick={() => setVar(row.k)}>Save</button></span>
            {:else}
              <span class="v" class:ghost={row.v == null}>{row.v ?? "not set"}</span>
              <span class="src" class:miss={row.v == null}><i></i>{row.v == null ? "missing in profile" : row.source} <button class="link" onclick={() => { fixing = row.k; fixValue = row.v ?? ""; }}>{row.v == null ? "Set…" : "Edit"}</button></span>
            {/if}
          </div>
        {/each}
        <div><span class="k">DRY_RUN</span><span class="v">{dryRun ? 1 : 0}</span><span class="src"><i></i>dry run switch</span></div>
        {#each extra as [k, v] (k)}
          <div><span class="k">{k}</span><span class="v"><input value={v} aria-label="{k} value" onchange={(e) => setExtra(k, e.currentTarget.value)} /></span><span class="src">remembered for this runner <button class="link" onclick={() => removeExtra(k)}>Remove</button></span></div>
        {/each}
        <div class="add"><span class="k"><input bind:value={newName} placeholder="NAME" /></span><span class="v"><input bind:value={newValue} placeholder="value" onkeydown={(e) => e.key === "Enter" && addExtra()} /></span><span class="src"><button class="link" onclick={addExtra}>+ Add variable</button></span></div>
      </div>
    </div>
    <div>
      <div class="sec">Command</div>
      <div class="cmd"><button class="copy" title="Copy" onclick={() => navigator.clipboard?.writeText(preview).catch(() => {})}><Icon name="copy" size={12} /></button>{preview}</div>
    </div>
    {#if target === "prod"}
      <label class="confirm"><input type="checkbox" bind:checked={prodConfirmed} /> I understand this runs against production.</label>
    {/if}
    {#if error}<p class="err">{error}</p>{/if}
  </div>

  <div class="f">
    <span class="hint">⌘⏎ runs · esc closes · output opens in a tab{app.chatRunResults === "always" ? ", result goes to the session" : ""}</span>
    <button class="btn" onclick={onClose}>Cancel</button>
    <button class="btn go" class:prod={target === "prod"} disabled={!canStart || !loaded} onclick={start}><Icon name="play" size={12} /> {dryRun ? "Run dry run" : `Run ${entry}`} on {target}</button>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 40; background: rgba(0, 0, 0, 0.45); }
  .dlg { position: fixed; z-index: 41; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(760px, calc(100vw - 48px)); max-height: calc(100vh - 48px); overflow: auto; background: var(--surface-float); border: 1px solid var(--border-strong); border-radius: 14px; box-shadow: var(--shadow-xl); font-size: 13px; color: var(--text); }
  .h { display: flex; gap: 12px; align-items: center; padding: 16px 20px 14px; }
  .ico { width: 36px; height: 36px; border-radius: 9px; background: rgba(232, 176, 75, 0.16); color: var(--hue-amber); display: grid; place-items: center; flex: none; }
  .titles { min-width: 0; }
  .t { font-size: 16px; font-weight: 700; letter-spacing: -0.01em; }
  .t code { font-family: var(--font-mono); font-weight: 500; font-size: 13px; color: var(--text-muted); }
  .sub { margin-top: 3px; display: flex; gap: 8px; font-size: 12px; color: var(--text-faint); }
  .x { margin-left: auto; background: none; border: 0; color: var(--text-faint); cursor: pointer; padding: 4px; }
  .x:hover { color: var(--text); }
  .ctl { display: flex; gap: 10px; align-items: center; padding: 0 20px 14px; flex-wrap: wrap; }
  .tgt { display: flex; padding: 3px; gap: 2px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface-2); }
  .tgt button { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 7px; border: 0; background: transparent; color: var(--text-muted); font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; }
  .tgt button i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .tgt .dev.on { background: rgba(89, 168, 105, 0.18); color: #9ad9a6; }
  .tgt .prod.on { background: rgba(247, 84, 100, 0.16); color: #f3a0a8; }
  .sw-l { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-secondary); padding: 5px 10px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface-2); }
  .sw-l small, .dim { color: var(--text-faint); }
  .sw { width: 30px; height: 18px; border-radius: 9px; background: var(--surface-4); position: relative; flex: none; cursor: pointer; }
  .sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; opacity: 0.8; transition: left var(--t-fast); }
  .sw.on { background: var(--accent); }
  .sw.on::after { left: 14px; opacity: 1; }
  .mem select { background: var(--surface-1); color: var(--text); border: 1px solid var(--border); border-radius: 6px; font: inherit; font-size: 12px; padding: 2px 6px; }
  .b { padding: 0 20px 6px; display: grid; gap: 16px; }
  .sec { display: flex; align-items: baseline; gap: 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-faint); margin-bottom: 8px; }
  .sec small { font-weight: 500; letter-spacing: 0; text-transform: none; font-size: 11.5px; }
  .vt { border: 1px solid var(--border); border-radius: 9px; overflow: hidden; background: var(--surface-1); }
  .vt > div { display: grid; grid-template-columns: 230px 1fr 190px; align-items: center; min-height: 36px; border-top: 1px solid var(--border-muted); }
  .vt > div:first-child { border-top: 0; }
  .vt .k { padding: 0 12px; font-family: var(--font-mono); font-size: 12px; }
  .vt .v { padding: 0 12px; font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vt .v.ghost { color: var(--text-ghost); }
  .vt input { width: 100%; box-sizing: border-box; height: 26px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-2); color: var(--text); font: inherit; font-family: var(--font-mono); font-size: 12px; padding: 0 8px; outline: none; }
  .vt input:focus { border-color: var(--accent); }
  .vt .src { padding: 0 12px; font-size: 11px; color: var(--text-faint); display: flex; align-items: center; gap: 6px; justify-content: flex-end; white-space: nowrap; }
  .vt .src i { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); }
  .vt .src.miss { color: var(--danger); }
  .vt .src.miss i { background: var(--danger); }
  .link { background: none; border: 0; color: var(--accent-bright); font: inherit; font-size: 11.5px; font-weight: 600; cursor: pointer; padding: 0; }
  .add .k, .add .v { padding: 4px 8px; }
  .cmd { position: relative; border: 1px solid var(--border); border-radius: 9px; background: var(--surface-1); padding: 10px 44px 10px 12px; font-family: var(--font-mono); font-size: 12px; line-height: 1.6; color: var(--text-secondary); white-space: pre-wrap; word-break: break-all; }
  .copy { position: absolute; right: 8px; top: 8px; width: 26px; height: 26px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text-muted); display: grid; place-items: center; cursor: pointer; }
  .confirm { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: #f3a0a8; }
  .err { margin: 0; color: var(--danger); font-size: 12px; }
  .f { display: flex; align-items: center; gap: 8px; padding: 14px 20px 16px; border-top: 1px solid var(--border); margin-top: 10px; }
  .hint { font-size: 11.5px; color: var(--text-faint); margin-right: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .f .btn { flex: none; }
  .btn { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 14px; border-radius: 7px; border: 1px solid var(--border-strong); background: var(--surface-2); color: var(--text); font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; }
  .btn.go { background: var(--ok); border-color: var(--ok); color: #0f1a12; }
  .btn.go.prod { background: var(--danger); border-color: var(--danger); color: #fff; }
  .btn:disabled { opacity: 0.5; cursor: default; }
</style>
