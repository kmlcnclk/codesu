<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { app, type ClaudePermissionMode, type Shortcut } from "$lib/store/app.svelte";
  import Icon from "./Icon.svelte";
  import { slack } from "$lib/slack.svelte";

  const PERM_MODES: { id: ClaudePermissionMode; label: string; desc: string }[] = [
    { id: "ask", label: "Ask every time", desc: "Claude's default — confirms before edits and before running commands." },
    { id: "edits", label: "Auto-accept edits", desc: "File edits go through silently; commands still ask." },
    {
      id: "full",
      label: "Never ask",
      desc: "Runs everything unattended, commands included. Best on a worktree you can throw away.",
    },
  ];

  /**
   * Paste-ready Slack app manifest: only USER scopes, because reactions.list reports
   * the reactions of whoever the token belongs to. Read-only — Codesu never posts.
   */
  const SLACK_MANIFEST = JSON.stringify(
    {
      display_information: { name: "Codesu" },
      oauth_config: {
        scopes: {
          user: ["reactions:read", "users:read", "channels:read", "groups:read", "im:read", "mpim:read"],
        },
      },
      settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
    },
    null,
    2,
  );

  type ChatKey = "chatLayout" | "chatFollowUp" | "chatToolOutput" | "chatPermissions" | "chatSendKey" | "chatSounds" | "chatRunResults";
  /** The rows shown under "Chat": one segmented control each. */
  const CHAT_OPTIONS: { key: ChatKey; label: string; desc: string; values: { value: string | boolean; label: string }[] }[] = [
    { key: "chatLayout", label: "Layout", desc: "Transcript keeps tool rows inline. Split moves them to a rail. Simple folds each step to one line.", values: [{ value: "transcript", label: "Transcript" }, { value: "split", label: "Split" }, { value: "simple", label: "Simple" }] },
    { key: "chatFollowUp", label: "Follow-up behaviour", desc: "Queue: a message sent while Claude works waits until the turn ends. Steer: Claude reads it at its next step. ⌘⏎ sends the other way.", values: [{ value: "queue", label: "Queue" }, { value: "steer", label: "Steer" }] },
    { key: "chatToolOutput", label: "Tool output", desc: "Collapsed shows one row per tool and opens on click. Expanded shows the output of every step as it arrives.", values: [{ value: "collapsed", label: "Collapsed" }, { value: "expanded", label: "Expanded" }] },
    { key: "chatPermissions", label: "Permission questions", desc: "Ask in chat shows a card and waits for you. Auto-allow answers tool permissions itself; questions and plans still ask.", values: [{ value: "ask", label: "Ask in chat" }, { value: "auto", label: "Auto-allow" }] },
    { key: "chatSendKey", label: "Send with", desc: "Which key sends the message; the other inserts a new line.", values: [{ value: "enter", label: "⏎" }, { value: "cmd-enter", label: "⌘⏎" }] },
    { key: "chatSounds", label: "Sounds in chat", desc: "Chime when a turn ends or Claude asks a question, same as the terminal view.", values: [{ value: true, label: "On" }, { value: false, label: "Off" }] },
    { key: "chatRunResults", label: "Send run results to the session", desc: "When a script or runner finishes, its exit code and output tail go to Claude as a message.", values: [{ value: "always", label: "Always" }, { value: "ask", label: "Ask" }, { value: "never", label: "Never" }] },
  ];
  function chatValue(key: ChatKey): string | boolean {
    return app[key];
  }
  function setChat(key: ChatKey, value: string | boolean) {
    app.setChatSetting(key, value as never);
  }

  let slackToken = $state("");
  let slackBusy = $state(false);
  let slackConnectError = $state<string | null>(null);
  let manifestCopied = $state(false);
  let emojiDraft = $state(app.slackEmoji);

  async function connectSlack() {
    if (!slackToken.trim() || slackBusy) return;
    slackBusy = true;
    slackConnectError = null;
    try {
      await slack.connect(slackToken);
      slackToken = "";
    } catch (e) {
      slackConnectError = String(e);
    } finally {
      slackBusy = false;
    }
  }

  async function disconnectSlack() {
    slackBusy = true;
    try {
      await slack.disconnect();
    } finally {
      slackBusy = false;
    }
  }

  function saveEmoji() {
    const was = app.slackEmoji;
    app.setSlackEmoji(emojiDraft);
    emojiDraft = app.slackEmoji;
    if (app.slackEmoji !== was) void slack.sync();
  }

  function copyManifest() {
    navigator.clipboard
      ?.writeText(SLACK_MANIFEST)
      .then(() => {
        manifestCopied = true;
        setTimeout(() => (manifestCopied = false), 1600);
      })
      .catch(() => {});
  }

  function fmtSince(ts: number | null): string {
    if (!ts) return "not yet";
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    return `${Math.round(s / 60)} min ago`;
  }

  let newPath = $state("");
  let error = $state<string | null>(null);
  let editingId = $state<string | null>(null);
  let recordingKey = $state(false);
  let recordedKey = $state<Partial<Shortcut> | null>(null);

  async function addProject() {
    error = null;
    const dir = await open({ directory: true, multiple: false, title: "Select a project folder" });
    if (typeof dir === "string") {
      try {
        app.addDefaultProject(dir);
        newPath = "";
      } catch (e) {
        error = String(e instanceof Error ? e.message : e);
      }
    }
  }

  function removeProject(path: string) {
    app.removeDefaultProject(path);
  }

  function startRecordingKey(shortcutId: string) {
    editingId = shortcutId;
    recordingKey = true;
    recordedKey = null;
  }

  function cancelRecording() {
    recordingKey = false;
    editingId = null;
    recordedKey = null;
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!recordingKey) return;
    e.preventDefault();
    // Captured on the window BEFORE the page's own shortcut handler (a bubble listener on
    // the same window), and stopped here — otherwise recording ⌘H would navigate to
    // History and unmount this page mid-recording.
    e.stopImmediatePropagation();

    recordedKey = {
      key: e.key.toLowerCase(),
      meta: e.metaKey,
      shift: e.shiftKey,
      ctrl: e.ctrlKey,
      alt: e.altKey,
    };
  }

  function saveRecordedKey(shortcutId: string) {
    if (!recordedKey || !editingId) return;

    app.updateShortcut(editingId, {
      key: recordedKey.key || "",
      meta: recordedKey.meta ?? false,
      shift: recordedKey.shift ?? false,
      ctrl: recordedKey.ctrl ?? false,
      alt: recordedKey.alt ?? false,
    });

    recordingKey = false;
    editingId = null;
    recordedKey = null;
  }

  function formatShortcut(shortcut: Shortcut): string {
    const parts = [];
    if (shortcut.meta) parts.push("⌘");
    if (shortcut.shift) parts.push("⇧");
    if (shortcut.ctrl) parts.push("⌃");
    if (shortcut.alt) parts.push("⌥");
    parts.push(shortcut.key.toUpperCase());
    return parts.join("");
  }

  function getContextLabel(context: string): string {
    const labels: Record<string, string> = {
      global: "Global",
      agents: "Agents Page",
      tasks: "Tasks Page",
      notes: "Notes Page",
      report: "Report Page",
      history: "History Page",
      settings: "Settings Page",
      terminal: "Terminal Page",
    };
    return labels[context] || context;
  }
</script>

<svelte:window onkeydowncapture={onKeyDown} />

<div class="page">
  <header class="page-head">
    <div class="titles">
      <h1>Settings</h1>
      <p>Default projects, Claude permissions, Slack and keyboard shortcuts for Codesu.</p>
    </div>
  </header>

  <div class="scroll">
   <div class="wrap">
  <!-- Default Projects Section -->
  <div class="section">
    <h2 class="section-title">Default projects</h2>
    <p class="desc">These projects are offered when you create a new workspace.</p>

    {#if app.defaultProjects.length > 0}
      <div class="projects-list">
        {#each app.defaultProjects as path (path)}
          <div class="project-item">
            <span class="path">{path}</span>
            <button
              class="remove-btn"
              title="Remove project"
              onclick={() => removeProject(path)}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        {/each}
      </div>
    {:else}
      <p class="empty-hint">No default projects yet — add one below.</p>
    {/if}

    <button class="add-btn" onclick={addProject}>
      <Icon name="plus" size={14} />
      Add default project
    </button>

    {#if error}
      <p class="error">{error}</p>
    {/if}
  </div>

  <!-- Claude Permissions Section -->
  <div class="section">
    <h2 class="section-title">Claude permissions</h2>
    <p class="desc">
      How much a Claude agent may do before it stops to ask you. Takes effect the next time
      an agent starts or resumes.
    </p>

    <div class="perm-list">
      {#each PERM_MODES as m (m.id)}
        <button
          class="perm-item"
          class:on={app.claudePermissionMode === m.id}
          aria-pressed={app.claudePermissionMode === m.id}
          onclick={() => app.setClaudePermissionMode(m.id)}
        >
          <span class="perm-radio" aria-hidden="true"></span>
          <span class="perm-text">
            <span class="perm-label">{m.label}</span>
            <span class="perm-desc">{m.desc}</span>
          </span>
        </button>
      {/each}
    </div>
  </div>

  <!-- Claude session view -->
  <div class="section">
    <h2 class="section-title">Claude session view</h2>
    <p class="desc">
      How a Claude agent's pane looks. Claude Code runs the same way in both; only what you
      see changes, and a pane can switch at any time from its strip.
    </p>
    <div class="perm-list">
      <button class="perm-item" class:on={app.claudeView === "chat"} aria-pressed={app.claudeView === "chat"} onclick={() => app.setChatSetting("claudeView", "chat")}>
        <span class="perm-radio" aria-hidden="true"></span>
        <span class="perm-text"><span class="perm-label">Chat</span><span class="perm-desc">Codesu's own view: the conversation, tool activity and permission questions, with a message box. Claude Code runs in the background.</span></span>
      </button>
      <button class="perm-item" class:on={app.claudeView === "terminal"} aria-pressed={app.claudeView === "terminal"} onclick={() => app.setChatSetting("claudeView", "terminal")}>
        <span class="perm-radio" aria-hidden="true"></span>
        <span class="perm-text"><span class="perm-label">Terminal</span><span class="perm-desc">The Claude Code terminal interface, exactly as in a shell. Best for slash commands and anything the chat view does not show.</span></span>
      </button>
    </div>
    <p class="slack-note">Applies when a pane starts; a pane that is running keeps its view until you switch it from its strip, and that choice is remembered for it.</p>

    {#if app.claudeView === "chat"}
      <div class="opt-list">
        {#each CHAT_OPTIONS as o (o.key)}
          <div class="opt-row">
            <div class="opt-text"><span class="perm-label">{o.label}</span><span class="perm-desc">{o.desc}</span></div>
            <div class="seg">
              {#each o.values as v (String(v.value))}
                <button class:on={chatValue(o.key) === v.value} onclick={() => setChat(o.key, v.value)}>{v.label}</button>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Slack Section -->
  <div class="section">
    <h2 class="section-title">Slack</h2>
    <p class="desc">
      React to any Slack message with <code>:{app.slackEmoji}:</code>{app.slackEmoji === "inbox_tray" ? " 📥" : ""}
      and it lands in Notes within a minute — with who said it and a link back. (Slack's own
      "Save for later" can't be read by apps, so a reaction does the bookmarking.)
    </p>

    {#if slack.account}
      <div class="projects-list">
        <div class="project-item">
          <span class="slack-who">
            <Icon name="hash" size={14} />
            Connected to <b>{slack.account.team}</b> as <b>{slack.account.user}</b>
          </span>
          <button class="reset-btn" onclick={disconnectSlack} disabled={slackBusy}>Disconnect</button>
        </div>
        <div class="project-item">
          <label class="slack-field" for="slack-emoji">Reaction</label>
          <input
            id="slack-emoji"
            class="slack-input emoji-input"
            bind:value={emojiDraft}
            onblur={saveEmoji}
            onkeydown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            spellcheck="false"
            placeholder="inbox_tray"
          />
        </div>
        <div class="project-item">
          <span class="slack-sync">
            {slack.syncing ? "Checking Slack…" : `Last checked ${fmtSince(slack.lastSyncAt)}`}
          </span>
          <button class="reset-btn" onclick={() => slack.sync()} disabled={slack.syncing}>Check now</button>
        </div>
      </div>
    {:else if slack.checked}
      <ol class="slack-steps">
        <li>
          At <b>api.slack.com/apps</b>, choose <b>Create New App → From a manifest</b>, pick your
          workspace, and paste this manifest
          <button class="link-btn" onclick={copyManifest}>
            <Icon name={manifestCopied ? "check" : "copy"} size={12} />
            {manifestCopied ? "Copied" : "Copy manifest"}
          </button>
        </li>
        <li>Click <b>Install to Workspace</b> (your admin may need to approve it).</li>
        <li>Under <b>OAuth &amp; Permissions</b>, copy the <b>User OAuth Token</b> (starts with <code>xoxp-</code>) and paste it here.</li>
      </ol>
      <form
        class="slack-connect"
        onsubmit={(e) => {
          e.preventDefault();
          void connectSlack();
        }}
      >
        <input
          class="slack-input"
          type="password"
          bind:value={slackToken}
          oninput={() => (slackConnectError = null)}
          placeholder="xoxp-…"
          autocomplete="off"
          spellcheck="false"
        />
        <button class="add-btn" type="submit" disabled={slackBusy || !slackToken.trim()}>
          {slackBusy ? "Connecting…" : "Connect"}
        </button>
      </form>
      <p class="slack-note">The token is kept in your macOS Keychain, never in Codesu's files.</p>
    {/if}

    {#if slackConnectError}
      <p class="error">{slackConnectError}</p>
    {:else if slack.error}
      <p class="error">{slack.error}</p>
    {/if}
  </div>

  <!-- Keyboard Shortcuts Section -->
  <div class="section">
    <div class="section-header">
      <div>
        <h2 class="section-title">Keyboard shortcuts</h2>
        <p class="desc">Customize keyboard shortcuts for each page context.</p>
      </div>
      <button class="reset-btn" onclick={() => app.resetShortcutsToDefault()}>
        Reset to defaults
      </button>
    </div>

    <div class="shortcuts-grid">
      {#each app.shortcuts as shortcut (shortcut.id)}
        <div class="shortcut-item">
          <div class="shortcut-info">
            <div class="shortcut-name">{shortcut.name}</div>
            <div class="shortcut-context">{getContextLabel(shortcut.context)}</div>
          </div>

          {#if editingId === shortcut.id && recordingKey}
            <div class="recording">
              <span class="recording-text">
                {recordedKey
                  ? formatShortcut({
                      key: recordedKey.key || "",
                      meta: recordedKey.meta ?? false,
                      shift: recordedKey.shift ?? false,
                      ctrl: recordedKey.ctrl ?? false,
                      alt: recordedKey.alt ?? false,
                      name: "",
                      id: "",
                      context: "global",
                      action: "",
                    })
                  : "Press any key..."}
              </span>
              <div class="recording-buttons">
                {#if recordedKey}
                  <button class="save-btn" onclick={() => saveRecordedKey(shortcut.id)}>
                    Save
                  </button>
                {/if}
                <button class="cancel-btn" onclick={cancelRecording}>Cancel</button>
              </div>
            </div>
          {:else}
            <button
              class="shortcut-key"
              onclick={() => startRecordingKey(shortcut.id)}
            >
              {formatShortcut(shortcut)}
            </button>
          {/if}
        </div>
      {/each}
    </div>
  </div>
   </div>
  </div>
</div>

<style>
  .page {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }

  /* Page header — matches History / Report / Notes. */
  .page-head {
    padding: 20px 24px 16px;
    border-bottom: 1px solid var(--border-muted);
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

  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 24px;
  }
  .wrap {
    max-width: 640px;
    margin: 0 auto;
  }

  .section {
    margin: 0 0 32px;
  }
  .section:last-child {
    margin-bottom: 0;
  }

  .section-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 4px;
  }

  /* Uppercase eyebrow section titles, shared with History / Report. */
  .section-title {
    margin: 0 0 6px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  .desc {
    margin: 0 0 16px;
    font-size: 13px;
    color: var(--text-secondary);
  }

  /* Same bordered stack as .projects-list, but each row is the radio itself. */
  .perm-list {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }

  .perm-item {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    width: 100%;
    padding: 12px 14px;
    text-align: left;
    background: var(--surface-1);
    border: none;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    font: inherit;
  }

  .perm-item:last-child {
    border-bottom: none;
  }

  .perm-item:hover {
    background: var(--surface-2);
  }

  .perm-radio {
    flex-shrink: 0;
    width: 14px;
    height: 14px;
    margin-top: 2px;
    border: 1px solid var(--border);
    border-radius: 50%;
    box-sizing: border-box;
  }

  .perm-item.on .perm-radio {
    border-color: var(--accent);
    border-width: 4px;
  }

  .perm-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .perm-label {
    font-size: 13px;
    color: var(--text);
  }

  .perm-desc {
    font-size: 12px;
    color: var(--text-muted);
  }

  .projects-list {
    display: flex;
    flex-direction: column;
    gap: 0;
    margin-bottom: 16px;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }

  .project-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    background: var(--surface-1);
    border-bottom: 1px solid var(--border);
    gap: 12px;
  }

  .project-item:last-child {
    border-bottom: none;
  }

  .path {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    font-family: ui-monospace, monospace;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .remove-btn {
    flex-shrink: 0;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px;
    border-radius: 5px;
    transition: background 0.12s ease, color 0.12s ease;
  }
  .remove-btn:hover {
    background: var(--danger-bg);
    color: var(--danger);
  }

  .empty-hint {
    margin: 0 0 16px;
    padding: 12px 14px;
    font-size: 12.5px;
    color: var(--text-faint);
    background: var(--surface-1);
    border: 1px dashed var(--border-strong);
    border-radius: 8px;
  }

  .add-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    border: 1px solid var(--border);
    background: var(--surface-1);
    color: var(--text-secondary);
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.13s, color 0.13s;
  }

  .add-btn:hover {
    background: var(--surface-2);
    color: var(--text);
  }

  /* ---- Chat options ---- */
  .opt-list {
    margin-top: 14px;
    border: 1px solid var(--border);
    border-radius: 9px;
    overflow: hidden;
  }
  .opt-row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 16px;
    align-items: center;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
  }
  .opt-row:last-child {
    border-bottom: 0;
  }
  .opt-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .seg {
    display: flex;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-2);
    flex: none;
  }
  .seg button {
    padding: 4px 10px;
    border-radius: 6px;
    border: 0;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .seg button.on {
    background: var(--surface-4);
    color: var(--text);
  }

  /* ---- Slack ---- */
  code {
    font-family: ui-monospace, monospace;
    font-size: 12px;
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--surface-2);
    color: var(--text);
  }
  .slack-who,
  .slack-sync {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--text-secondary);
  }
  .slack-who b {
    color: var(--text);
    font-weight: 600;
  }
  .slack-field {
    font-size: 13px;
    color: var(--text-secondary);
  }
  .slack-input {
    flex: 1;
    min-width: 0;
    padding: 9px 12px;
    font: inherit;
    font-size: 13px;
    font-family: ui-monospace, monospace;
    color: var(--text);
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    outline: none;
  }
  .slack-input:focus {
    border-color: var(--border-strong);
  }
  .emoji-input {
    flex: 0 1 200px;
    padding: 6px 10px;
  }
  .slack-steps {
    margin: 0 0 14px;
    padding-left: 20px;
    font-size: 13px;
    line-height: 1.6;
    color: var(--text-secondary);
  }
  .slack-steps b {
    color: var(--text);
    font-weight: 600;
  }
  .link-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: 4px;
    padding: 1px 8px;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    color: var(--text);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    cursor: pointer;
  }
  .slack-connect {
    display: flex;
    gap: 8px;
  }
  .slack-connect .add-btn:disabled,
  .reset-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .slack-note {
    margin: 8px 0 0;
    font-size: 12px;
    color: var(--text-faint);
  }

  .error {
    margin: 12px 0 0;
    padding: 10px 12px;
    font-size: 12px;
    color: var(--danger);
    background: rgba(255, 107, 107, 0.08);
    border: 1px solid rgba(255, 107, 107, 0.25);
    border-radius: 8px;
  }

  .reset-btn {
    padding: 8px 14px;
    border: 1px solid var(--border);
    background: var(--surface-1);
    color: var(--text-secondary);
    border-radius: 8px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.13s, color 0.13s;
  }

  .reset-btn:hover {
    background: var(--surface-2);
    color: var(--text);
  }

  .shortcuts-grid {
    display: flex;
    flex-direction: column;
    gap: 0;
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }

  .shortcut-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    background: var(--surface-1);
    border-bottom: 1px solid var(--border);
    gap: 12px;
  }

  .shortcut-item:last-child {
    border-bottom: none;
  }

  .shortcut-info {
    flex: 1;
  }

  .shortcut-name {
    font-size: 13px;
    font-weight: 500;
    color: var(--text);
    margin-bottom: 2px;
  }

  .shortcut-context {
    font-size: 11px;
    color: var(--text-muted);
  }

  .shortcut-key {
    padding: 6px 10px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text-secondary);
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    font-family: ui-monospace, monospace;
    cursor: pointer;
    min-width: 80px;
    text-align: center;
    transition: background 0.13s, color 0.13s;
    white-space: nowrap;
  }

  .shortcut-key:hover {
    background: var(--surface-2);
    color: var(--text);
    border-color: var(--accent);
  }

  .recording {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .recording-text {
    padding: 6px 10px;
    background: var(--accent-soft);
    color: var(--accent-bright);
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    font-family: ui-monospace, monospace;
    min-width: 80px;
    text-align: center;
  }

  .recording-buttons {
    display: flex;
    gap: 4px;
  }

  .save-btn,
  .cancel-btn {
    padding: 4px 10px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text-secondary);
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.13s, color 0.13s;
  }

  .save-btn:hover {
    background: var(--accent-soft);
    color: var(--accent-bright);
    border-color: var(--accent);
  }

  .cancel-btn:hover {
    background: var(--danger-bg);
    color: var(--danger);
    border-color: var(--danger-line);
  }
</style>
