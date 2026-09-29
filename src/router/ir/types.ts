/**
 * The intermediate representation.
 *
 * Everything between the wire boundary and the providers is this shape. Both
 * inbound dialects decode into it; every provider encodes out of it. Neither
 * dialect's vocabulary appears here, and neither decoder imports the other.
 *
 * The load-bearing type is `IRToolCall.arguments: Record<string, unknown>`.
 * The existing `parseToolCalls` turns a malformed `arguments` string into `{}`
 * and the call proceeds with empty parameters — a silent failure this project
 * already has. The IR makes that state structurally unrepresentable: there is
 * no way to express "the model said something we could not parse" as a valid
 * IRToolCall, so anything that constructs one has had to deal with the failure.
 */

export type Modality = "text" | "audio" | "image" | "video";

export interface IRTextPart {
  type: "text";
  text: string;
}

export interface IRImagePart {
  type: "image_url";
  /** An http(s) URL or a `data:` URI. */
  url: string;
  mime?: string;
}

export interface IRAudioPart {
  type: "input_audio";
  /** Base64 payload WITHOUT the data-URI prefix, matching OpenAI's field. */
  data: string;
  mime: string;
}

export interface IRVideoPart {
  type: "video_url";
  url: string;
  mime?: string;
}

export type IRContentPart = IRTextPart | IRImagePart | IRAudioPart | IRVideoPart;

export interface IRThinkingBlock {
  type: "thinking";
  thinking: string;
  /** Anthropic signs thinking blocks; the signature must round-trip. */
  signature?: string;
}

export interface IRToolCall {
  id: string;
  name: string;
  /** Always an object. Never a raw or empty-by-default string. */
  arguments: Record<string, unknown>;
}

export interface IRToolDef {
  name: string;
  description: string;
  /** JSON Schema. Anthropic calls this `input_schema`; OpenAI `parameters`. */
  input_schema: Record<string, unknown>;
}

export type IRRole = "system" | "user" | "assistant" | "tool";

export interface IRMessage {
  role: IRRole;
  content: string | IRContentPart[];
  /** Anthropic-only in practice; empty on the OpenAI inbound path. */
  thinking?: IRThinkingBlock[];
  /** Present on role:"tool" — the id of the call being answered. */
  tool_call_id?: string;
  /** Present on role:"assistant" — calls this turn issued. */
  tool_calls?: IRToolCall[];
  /** Present on role:"tool" — the function that produced the output. */
  name?: string;
}

export type IRStopReason = "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | "error";

export interface IRRequest {
  /** Exactly what the caller sent, before alias resolution (R1). */
  model: string;
  messages: IRMessage[];
  /** Anthropic keeps the system prompt out of `messages`; so does the IR. */
  system?: string;
  tools?: IRToolDef[];
  max_output_tokens: number;
  temperature?: number;
  top_p?: number;
  stream: boolean;
  stop?: string[];
  /** Declared by the caller. Absent means "classify it" (R5a). */
  output_modality?: Modality;
  /**
   * Field-name -> type spelling (`str` | `float` | `int` | `bool`), from
   * `response_format.json_schema`. A helper extraction target, NOT a full JSON
   * Schema: the bridge compiles it into a dataclass, so only the field names
   * and kinds are meaningful.
   */
  output_schema?: Record<string, string>;
  /**
   * The caller's `response_format` verbatim.
   *
   * Carried rather than parsed because it is dialect-specific and helper-only:
   * `options` and `criteria` (the classify/score label lists) have no standard
   * home, and dropping them would leave those ops with no way to be told what
   * to choose between.
   */
  response_format?: unknown;
}

export interface IRUsage {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens?: number;
}

export interface IRServedBy {
  provider: string;
  model_id: string;
  /** Null for a local helper, which has no provider account. */
  key_id: string | null;
}

export interface IRResponse {
  model: string;
  content: IRContentPart[];
  thinking: IRThinkingBlock[];
  tool_calls: IRToolCall[];
  stop_reason: IRStopReason;
  usage: IRUsage;
  latency_ms: number;
  /** Which upstream actually served this. Never any credential. */
  served_by: IRServedBy;
}

/** Coerce a `content` field to a parts array without reordering anything. */
export function contentToParts(content: string | IRContentPart[]): IRContentPart[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

/** Flatten parts to plain text. Drops non-text parts, which is what a text-only
 * target wants; a modality-aware caller (R5a) uses `contentToParts` instead. */
export function partsToText(content: string | IRContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is IRTextPart => p.type === "text")
    .map((p) => p.text)
    .join("");
}
