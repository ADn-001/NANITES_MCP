/**
 * The helper registry: construction, gating, and the fallback-bearing call
 * sites.
 *
 * Two rules govern everything here:
 *
 *  1. **The router is complete without helpers.** Every function has a defined
 *     answer when a helper is missing, and the answer is the behaviour that
 *     existed before helpers existed — a deterministic classification, not a
 *     guess dressed as one.
 *  2. **A helper never blocks a request.** Every call is bounded by a timeout
 *     inside the adapter and returns null on any failure. There is no path
 *     where a slow helper turns into a failed request.
 */
import type { DatabaseSync } from "node:sqlite";
import { readConfig } from "../auth.js";
import { NeedleHelper } from "./needle.js";
import { LayaHelper } from "./laya.js";
import type { HelperModel } from "./interface.js";
import type { Modality, IRContentPart } from "../ir/types.js";

export interface HelperStatus {
  needle: { available: boolean; reason: string };
  laya: { available: boolean; reason: string };
}

let needleInstance: NeedleHelper | null = null;
let layaInstance: LayaHelper | null = null;

/** Construct (once) or return the existing helper. Gated on `enable_helpers`. */
function helpers(db: DatabaseSync): { needle: NeedleHelper; laya: LayaHelper } {
  if (!needleInstance) needleInstance = new NeedleHelper();
  if (!layaInstance) layaInstance = new LayaHelper();
  void db;
  return { needle: needleInstance, laya: layaInstance };
}

export function helperStatus(db: DatabaseSync): HelperStatus {
  const enabled = Boolean(readConfig(db)?.enable_helpers);
  if (!enabled) {
    return {
      needle: { available: false, reason: "helpers are disabled" },
      laya: { available: false, reason: "helpers are disabled" },
    };
  }
  const { needle, laya } = helpers(db);
  return {
    needle: { available: needle.available(), reason: needle.available() ? "" : needle.why() },
    laya: { available: laya.available(), reason: laya.available() ? "" : laya.why() },
  };
}

/** Kick off availability probes without blocking. */
export function warmHelpers(db: DatabaseSync): void {
  if (!readConfig(db)?.enable_helpers) return;
  const { needle, laya } = helpers(db);
  void needle.probe().catch(() => undefined);
  void laya.probe().catch(() => undefined);
}

/* --------------------------------------------------------------- call sites */

export interface ModalityGuess {
  modality: Modality;
  source: "declared" | "content" | "laya" | "default";
}

/**
 * Decide a request's output modality.
 *
 * The order is deliberate. An explicit declaration always wins; content parts
 * are deterministic and free; Laya is consulted only when the first two are
 * inconclusive, and only if helpers are on. "text" is the final answer, and it
 * is the same answer the router gave before helpers existed.
 */
export async function guessModality(
  db: DatabaseSync,
  parts: IRContentPart[],
  declared?: Modality,
): Promise<ModalityGuess> {
  if (declared) return { modality: declared, source: "declared" };

  if (parts.some((p) => p.type === "input_audio")) return { modality: "audio", source: "content" };
  if (parts.some((p) => p.type === "video_url")) return { modality: "video", source: "content" };
  if (parts.some((p) => p.type === "image_url")) return { modality: "image", source: "content" };

  if (readConfig(db)?.enable_helpers) {
    const { laya } = helpers(db);
    const { choice, confidence } = await laya.classify(
      "A text-only request with no image, audio, or video parts.",
      ["text", "image", "audio", "video"],
    );
    // Below the bar, the deterministic default is better than a coin flip from
    // a small classifier.
    if (choice && confidence >= 0.5) return { modality: choice as Modality, source: "laya" };
  }

  return { modality: "text", source: "default" };
}

export type ReplyVerdict = "answer" | "tool_call" | "refusal" | "degenerate";

/**
 * Classify a reply so a chain knows whether to keep going.
 *
 * Used where the deterministic checks are not enough: an empty completion and a
 * refusal are both "no usable answer", but they warrant different handling — a
 * refusal is a model decision worth surfacing, an empty reply is worth walking
 * past. Laya can tell them apart; a regex cannot.
 */
export async function classifyReply(db: DatabaseSync, text: string, hadToolCalls: boolean): Promise<ReplyVerdict> {
  if (hadToolCalls) return "tool_call";
  if (text.trim().length === 0) return "degenerate";

  if (readConfig(db)?.enable_helpers) {
    const { laya } = helpers(db);
    const { choice, confidence } = await laya.classify(text.slice(0, 2_000), [
      "a normal answer", "a refusal to comply", "a repeated loop that goes nowhere",
    ]);
    if (confidence >= 0.6) {
      if (choice === "a refusal to comply") return "refusal";
      if (choice === "a repeated loop that goes nowhere") return "degenerate";
      return "answer";
    }
  }
  // Without a confident answer, the reply is usable — which is the behaviour
  // from before helpers existed.
  return "answer";
}

/** Schema-constrained extraction, with a null-on-failure contract. */
export async function extractStructured<T>(
  db: DatabaseSync,
  text: string,
  schema: Record<string, unknown>,
): Promise<T | null> {
  if (!readConfig(db)?.enable_helpers) return null;
  const { needle } = helpers(db);
  return needle.extract<T>(text, schema);
}

export { NeedleHelper, LayaHelper };
export type { HelperModel };
