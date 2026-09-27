/**
 * Catalog fixture for the Phase 0 manifest suite — a snapshot of the real CF catalog
 * (67-model live dump 2026-09-10) for the rows relevant to the seed manifest, plus
 * representative decoys the manifest deliberately does NOT include.
 *
 * Vision flags here come from Cloudflare per-model docs (the `/ai/models/search` API
 * itself returns no capability data). This fixture encodes that catalog knowledge so
 * the manifest tests run without network.
 */
export interface CatalogFixtureEntry {
  model_id: string;
  vision: boolean;
}

export const CATALOG_FIXTURE: CatalogFixtureEntry[] = [
  // Manifest members (14)
  { model_id: "@cf/openai/gpt-oss-120b", vision: false },
  { model_id: "@cf/nvidia/nemotron-3-120b-a12b", vision: false },
  { model_id: "@cf/openai/gpt-oss-20b", vision: false },
  { model_id: "@cf/qwen/qwen3-30b-a3b-fp8", vision: false },
  { model_id: "@cf/zai-org/glm-4.7-flash", vision: false },
  { model_id: "@cf/google/gemma-4-26b-a4b-it", vision: true },
  { model_id: "@cf/qwen/qwen3.8-27b", vision: true },
  { model_id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", vision: false },
  { model_id: "@cf/mistralai/mistral-small-3.1-24b-instruct", vision: true },
  { model_id: "@cf/meta/llama-4-scout-17b-16e-instruct", vision: true },
  { model_id: "@cf/ibm-granite/granite-4.0-h-micro", vision: false },
  { model_id: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", vision: false },
  { model_id: "@cf/qwen/qwq-32b", vision: false },
  { model_id: "@cf/meta/llama-3.2-11b-vision-instruct", vision: true },
  // Decoys — real catalog rows the manifest deliberately does not seed
  { model_id: "@cf/zai-org/glm-5.3-flash", vision: false },
  { model_id: "@cf/moonshotai/kimi-k2.7-code", vision: false },
  { model_id: "@cf/deepseek-ai/deepseek-v4-flash-0731", vision: false },
  { model_id: "@cf/qwen/qwen2.5-coder-32b-instruct", vision: false },
  { model_id: "@cf/llava-hf/llava-1.5-7b-hf", vision: true },
  { model_id: "@cf/moondream/moondream3.1-9B-A2B", vision: true },
  { model_id: "@cf/black-forest-labs/flux-2-klein-9b", vision: false },
];

export function catalogHas(modelId: string): boolean {
  return CATALOG_FIXTURE.some((e) => e.model_id === modelId);
}

export function catalogVisionFlags(): Map<string, boolean> {
  return new Map(CATALOG_FIXTURE.map((e) => [e.model_id, e.vision]));
}
