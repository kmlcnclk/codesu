/**
 * The headless counterpart to `createTerminal`.
 *
 * Where that mounts xterm over a PTY, this owns a `claude -p --output-format stream-json`
 * child and a frame channel:
 *
 *   Rust agent --(batched JSON frames over ipc::Channel)--> onFrames()
 *   send(text) --(invoke send_agent)-----------------------> child stdin
 *
 * Frames arrive BATCHED (see `agent::pump`) because `--include-partial-messages` turns one
 * assistant turn into hundreds of small deltas, and one IPC message each is pure overhead.
 * The callback therefore takes an array, and the caller should fold the whole batch before
 * letting Svelte re-render.
 */

import { invoke, Channel } from "@tauri-apps/api/core";
import type { AgentFrame } from "./protocol";

export interface AgentSessionOptions {
  /** Claude Code session id (uuid). Resumed if a transcript exists, else created. */
  sessionId: string;
  /** Must exist — `--resume` is project-scoped, so the wrong cwd loses the session. */
  cwd: string;
  /** Seed prompt for a brand-new session's first turn. */
  prompt?: string | null;
  /** Per-agent isolated Claude home (see `claude_agent_env`). */
  env?: Record<string, string> | null;
  /**
   * Permission mode. `manual` is rejected by the Rust side on purpose: nothing can
   * answer a prompt yet, so a session in that mode denies every tool call silently.
   */
  permissionMode?: "acceptEdits" | "auto" | "bypassPermissions" | "dontAsk" | "plan";
  /** Stream token deltas for a live typing tail. */
  partialMessages?: boolean;
  onFrames: (frames: AgentFrame[]) => void;
}

export interface AgentSessionHandle {
  send: (text: string) => Promise<void>;
  dispose: () => void;
}

export async function createAgentSession(
  id: string,
  options: AgentSessionOptions,
): Promise<AgentSessionHandle> {
  const channel = new Channel<AgentFrame[]>();
  let disposed = false;
  channel.onmessage = (frames) => {
    // A batch can still be in flight when the pane tears down; dropping it here keeps a
    // disposed session from writing into a model nothing renders any more.
    if (!disposed) options.onFrames(frames);
  };

  await invoke("start_agent", {
    id,
    sessionId: options.sessionId,
    cwd: options.cwd,
    prompt: options.prompt ?? null,
    permissionMode: options.permissionMode ?? "acceptEdits",
    partialMessages: options.partialMessages ?? true,
    env: options.env ?? null,
    onData: channel,
  });

  return {
    /**
     * Send one user message. Rejects if the child is gone, which the pane surfaces
     * rather than leaving the message looking sent.
     */
    send: (text: string) => invoke("send_agent", { id, text }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // Fire and forget: kill_agent closes stdin and SIGTERMs, so the transcript is
      // flushed and the session stays resumable.
      invoke("kill_agent", { id }).catch(() => {});
    },
  };
}
