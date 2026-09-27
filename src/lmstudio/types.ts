/**
 * Typed request/response shapes for the LM Studio v1 REST API.
 * Shapes mirror docs 04–09 in project knowledge, cross-checked against
 * Context7 (see docs/phase0-discrepancies.md). The one Context7 addition —
 * `loaded_instances[].config.parallel` — is included.
 */

export type ModelType = "llm" | "embedding";

export interface LoadedInstanceConfig {
  context_length: number;
  eval_batch_size?: number;
  parallel?: number;
  flash_attention?: boolean;
  num_experts?: number;
  offload_kv_cache_to_gpu?: boolean;
}

export interface LoadedInstance {
  id: string;
  config: LoadedInstanceConfig;
}

export interface Quantization {
  name: string | null;
  bits_per_weight: number | null;
}

export interface ModelCapabilities {
  vision: boolean;
  trained_for_tool_use: boolean;
}

export interface ModelInfo {
  type: ModelType;
  publisher: string;
  key: string;
  display_name: string;
  architecture?: string | null;
  quantization: Quantization | null;
  size_bytes: number;
  params_string: string | null;
  loaded_instances: LoadedInstance[];
  max_context_length: number;
  format: "gguf" | "mlx" | null;
  capabilities?: ModelCapabilities;
  description?: string | null;
}

export interface ListModelsResponse {
  models: ModelInfo[];
}

export interface LoadModelRequest {
  model: string;
  context_length?: number;
  /**
   * Server-side concurrent-prompt slots for this instance (LM Studio
   * `config.parallel`, llama.cpp `--parallel N`). Sent only when the CP-1
   * probe-gated `LOAD_NUMPARALLEL_KEY` is non-null — see
   * src/helpers/concurrency.ts. Omitted (server default 4) on builds that
   * reject the key.
   */
  parallel?: number;
  eval_batch_size?: number;
  flash_attention?: boolean;
  num_experts?: number;
  offload_kv_cache_to_gpu?: boolean;
  echo_load_config?: boolean;
}

export interface LoadModelResponse {
  type: ModelType;
  instance_id: string;
  load_time_seconds: number;
  status: "loaded";
  load_config?: LoadedInstanceConfig;
}

export interface UnloadModelRequest {
  instance_id: string;
}

export interface UnloadModelResponse {
  instance_id: string;
}

export type DownloadStatusValue = "downloading" | "paused" | "completed" | "failed" | "already_downloaded";

export interface DownloadModelRequest {
  model: string;
  quantization?: string;
}

export interface DownloadModelResponse {
  job_id?: string;
  status: DownloadStatusValue;
  completed_at?: string;
  total_size_bytes?: number;
  started_at?: string;
}

export type DownloadJobStatusValue = "downloading" | "paused" | "completed" | "failed";

export interface DownloadStatusResponse {
  job_id: string;
  status: DownloadJobStatusValue;
  bytes_per_second?: number;
  estimated_completion?: string;
  completed_at?: string;
  total_size_bytes?: number;
  downloaded_bytes?: number;
  started_at?: string;
}

// ---- chat ----

export type ChatInput = string | ChatInputItem[];
export type ChatInputItem =
  | { type: "text" | "message"; content: string }
  | { type: "image"; data_url: string };

export type ReasoningSetting = "off" | "low" | "medium" | "high" | "on";

/** Which LM Studio endpoint class a chat call targets. `native` is the REST
 * `/api/v1/chat` (supports integrations/tool loop, `chat.end` SSE). `openai` is
 * the OpenAI-compat `/v1/chat/completions` (accepts per-request `ttl`, which
 * native rejects). Transport is a per-*call* concern of the client; which
 * transport a *workflow* uses is decided once per run upstream. */
export type ChatTransport = "native" | "openai";

export interface ChatRequestParams {
  system_prompt?: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  repeat_penalty?: number;
  max_output_tokens?: number;
  reasoning?: ReasoningSetting;
  reasoning_budget?: number;
  context_length?: number;
  store?: boolean;
  previous_response_id?: string;
  integrations?: unknown[];
  /** LM Studio accepts the OpenAI response_format shape on both transports. */
  response_format?: { type: string; json_schema?: { name?: string; schema?: Record<string, unknown> } };
}

export interface ChatRequest {
  model: string;
  input: ChatInput;
  system_prompt?: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  repeat_penalty?: number;
  max_output_tokens?: number;
  reasoning?: ReasoningSetting;
  reasoning_budget?: number;
  context_length?: number;
  store?: boolean;
  previous_response_id?: string;
  integrations?: unknown[];
  /** OpenAI response_format — accepted on both native and openai transports. */
  response_format?: { type: string; json_schema?: { name?: string; schema?: Record<string, unknown> } };
}

export interface MessageOutput {
  type: "message";
  content: string;
}

export interface ToolCallOutput {
  type: "tool_call";
  tool: string;
  arguments: Record<string, unknown>;
  output?: string;
  provider_info?: Record<string, unknown>;
}

export interface ReasoningOutput {
  type: "reasoning";
  content: string;
}

export interface InvalidToolCallOutput {
  type: "invalid_tool_call";
  reason: string;
  metadata: Record<string, unknown>;
}

export type ChatOutputItem = MessageOutput | ToolCallOutput | ReasoningOutput | InvalidToolCallOutput;

export interface ChatStats {
  input_tokens: number;
  total_output_tokens: number;
  reasoning_output_tokens: number;
  tokens_per_second: number;
  time_to_first_token_seconds: number;
  model_load_time_seconds?: number;
}

export interface ChatResponse {
  model_instance_id: string;
  output: ChatOutputItem[];
  stats: ChatStats;
  response_id?: string;
}
