/**
 * Shared types for the online providers layer.
 */
import type { ProviderKind } from "../storage/profileDefaults.js";
import type { Effort } from "../helpers/inferencePlanner.js";

export interface ProviderModel {
  profile_name: string;
  provider: ProviderKind;
  model_id: string;
  name: string;
  nickname: string | null;
  owned_by: string | null;
  context_window: number | null;
  max_output_tokens: number | null;
  pricing_prompt: number | null;
  pricing_completion: number | null;
  capabilities: ProviderCapabilities;
  supported_modalities: string[];
  is_registered: boolean;
  performance_score: number | null;
  last_refreshed: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProviderCapabilities {
  vision: boolean;
  audio: boolean;
  video: boolean;
  function_calling: boolean;
  /** Model spends completion tokens on a hidden reasoning field before it
   * answers. Persisted for manifest-seeded models; absent on
   * discovery-sourced rows. */
  reasoning?: boolean;
}

export interface ProviderKey {
  profile_name: string;
  provider: ProviderKind;
  key_id: string;
  api_key: string;
  account_id: string | null;
  gateway_url: string | null;
  nickname: string | null;
  is_enabled: boolean;
  is_exhausted: boolean;
  exhausted_until: string | null;
  consecutive_failures: number;
  created_at: string;
}

export interface ProviderApiError {
  code: string;
  message: string;
  httpStatus?: number;
  providerErrorCode?: string;
  retryable: boolean;
}

/** OpenAI-style function definition sent in a chat `tools` array. */
export interface ProviderToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** A tool call the model issued (parsed from `message.tool_calls`). */
export interface ChatToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Asks the provider to constrain its answer to JSON.
 * `json_schema` carries a JSON Schema the answer must conform to; `json_object`
 * only demands parseable JSON. Named because the OpenAI-compatible wire shape
 * requires one (`json_schema.name`).
 */
export type ResponseFormat =
  | { type: "json_object" }
  | { type: "json_schema"; schema: Record<string, unknown>; name?: string };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  /**
   * Nanites-level reasoning intent. Providers disagree on the wire form:
   * OpenRouter wants `reasoning: { effort }`, OpenAI-style endpoints use a
   * `reasoning_effort` string, Cloudflare's non-reasoning Workers AI models
   * accept nothing. The planner maps this to the native field per provider in
   * buildCloudChatRequest — never send this raw string.
   */
  reasoning?: string | { effort: Effort; max_tokens?: number };
  reasoning_budget?: number;
  /** OpenAI-style reasoning effort (OpenAI-compat endpoints). */
  reasoning_effort?: Effort;
  stream?: boolean;
  /** OpenAI function tools for cloud providers; execution happens Nanites-side. */
  tools?: ProviderToolDef[];
  /** Provider-native structured-output field, set by `responseFormatFor` — never
   * assign the Nanites `ResponseFormat` here directly, the wire shapes differ
   * per provider. */
  response_format?: Record<string, unknown>;
  [key: string]: unknown;
}

/** An inline text block in a multimodal message content array. */
export interface TextContentPart {
  type: "text";
  text: string;
}

/** An image block in a multimodal message content array. `url` is an http(s)
 * URL, a `data:` URI, or a base64 data URI Nanites built from a local path —
 * the OpenAI-compat wire shape every cloud provider accepts. */
export interface ImageUrlContentPart {
  type: "image_url";
  image_url: { url: string; detail?: string };
}

export type ContentPart = TextContentPart | ImageUrlContentPart;

/** Content may be plain text (the common case) or a parts array carrying
 * images. Provider wire serialization passes both through unchanged. */
export type ChatContent = string | ContentPart[];

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ChatContent;
  /** Present on `role: "tool"` messages — the id of the call being answered. */
  tool_call_id?: string;
  /** Present on `role: "tool"` messages — the name of the function that
   * produced the output. OpenAI-compatible servers expect it alongside
   * `tool_call_id`. */
  name?: string;
  /** Present on `role: "assistant"` turns that issued calls, so multi-round
   * history stays valid for strict OpenAI-compat servers. */
  tool_calls?: ChatToolCall[];
}

export interface ChatResponse {
  content: string;
  reasoning?: string;
  reasoning_content?: string;
  finish_reason?: string;
  /** Tool calls the model issued on this turn (parsed from message.tool_calls). */
  tool_calls?: ChatToolCall[];
  provider_request_id?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatStreamEvent {
  type: "content" | "done" | "error";
  delta?: string;
  reasoning_delta?: string;
  content?: string;
  finish_reason?: string;
}

export interface ListModelsResponse {
  models: RawProviderModel[];
}

export interface RawProviderModel {
  id: string;
  name?: string;
  owned_by?: string;
  context_length?: number | null;
  capabilities?: {
    vision?: boolean;
    audio?: boolean;
    video?: boolean;
    function_calling?: boolean;
  };
  /** USD per million tokens, when the provider's catalog publishes a rate.
   * Cloudflare's catalog carries it (the `price` property); the OpenAI-shaped
   * `/models` responses do not, so it stays undefined there. */
  pricing_prompt?: number | null;
  pricing_completion?: number | null;
}
