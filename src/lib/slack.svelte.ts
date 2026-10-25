/**
 * Slack → Notes. React to a Slack message with the chosen emoji (📥 by default) and it shows up on the
 * Notes page within a minute.
 *
 * All the Slack work happens in Rust (src-tauri/src/slack.rs) — the token never enters
 * the webview. This module only owns the connection state and the poll loop; turning
 * messages into notes is the store's job (app.importSlackMessages).
 */
import { invoke } from "@tauri-apps/api/core";
import { app, type SlackMessage } from "$lib/store/app.svelte";

export interface SlackAccount {
  team: string;
  user: string;
  user_id: string;
  url: string;
}

/** How often Slack is asked for new reactions. `reactions.list` allows 20+/min. */
const POLL_MS = 60_000;

class SlackSync {
  /** The connected account; null when Slack isn't connected (or not checked yet). */
  account = $state<SlackAccount | null>(null);
  /** False until the Keychain has been checked once at startup. */
  checked = $state(false);
  syncing = $state(false);
  /** The last poll's failure, shown in Settings. Cleared by the next good poll. */
  error = $state<string | null>(null);
  lastSyncAt = $state<number | null>(null);
  /** Notes added by the most recent poll that found any. */
  lastImported = $state(0);

  private timer: ReturnType<typeof setInterval> | null = null;
  /** Bumped by disconnect, so a poll that was in flight cannot write its result back. */
  private gen = 0;

  /** Restore the connection from the Keychain and start polling. Called once at launch. */
  async init() {
    try {
      this.account = await invoke<SlackAccount | null>("slack_account");
    } catch (e) {
      // A token is stored but Slack refused it (revoked, offline): say so in Settings,
      // and still poll — a network blip at launch shouldn't need a reconnect.
      this.error = String(e);
    } finally {
      this.checked = true;
    }
    if (this.account || this.error) this.start();
  }

  async connect(token: string) {
    this.account = await invoke<SlackAccount>("slack_connect", { token });
    this.error = null;
    this.start();
  }

  async disconnect() {
    this.stop();
    this.gen++;
    await invoke("slack_disconnect");
    this.account = null;
    this.error = null;
    this.lastSyncAt = null;
  }

  /** Poll now; overlapping calls are dropped rather than queued. */
  async sync() {
    if (this.syncing) return;
    this.syncing = true;
    const gen = this.gen;
    try {
      const msgs = await invoke<SlackMessage[]>("slack_poll", { emoji: app.slackEmoji });
      if (gen !== this.gen) return;
      const added = app.importSlackMessages(msgs);
      if (added) this.lastImported = added;
      // Launch-time check failed (e.g. offline) but Slack answers now — fill it in.
      if (!this.account) this.account = await invoke<SlackAccount | null>("slack_account");
      this.error = null;
      this.lastSyncAt = Date.now();
    } catch (e) {
      if (gen === this.gen) this.error = String(e);
    } finally {
      this.syncing = false;
    }
  }

  private start() {
    this.stop();
    void this.sync();
    this.timer = setInterval(() => void this.sync(), POLL_MS);
  }

  private stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const slack = new SlackSync();
