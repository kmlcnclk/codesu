/**
 * Claude Code's stream-json protocol, as the chat UI consumes it.
 *
 * The Rust side (`agent.rs`) hands us one {@link AgentFrame} per line of the child's
 * stdout, untouched. This module is the only place that knows the shape of those frames:
 * everything downstream renders {@link ChatItem}s and reads {@link ChatModel.turn}.
 *
 * Kept as a PURE reducer over frames — no store, no component, no Tauri — so the frame
 * shapes can be exercised against real captured output without an app. That is the whole
 * point of moving off screen scraping: `claudeScreen.ts` has to infer a turn's state from
 * rendered TUI text and pin it to a specific Claude Code version, while these frames say
 * so outright.
 *
 * An UNRECOGNISED `type` is ignored, on purpose. A real stream carries families this UI has
 * no use for — `system`/`hook_started`, `system`/`hook_response`, `rate_limit_event`
 * (all observed on Claude Code 2.1.260) — and new ones appear with new releases. Ignoring
 * them is what keeps a version bump from filling the transcript with noise; the frames that
 * actually matter (`assistant`, `user`, `result`, `stream_event`) are handled below, and a
 * line that is not even JSON still surfaces as a `malformed` frame rather than vanishing.
 */

/** One unit of output from the Rust side. Mirrors `agent::AgentFrame`. */
export type AgentFrame =
  | { kind: "frame"; data: Record<string, any> }
  | { kind: "malformed"; line: string }
  | { kind: "stderr"; line: string };

/** What the pane renders. One item per visible bubble. */
export type ChatItem =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; text: string }
  | { id: string; role: "thinking"; text: string }
  | {
      id: string;
      role: "tool";
      name: string;
      input: Record<string, any>;
      /** Filled in when the matching `tool_result` arrives; absent while running. */
      result?: string;
      isError?: boolean;
    }
  | { id: string; role: "system"; text: string; isError?: boolean };

/**
 * Turn state, in the same vocabulary the roster already sorts by
 * (see `AgentState` in the store, and `TurnState` in `claudeScreen.ts`).
 *
 * `blocked` is NOT produced here, and that is a real limitation rather than an oversight:
 * a permission prompt only becomes visible to us once a `--permission-prompt-tool` is
 * hosted, which is the next piece of work. Until then a headless session runs in a
 * permission mode that never prompts, so it never blocks.
 */
export type ChatTurn = "idle" | "working" | "done";

export interface ChatModel {
  items: ChatItem[];
  turn: ChatTurn;
  /** Live assistant text for the block currently being generated, if any. */
  streaming: string;
  /** Claude Code's own session id, from the `system`/`init` frame. */
  sessionId: string | null;
  model: string | null;
  /** Cumulative cost in USD, summed over the `result` frame of every turn. */
  costUsd: number;
  /** Set when the child reported a hard failure — an auth error, a bad flag. */
  fatal: string | null;
}

export function freshModel(): ChatModel {
  return {
    items: [],
    turn: "idle",
    streaming: "",
    sessionId: null,
    model: null,
    costUsd: 0,
    fatal: null,
  };
}

/** Monotonic ids, so Svelte's keyed each blocks never reuse a node across items. */
let seq = 0;
const nextId = () => `i${++seq}`;

/** Collapse Claude's `content` shapes (string, or an array of blocks) to plain text. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: any) => (typeof b === "string" ? b : typeof b?.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * Attach a tool result to the call it answers.
 *
 * Matched by `tool_use_id` rather than by position: subagents and parallel tool calls
 * interleave, so "the last tool item" is regularly the wrong one.
 */
function applyToolResult(items: ChatItem[], toolUseId: string, text: string, isError: boolean) {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.role === "tool" && item.id === toolUseId) {
      item.result = text;
      item.isError = isError;
      return true;
    }
  }
  return false;
}

/**
 * Fold one frame into the model, mutating it in place.
 *
 * In place because the caller holds it in a `$state` rune — Svelte 5 tracks the mutation,
 * and rebuilding the whole item list per frame would re-render the entire transcript on
 * every token of a streaming turn.
 */
export function applyFrame(m: ChatModel, frame: AgentFrame): void {
  if (frame.kind === "stderr") {
    // stderr is where a session that never produced a frame explains itself
    // (`claude: command not found`, an expired login). Never swallowed.
    m.items.push({ id: nextId(), role: "system", text: frame.line, isError: true });
    if (!m.fatal) m.fatal = frame.line;
    return;
  }
  if (frame.kind === "malformed") {
    m.items.push({ id: nextId(), role: "system", text: frame.line });
    return;
  }

  const f = frame.data;
  switch (f.type) {
    case "system": {
      if (f.subtype === "init") {
        m.sessionId = typeof f.session_id === "string" ? f.session_id : m.sessionId;
        m.model = typeof f.model === "string" ? f.model : m.model;
      }
      return;
    }

    case "assistant": {
      // The authoritative record of a block. Any live delta text is now redundant.
      m.streaming = "";
      for (const block of f.message?.content ?? []) {
        if (block.type === "text" && block.text?.trim()) {
          m.items.push({ id: nextId(), role: "assistant", text: block.text });
        } else if (block.type === "thinking" && block.thinking?.trim()) {
          m.items.push({ id: nextId(), role: "thinking", text: block.thinking });
        } else if (block.type === "tool_use") {
          // Keyed by the tool_use id so its result can find it later.
          m.items.push({
            id: block.id ?? nextId(),
            role: "tool",
            name: block.name ?? "tool",
            input: block.input ?? {},
          });
        }
      }
      m.turn = "working";
      return;
    }

    case "user": {
      // Tool results come back as a `user` frame — this is the CLI echoing the tool
      // loop, not the person typing. A real typed message is added by the pane itself
      // when it sends, so anything here that is not a tool result is ignored.
      for (const block of f.message?.content ?? []) {
        if (block.type !== "tool_result") continue;
        const text = contentText(block.content);
        const isError = block.is_error === true;
        if (!applyToolResult(m.items, block.tool_use_id, text, isError)) {
          // A result with no matching call (a resumed session whose earlier turns we
          // never saw) still deserves to be visible.
          m.items.push({ id: nextId(), role: "system", text, isError });
        }
      }
      return;
    }

    case "result": {
      m.streaming = "";
      m.turn = "done";
      if (typeof f.total_cost_usd === "number") m.costUsd += f.total_cost_usd;
      // `is_error` here means the TURN failed (max turns, an aborted tool loop) — worth
      // showing, and distinct from a tool that returned an error.
      if (f.is_error) {
        m.items.push({
          id: nextId(),
          role: "system",
          text: typeof f.result === "string" && f.result ? f.result : `Turn failed (${f.subtype})`,
          isError: true,
        });
      }
      return;
    }

    case "stream_event": {
      // Token deltas. Used ONLY for the live tail: the `assistant` frame that follows is
      // the record, so deltas are never appended to `items`. Trying to reconcile the two
      // is how a streamed turn ends up duplicated on screen.
      const ev = f.event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        m.streaming += ev.delta.text ?? "";
        m.turn = "working";
      } else if (ev?.type === "message_stop") {
        m.streaming = "";
      }
      return;
    }
  }
}

/** Record a message the user just sent, and mark the turn as running. */
export function pushUserMessage(m: ChatModel, text: string): void {
  m.items.push({ id: nextId(), role: "user", text });
  m.turn = "working";
  m.streaming = "";
}

/** A one-line summary of a tool call, for the collapsed header. */
export function toolSummary(name: string, input: Record<string, any>): string {
  const first =
    input.file_path ??
    input.path ??
    input.command ??
    input.pattern ??
    input.url ??
    input.prompt ??
    input.description;
  if (typeof first !== "string") return name;
  const oneLine = first.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${name} · ${oneLine.slice(0, 79)}…` : `${name} · ${oneLine}`;
}
