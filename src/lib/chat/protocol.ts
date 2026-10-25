/**
 * The Claude Code CLI's stream-json protocol, as far as the Chat view reads it.
 *
 * One JSON object per line in both directions. Shapes verified against Claude Code
 * 2.1.310 (see the probes in the design notes): `system` init/status, `assistant` and
 * `user` messages (the latter carrying tool results), `stream_event` partials,
 * `control_request` / `control_response` for permissions and questions, `result` at the
 * end of a turn, and `rate_limit_event` for the usage meter.
 */

export interface TextBlock {
  type: "text";
  text: string;
}
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string; [k: string]: unknown }>;
  is_error?: boolean;
}
export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | ImageBlock;

export interface ApiMessage {
  id?: string;
  role: "user" | "assistant";
  model?: string;
  content: string | ContentBlock[];
  stop_reason?: string | null;
  usage?: Usage;
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface RateWindow {
  utilization: number;
  resetsAt: number;
  status?: string;
}

/** One line from the CLI. Only the fields the UI reads are typed. */
export interface CliLine {
  type: string;
  subtype?: string;
  session_id?: string;
  uuid?: string;
  parent_tool_use_id?: string | null;
  // system
  model?: string;
  permissionMode?: string;
  cwd?: string;
  tools?: string[];
  // assistant / user
  message?: ApiMessage;
  // stream_event
  event?: StreamEvent;
  // control
  request_id?: string;
  request?: ControlRequest;
  response?: ControlResponseEnvelope;
  // result
  is_error?: boolean;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: Usage;
  result?: string | null;
  // rate limits
  rate_limit_info?: {
    status?: string;
    rateLimitType?: string;
    unifiedWindows?: Record<string, RateWindow>;
  };
}

export interface StreamEvent {
  type:
    | "message_start"
    | "content_block_start"
    | "content_block_delta"
    | "content_block_stop"
    | "message_delta"
    | "message_stop";
  index?: number;
  message?: ApiMessage;
  content_block?: ContentBlock;
  delta?: {
    type: "text_delta" | "thinking_delta" | "input_json_delta" | string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: Usage;
}

export interface ControlRequest {
  subtype: "can_use_tool" | "initialize" | "interrupt" | string;
  tool_name?: string;
  display_name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  requires_user_interaction?: boolean;
}

export interface ControlResponseEnvelope {
  subtype: "success" | "error";
  request_id: string;
  response?: Record<string, unknown> & { commands?: SlashCommand[] };
  error?: string;
}

export interface SlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
}

/** A question as `AskUserQuestion` poses it. */
export interface AskedQuestion {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

// ---------- lines the UI writes ----------

export function userLine(content: string | ContentBlock[], parentToolUseId: string | null = null): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: parentToolUseId,
  });
}

export function initializeLine(requestId: string): string {
  return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } });
}

export function interruptLine(requestId: string): string {
  return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } });
}

export type PermissionDecision =
  | { behavior: "allow"; updatedInput: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export function controlResponseLine(requestId: string, decision: PermissionDecision): string {
  return JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response: decision },
  });
}

/** Flatten a tool result's content to text for display. */
export function resultText(content: ToolResultBlock["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((c) => (typeof c.text === "string" ? c.text : c.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}
