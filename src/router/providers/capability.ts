/**
 * What a model can actually accept and return.
 *
 * ## Why this exists
 *
 * Two failures, both found by sending real requests rather than by reading
 * code:
 *
 *  1. A text-only model given an image produced a CONFIDENT, WRONG answer.
 *     The base64 was flattened into the text prompt, shipped upstream, and
 *     LLaMA-4-Scout helpfully described the string it had been handed:
 *     "The text you've provided appears to be a Base64-encoded image." Billed,
 *     plausible, useless. The same flattening happens to `input_audio`.
 *
 *  2. Broadcast hardcoded `modalities: ["text"]`, so a vision or TTS model
 *     published from the dashboard was advertised as a text model — the one
 *     thing the catalog must never lie about.
 *
 * The fix is a single lookup, consulted BEFORE anything is sent, so a model
 * that cannot accept a medium is never given one — regardless of what the
 * caller chose, and regardless of whether auto-routing is on.
 *
 * ## Where the capability data comes from
 *
 * Cloudflare publishes a static registry (`./cloudflare/catalog.ts`) of every
 * free-tier model with `acceptsImage` / `returnsImage` / `acceptsAudio` and a
 * category, and that registry was PROBED against the live API rather than read
 * from documentation. It is the authority for Cloudflare.
 *
 * For other providers the metadata is the registered model's own
 * `supported_modalities`, which discovery populated. A model nobody knows
 * anything about is treated as text-in/text-out: every LLM does that, and
 * refusing on a guess would be worse than passing the request through.
 */
import type { DatabaseSync } from "node:sqlite";
import { findCfModel } from "./cloudflare/catalog.js";
import { ProviderModelStore } from "../../storage/providerModelStore.js";
import { listAdvertised } from "../models/catalog.js";
import { routerProfile } from "../constants.js";
import type { Modality } from "../ir/types.js";

export interface ModelCapability {
  /** This model takes these as INPUT. */
  accepts: Modality[];
  /** This model produces these as OUTPUT. */
  produces: Modality[];
  /** True when the model is served by Workers AI's /ai/run, not the chat shim. */
  viaAiRun: boolean;
  /** False for a model with no capability record; see the note above. */
  known: boolean;
}

const TEXT_ONLY: ModelCapability = {
  accepts: ["text"],
  produces: ["text"],
  viaAiRun: false,
  known: false,
};

function isModality(x: unknown): x is Modality {
  return x === "text" || x === "image" || x === "audio" || x === "video";
}

export function modelCapability(
  provider: string,
  modelId: string,
  registered?: { supported_modalities?: unknown } | null,
): ModelCapability {
  if (provider === "cloudflare") {
    const def = findCfModel(modelId);
    if (def) {
      const accepts: Modality[] = [];
      if (def.acceptsText) accepts.push("text");
      if (def.acceptsImage) accepts.push("image");
      if (def.acceptsAudio) accepts.push("audio");
      const produces: Modality[] = [];
      if (def.returnsText) produces.push("text");
      if (def.returnsImage) produces.push("image");
      if (def.returnsAudio) produces.push("audio");
      return { accepts, produces, viaAiRun: def.category !== "text-generation", known: true };
    }
  }
  // Other providers, and Cloudflare models absent from the registry.
  const raw = registered?.supported_modalities;
  const known = Array.isArray(raw) ? raw.filter(isModality) : [];
  if (known.length === 0) return TEXT_ONLY;
  return { accepts: known, produces: known, viaAiRun: false, known: true };
}

/** Capability for a model, looking the registered row up when needed. */
export function capabilityFor(
  db: DatabaseSync,
  provider: string,
  modelId: string,
): ModelCapability {
  let row: { supported_modalities?: unknown } | null = null;
  try {
    row = new ProviderModelStore(db).getModel(routerProfile(), provider as never, modelId);
  } catch {
    row = null;
  }
  return modelCapability(provider, modelId, row);
}

/**
 * The input modalities present in a request, as DISTINCT KINDS.
 *
 * What matters is the KIND, not the count: ten images still means "this needs
 * vision". A multimodal model accepts several kinds at once, so the test is
 * that every present kind is in the model's `accepts` set.
 */
export function requestInputKinds(contents: unknown): Modality[] {
  const kinds = new Set<Modality>();
  // Accepts EITHER one message's content or the whole list of them, and
  // descends into each. The first version walked a single level, so handed
  // `messages.map(m => m.content)` -- a list of content ARRAYS -- it saw each
  // array as a "part", found no `type` on it, and detected nothing. A gate
  // that never fires looks exactly like a gate that has nothing to catch.
  const visit = (c: unknown, depth: number): void => {
    if (depth > 4 || !Array.isArray(c)) return;
    for (const part of c as Array<Record<string, unknown>>) {
      if (!part || typeof part !== "object") continue;
      const t = part["type"];
      if (t === "image_url") kinds.add("image");
      else if (t === "input_audio") kinds.add("audio");
      else if (t === "video_url") kinds.add("video");
      else visit(part, depth + 1);
    }
  };
  visit(contents, 0);
  return [...kinds];
}

/**
 * The kinds this model cannot take. Empty means the request is deliverable.
 *
 * `video` is deliberately lenient. Harnesses express video as a URL or a frame
 * sequence, and no provider here declares native video input, so refusing on
 * it would block every harness that sends one. A model that explicitly
 * declares video still gets the refusal.
 */
export function unsupportedKinds(cap: ModelCapability, kinds: Modality[]): Modality[] {
  return kinds.filter((k) => {
    if (k === "video") return cap.accepts.includes("video");
    return !cap.accepts.includes(k);
  });
}

/** Registered models that can accept every one of these kinds. */
export function modelsAccepting(
  db: DatabaseSync,
  kinds: Modality[],
  limit = 8,
): Array<{ provider: string; model_id: string }> {
  const out: Array<{ provider: string; model_id: string }> = [];
  for (const m of new ProviderModelStore(db).listModels(routerProfile())) {
    if (!m.is_registered) continue;
    const cap = capabilityFor(db, m.provider, m.model_id);
    if (cap.known && kinds.every((k) => cap.accepts.includes(k))) {
      out.push({ provider: m.provider, model_id: m.model_id });
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * The user's configured fallback for a modality, or null.
 *
 * Deliberately NOT a heuristic. "The best vision model" is a judgement about
 * cost, latency and quality only the operator can make, so the router routes
 * to a name they published and says so plainly when they published none.
 */
export function configuredTargetFor(
  db: DatabaseSync,
  modality: Modality,
): { alias: string; provider: string; model_id: string } | null {
  for (const a of listAdvertised(db)) {
    if (a.fallback_for !== modality) continue;
    const [provider, model_id] = splitRealId(a.real_id, a.provider);
    const cap = modelCapability(provider, model_id);
    if (cap.accepts.length > 0) return { alias: a.alias, provider, model_id };
  }
  return null;
}

/** `provider:model` -> [provider, model]. Tolerates a bare id. */
export function splitRealId(realId: string, provider: string): [string, string] {
  const prefix = `${provider}:`;
  return realId.startsWith(prefix)
    ? [provider, realId.slice(prefix.length)]
    : [provider, realId];
}
