/**
 * Fixtures copied from the project-knowledge LM Studio API docs (04–09).
 * These are the "exact example payloads from the project-knowledge docs"
 * that the wrapper tests must parse without modification. The one Context7
 * addition (`parallel`) is included per docs/phase0-discrepancies.md.
 */
import type {
  ChatResponse,
  DownloadModelResponse,
  DownloadStatusResponse,
  ListModelsResponse,
  LoadModelResponse,
  UnloadModelResponse,
} from "../../src/lmstudio/types.js";

export const listModelsFixture: ListModelsResponse = {
  models: [
    {
      type: "llm",
      publisher: "lmstudio-community",
      key: "gemma-3-270m-it-qat",
      display_name: "Gemma 3 270m Instruct Qat",
      architecture: "gemma3",
      quantization: { name: "Q4_0", bits_per_weight: 4 },
      size_bytes: 241410208,
      params_string: "270M",
      loaded_instances: [
        {
          id: "gemma-3-270m-it-qat",
          config: {
            context_length: 4096,
            eval_batch_size: 512,
            flash_attention: false,
            num_experts: 0,
            offload_kv_cache_to_gpu: true,
            parallel: 1,
          },
        },
      ],
      max_context_length: 32768,
      format: "gguf",
      capabilities: { vision: false, trained_for_tool_use: false },
      description: null,
    },
    {
      type: "embedding",
      publisher: "gaianet",
      key: "text-embedding-nomic-embed-text-v1.5-embedding",
      display_name: "Nomic Embed Text v1.5",
      quantization: { name: "F16", bits_per_weight: 16 },
      size_bytes: 274290560,
      params_string: null,
      loaded_instances: [],
      max_context_length: 2048,
      format: "gguf",
    },
  ],
};

export const loadModelFixture: LoadModelResponse = {
  type: "llm",
  instance_id: "openai/gpt-oss-20b",
  load_time_seconds: 9.099,
  status: "loaded",
  load_config: {
    context_length: 16384,
    eval_batch_size: 512,
    flash_attention: true,
    offload_kv_cache_to_gpu: true,
    num_experts: 4,
  },
};

export const unloadModelFixture: UnloadModelResponse = {
  instance_id: "openai/gpt-oss-20b",
};

export const downloadModelFixture: DownloadModelResponse = {
  job_id: "job_493c7c9ded",
  status: "downloading",
  total_size_bytes: 2279145003,
  started_at: "2025-10-03T15:33:23.496Z",
};

export const downloadStatusFixture: DownloadStatusResponse = {
  job_id: "job_493c7c9ded",
  status: "completed",
  total_size_bytes: 2279145003,
  downloaded_bytes: 2279145003,
  started_at: "2025-10-03T15:33:23.496Z",
  completed_at: "2025-10-03T15:43:12.102Z",
};

export const chatResponseFixture: ChatResponse = {
  model_instance_id: "qwen/qwen3-vl-4b",
  output: [
    {
      type: "message",
      content:
        "This image is a solid, vibrant red square that fills the entire frame, with no discernible texture, pattern, or other elements. It presents a minimalist, uniform visual field of pure red, evoking a sense of boldness or urgency.",
    },
  ],
  stats: {
    input_tokens: 17,
    total_output_tokens: 50,
    reasoning_output_tokens: 0,
    tokens_per_second: 51.03762685242662,
    time_to_first_token_seconds: 0.814,
  },
  response_id: "resp_0182bd7c479d7451f9a35471f9c26b34de87a7255856b9a4",
};

/**
 * SSE stream built from doc 03's documented event list. Ends with `chat.end`
 * whose `result` is identical to chatResponseFixture so reassembly can be
 * asserted equal to the non-streaming shape.
 */
export const streamingEventsFixture: Array<{ event: string; data: unknown }> = [
  { event: "chat.start", data: { type: "chat.start", model_instance_id: "qwen/qwen3-vl-4b" } },
  { event: "model_load.start", data: { type: "model_load.start", model_instance_id: "qwen/qwen3-vl-4b" } },
  { event: "model_load.progress", data: { type: "model_load.progress", model_instance_id: "qwen/qwen3-vl-4b", progress: 0.65 } },
  { event: "model_load.end", data: { type: "model_load.end", model_instance_id: "qwen/qwen3-vl-4b", load_time_seconds: 12.34 } },
  { event: "prompt_processing.start", data: { type: "prompt_processing.start" } },
  { event: "prompt_processing.progress", data: { type: "prompt_processing.progress", progress: 0.5 } },
  { event: "prompt_processing.end", data: { type: "prompt_processing.end" } },
  { event: "reasoning.start", data: { type: "reasoning.start" } },
  { event: "reasoning.delta", data: { type: "reasoning.delta", content: "Need to" } },
  { event: "reasoning.delta", data: { type: "reasoning.delta", content: " describe" } },
  { event: "reasoning.end", data: { type: "reasoning.end" } },
  { event: "message.start", data: { type: "message.start" } },
  { event: "message.delta", data: { type: "message.delta", content: "This image" } },
  { event: "message.delta", data: { type: "message.delta", content: " is red." } },
  { event: "message.end", data: { type: "message.end" } },
  { event: "chat.end", data: { type: "chat.end", result: chatResponseFixture } },
];

export function serializeSse(events: Array<{ event: string; data: unknown }>): string {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
}
