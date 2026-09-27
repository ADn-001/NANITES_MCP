/**
 * Untested-model detection: which known LLM models have no registry entry yet.
 * Embedding models are excluded — the default regimen is role/LLM-oriented and
 * has no units that apply to them. This is the diff used by Workflow #3 and
 * tested here so Workflow #1 stays a per-model pipeline.
 */
import type { ModelInfo } from "../lmstudio/types.js";
import type { RegistryEntry } from "../storage/registryStore.js";

export function modelKey(m: ModelInfo): string {
  // The `key` field is LM Studio's canonical load/chat identifier. `publisher`
  // is separate metadata; concatenating them produces a string the load
  // endpoint rejects (see the model-identifier mismatch found in live testing).
  return m.key;
}

export function findUntestedModels(models: ModelInfo[], entries: RegistryEntry[]): ModelInfo[] {
  const known = new Set(entries.map((e) => e.model_id));
  return models.filter((m) => m.type === "llm" && !known.has(modelKey(m)));
}

/** E-req sweep order: ascending size_bytes (fail-fast on the affordable models
 * first, so a sweep that hits a resource ceiling already tested what it could),
 * ties by model key. Unknown size sorts last. */
export function sortBySizeAscending(models: ModelInfo[]): ModelInfo[] {
  return [...models].sort((a, b) => {
    const sa = a.size_bytes ?? Infinity;
    const sb = b.size_bytes ?? Infinity;
    if (sa !== sb) return sa - sb;
    return modelKey(a).localeCompare(modelKey(b));
  });
}
