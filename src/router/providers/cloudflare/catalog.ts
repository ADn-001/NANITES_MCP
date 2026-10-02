/**
 * Cloudflare Workers AI model registry.
 *
 * Workers AI is NOT OpenAI-compatible for most of its catalog. The only
 * OpenAI-shaped surface is `/ai/v1/chat/completions`, which covers text and
 * vision. Image generation, TTS, and speech recognition live on
 * `/ai/run/{model}` and each category wants a DIFFERENT request body:
 *
 *   text-generation      { messages, max_tokens?, ... }  -> { result: "text" }
 *   image-to-text        { image: number[], prompt }     -> { result: "text" }
 *   text-to-image        { prompt, width, ... }          -> binary PNG
 *   image-to-image       { prompt, image_b64, strength } -> binary PNG
 *   text-to-speech       MeloTTS { prompt, lang } / Aura { text, speaker } -> MP3
 *
 * Note the TTS split: MeloTTS takes `prompt`+`lang`, Deepgram Aura takes
 * `text`+`speaker`+`encoding`. Sending either shape to the other is a 400.
 *
 * This registry is a SEED, not the source of truth. Cloudflare's catalog
 * changes and models get deprecated (12 here are already flagged), so
 * discovery stays authoritative for what EXISTS; this supplies the request
 * SHAPE and the capability flags, which `/models/search` does not publish in a
 * form the router can use.
 */
export type CfCategory =
  | "text-generation"
  | "image-to-text"
  | "text-to-image"
  | "image-to-image"
  | "text-to-speech";

export interface CfModelDef {
  id: string;
  category: CfCategory;
  /** "multipart" models need FormData, not JSON, even for a text-only prompt. */
  format: "json" | "multipart";
  /**
   * The parameters this model actually accepts beyond `prompt`.
   *
   * PROBED against live Workers AI on 2026-09-29, not read from docs — and the
   * docs are wrong. `flux-1-schnell` documents `num_steps`, `width`,
   * `height`, `guidance` and `seed`; it accepts `prompt` and NOTHING else, and
   * returns "Additional or unevaluated properties '/num_steps'" for each one
   * sent. Sending a documented-but-unsupported parameter is a 400, not a
   * silent no-op, so the accepted set has to be per-model.
   *
   * Absent = `prompt` only.
   */
  params?: string[];
  /**
   * The FIELD NAME carrying the image, for image-to-text models.
   *
   * PROBED 2026-10-02, and the reason this exists: two vision models with
   * identical `acceptsImage` want different keys. LLaVA takes `image` as a raw
   * byte array and answers; Moondream takes `images` and answers. Sending
   * `image` to Moondream returns "Type mismatch of '/image', 'string' not in
   * 'array','binary'" -- which reads like an encoding problem, and re-encoding
   * the same bytes fails identically. Only the name is wrong.
   *
   * Absent = `image`.
   */
  imageField?: string;
  /**
   * Set when the request shape could NOT be confirmed against the live API.
   *
   * A planner must not offer an unverified model: guessing a body shape
   * produces a confident-looking 400 at request time instead of an honest
   * "unsupported here". Speech recognition is OUT OF SCOPE and removed from
   * this registry; the field stays because a future model can need the same
   * treatment.
   */
  unverified?: boolean;
  acceptsImage: boolean;
  acceptsText: boolean;
  acceptsAudio: boolean;
  returnsImage: boolean;
  returnsAudio: boolean;
  returnsText: boolean;
  deprecated: boolean;
  description: string;
}

export const CF_MODELS: CfModelDef[] = [
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", category: "text-generation", format: "json", acceptsImage: false, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: false, description: "Llama 3.3 70B fp8 fast" },
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", category: "text-generation", format: "json", acceptsImage: true, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: false, description: "Llama 4 Scout 17B 16E multimodal MoE" },
  { id: "@cf/meta/llama-3.2-11b-vision-instruct", category: "text-generation", format: "json", acceptsImage: true, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: false, description: "Llama 3.2 11B Vision" },
  { id: "@cf/meta/meta-llama-3-8b-instruct", category: "text-generation", format: "json", acceptsImage: false, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: true, description: "Meta Llama 3 8B Instruct (deprecated)" },
  { id: "@cf/meta/llama-2-7b-chat-fp16", category: "text-generation", format: "json", acceptsImage: false, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: true, description: "Llama 2 7B Chat fp16 (deprecated)" },
  { id: "@cf/meta/llama-guard-3-8b", category: "text-generation", format: "json", acceptsImage: false, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: false, description: "Llama Guard 3 8B content safety" },
  { id: "@cf/openai/gpt-oss-120b", category: "text-generation", format: "json", acceptsImage: false, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: false, description: "OpenAI gpt-oss-120b reasoning" },
  { id: "@cf/openai/gpt-oss-20b", category: "text-generation", format: "json", acceptsImage: false, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: false, description: "OpenAI gpt-oss-20b lower latency" },
  { id: "@cf/qwen/qwq-32b", category: "text-generation", format: "json", acceptsImage: false, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: false, description: "QwQ 32B reasoning" },
  { id: "@cf/qwen/qwen3.8-27b", category: "text-generation", format: "json", acceptsImage: true, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: false, description: "Qwen 3.8 27B vision language model" },
  { id: "@cf/deepseek/deepseek-r1-distill-qwen-32b", category: "text-generation", format: "json", acceptsImage: false, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: false, description: "DeepSeek R1 Distill Qwen 32B" },
  { id: "@cf/google/gemma-7b-it", category: "text-generation", format: "json", acceptsImage: false, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: true, description: "Gemma 7B IT (deprecated)" },
  { id: "@cf/google/gemma-7b-it-lora", category: "text-generation", format: "json", acceptsImage: false, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: false, description: "Gemma 7B IT LoRA" },
  { id: "@cf/google/gemma-2b-it-lora", category: "text-generation", format: "json", acceptsImage: false, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: false, description: "Gemma 2B IT LoRA" },
  { id: "@cf/google/gemma-3-12b-it", category: "text-generation", format: "json", acceptsImage: true, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: true, description: "Gemma 3 12B IT multimodal (deprecated)" },
  { id: "@cf/google/gemma-4-26b-a4b-it", category: "text-generation", format: "json", acceptsImage: true, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: false, description: "Gemma 4 26B A4B IT vision" },
  { id: "@cf/aisingapore/gemma-sea-lion-v4-27b-it", category: "text-generation", format: "json", acceptsImage: false, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: false, description: "SEA-LION v4 27B SE Asian languages" },
  { id: "@cf/mistral/mistral-7b-instruct-v0.1", category: "text-generation", format: "json", acceptsImage: false, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: true, description: "Mistral 7B Instruct v0.1 (deprecated)" },
  { id: "@cf/mistral/mistral-7b-instruct-v0.2", category: "text-generation", format: "json", acceptsImage: false, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: true, description: "Mistral 7B Instruct v0.2 (deprecated)" },
  { id: "@cf/mistral/mistral-7b-instruct-v0.2-lora", category: "text-generation", format: "json", acceptsImage: false, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: false, description: "Mistral 7B Instruct v0.2 LoRA" },
  { id: "@cf/mistral/mistral-small-3.1-24b-instruct", category: "text-generation", format: "json", acceptsImage: true, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: false, description: "Mistral Small 3.1 24B vision 128K" },
  { id: "@cf/microsoft/phi-2", category: "text-generation", format: "json", acceptsImage: false, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: true, description: "Phi-2 NLP coding (deprecated)" },
  { id: "@cf/nvidia/nemotron-3-120b-a12b", category: "text-generation", format: "json", acceptsImage: false, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: false, description: "NVIDIA Nemotron 3 120B MoE" },
  { id: "@cf/nousresearch/hermes-2-pro-mistral-7b", category: "text-generation", format: "json", acceptsImage: false, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: true, description: "Hermes 2 Pro Mistral 7B (deprecated)" },
  { id: "@cf/zai-org/glm-4.7-flash", category: "text-generation", format: "json", acceptsImage: false, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: false, description: "GLM-4.7-Flash multilingual 131K" },
  { id: "@cf/zai-org/glm-5.2", category: "text-generation", format: "json", acceptsImage: false, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: false, description: "GLM-5.2 Z.ai agentic coding" },
  { id: "@cf/ibm/granite-4.0-h-micro", category: "text-generation", format: "json", acceptsImage: false, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: false, description: "IBM Granite 4.0 H Micro" },
  { id: "@cf/moonshot/kimi-k2.5", category: "text-generation", format: "json", acceptsImage: true, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: true, description: "Kimi K2.5 256K vision (deprecated)" },
  { id: "@cf/moonshot/kimi-k2.6", category: "text-generation", format: "json", acceptsImage: true, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: false, description: "Kimi K2.6 1T 262K vision" },
  { id: "@cf/moonshot/kimi-k2.7-code", category: "text-generation", format: "json", acceptsImage: true, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: false, description: "Kimi K2.7 Code 1T agentic" },
  { id: "@cf/defog/sqlcoder-7b-2", category: "text-generation", format: "json", acceptsImage: false, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: true, description: "SQLCoder 7B SQL gen (deprecated)" },
  { id: "@cf/black-forest-labs/flux-1-schnell", category: "text-to-image", format: "json", params: [], acceptsImage: false, acceptsText: true, acceptsAudio: false, returnsImage: true, returnsAudio: false, returnsText: false, deprecated: false, description: "FLUX.1 schnell 12B" },
  { id: "@cf/stabilityai/stable-diffusion-xl-base-1.0", category: "text-to-image", format: "json", acceptsImage: true, acceptsText: true, acceptsAudio: false, returnsImage: true, returnsAudio: false, returnsText: false, deprecated: false, description: "SDXL Base 1.0" },
  { id: "@cf/bytedance/stable-diffusion-xl-lightning", category: "text-to-image", format: "json", acceptsImage: true, acceptsText: true, acceptsAudio: false, returnsImage: true, returnsAudio: false, returnsText: false, deprecated: false, description: "SDXL Lightning fast" },
  { id: "@cf/lykon/dreamshaper-8-lcm", category: "text-to-image", format: "json", acceptsImage: true, acceptsText: true, acceptsAudio: false, returnsImage: true, returnsAudio: false, returnsText: false, deprecated: false, description: "DreamShaper 8 LCM photorealistic" },
  { id: "@cf/leonardo/lucid-origin", category: "text-to-image", format: "json", acceptsImage: false, acceptsText: true, acceptsAudio: false, returnsImage: true, returnsAudio: false, returnsText: false, deprecated: false, description: "Lucid Origin HD renders" },
  { id: "@cf/leonardo/phoenix-1.0", category: "text-to-image", format: "json", acceptsImage: false, acceptsText: true, acceptsAudio: false, returnsImage: true, returnsAudio: false, returnsText: false, deprecated: false, description: "Phoenix 1.0 prompt adherence" },
  { id: "@cf/black-forest-labs/flux-2-dev", category: "text-to-image", format: "multipart", acceptsImage: true, acceptsText: true, acceptsAudio: false, returnsImage: true, returnsAudio: false, returnsText: false, deprecated: false, description: "FLUX.2 dev multi-reference" },
  { id: "@cf/black-forest-labs/flux-2-klein-4b", category: "text-to-image", format: "multipart", acceptsImage: true, acceptsText: true, acceptsAudio: false, returnsImage: true, returnsAudio: false, returnsText: false, deprecated: false, description: "FLUX.2 klein 4B ultra-fast" },
  { id: "@cf/black-forest-labs/flux-2-klein-9b", category: "text-to-image", format: "multipart", acceptsImage: true, acceptsText: true, acceptsAudio: false, returnsImage: true, returnsAudio: false, returnsText: false, deprecated: false, description: "FLUX.2 klein 9B enhanced" },
  { id: "@cf/runwayml/stable-diffusion-v1-5-img2img", category: "image-to-image", format: "json", acceptsImage: true, acceptsText: true, acceptsAudio: false, returnsImage: true, returnsAudio: false, returnsText: false, deprecated: false, description: "SD v1.5 img2img" },
  { id: "@cf/runwayml/stable-diffusion-v1-5-inpainting", category: "image-to-image", format: "json", acceptsImage: true, acceptsText: true, acceptsAudio: false, returnsImage: true, returnsAudio: false, returnsText: false, deprecated: false, description: "SD v1.5 inpainting" },
  { id: "@cf/llava-hf/llava-1.5-7b-hf", category: "image-to-text", format: "json", acceptsImage: true, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: false, description: "LLaVA 1.5 captioning VQA" },
  { id: "@cf/moondream/moondream3.1-9B-A2B", category: "image-to-text", format: "json", imageField: "images", acceptsImage: true, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: false, returnsText: true, deprecated: false, description: "Moondream 3 9B visual reasoning" },
  { id: "@cf/myshell-ai/melotts", category: "text-to-speech", format: "json", acceptsImage: false, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: true, returnsText: false, deprecated: false, description: "MeloTTS multilingual" },
  { id: "@cf/deepgram/aura-1", category: "text-to-speech", format: "json", acceptsImage: false, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: true, returnsText: false, deprecated: false, description: "Deepgram Aura TTS" },
  { id: "@cf/deepgram/aura-2-en", category: "text-to-speech", format: "json", acceptsImage: false, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: true, returnsText: false, deprecated: false, description: "Deepgram Aura-2 English" },
  { id: "@cf/deepgram/aura-2-es", category: "text-to-speech", format: "json", acceptsImage: false, acceptsText: true, acceptsAudio: false, returnsImage: false, returnsAudio: true, returnsText: false, deprecated: false, description: "Deepgram Aura-2 Spanish" },
];

const BY_ID = new Map(CF_MODELS.map((m) => [m.id, m]));

export function findCfModel(id: string): CfModelDef | undefined {
  return BY_ID.get(id);
}

/** The modalities a model can be PROMPTED with. */
export function cfInputModalities(m: CfModelDef): string[] {
  const out: string[] = [];
  if (m.acceptsText) out.push("text");
  if (m.acceptsImage) out.push("image");
  if (m.acceptsAudio) out.push("audio");
  return out;
}

/** The modalities a model can EMIT. */
export function cfOutputModalities(m: CfModelDef): string[] {
  const out: string[] = [];
  if (m.returnsText) out.push("text");
  if (m.returnsImage) out.push("image");
  if (m.returnsAudio) out.push("audio");
  return out;
}
