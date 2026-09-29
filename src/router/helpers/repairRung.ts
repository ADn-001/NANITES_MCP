/**
 * The Needle rung of the tool-call repair ladder.
 *
 * Sits AFTER the deterministic rungs (direct -> extracted -> coerced ->
 * close-truncated) and BEFORE any cloud retry, which is the whole point: a
 * mangled call that costs one local forward pass to fix should not cost a paid
 * round trip to a provider, and should certainly not fail.
 *
 * Safety properties, in the order they matter:
 *
 *  1. IT NEVER EXECUTES. Needle's `complete()` returns the reconstructed call
 *     without running the tool; the generated tool bodies in schemaSource.ts
 *     raise if called. Verified against a tool that writes a file when run.
 *  2. IT IS NEVER THE LAST WORD. Anything it cannot fix with confidence
 *     returns `{ok: false}`, and the caller falls through to whatever it would
 *     have done — a cloud retry, or the original unrepairable error.
 *  3. OUTPUT IS VALIDATED, NOT TRUSTED. Grammar-constrained decoding means the
 *     SHAPE is valid, which says nothing about whether the VALUES are. Every
 *     reconstructed call is re-validated against the tool's own schema here, so
 *     a well-formed hallucination is still rejected.
 */
import type { DatabaseSync } from "node:sqlite";
import { validateAgainstSchema } from "../../helpers/toolCallRepair.js";
import { featureEnabled } from "./features.js";
import { getNeedle } from "./registry.js";
import type { ToolSpec } from "./schemaSource.js";

export interface ModelRepairOk {
  ok: true;
  args: Record<string, unknown>;
  confidence: number;
}

export interface ModelRepairFail {
  ok: false;
  /** Why the rung declined, for logs and for the eventual error message. */
  reason: "disabled" | "unavailable" | "abstained" | "low_confidence" | "wrong_tool" | "schema_invalid" | "no_arguments";
  detail?: string;
}

export type ModelRepairOutcome = ModelRepairOk | ModelRepairFail;

/**
 * Confidence floor for accepting a reconstruction.
 *
 * FITTED ON THE EVAL, not guessed. Measured over 8 real cases: correct
 * reconstructions scored 0.25-0.81, and the one case that should have
 * abstained scored 0.06. 0.25 sits above the abstention cluster and below the
 * lowest accepted case, which is the only place a threshold can go that loses
 * nothing on either side.
 */
export const REPAIR_MIN_CONFIDENCE = 0.25;

/**
 * Reconstruct a mangled tool call from the model's raw text.
 *
 * `text` is the model's own output, not a rephrasing: the repair works because
 * the intended values are in there somewhere and only the framing is broken.
 */
export async function repairWithNeedle(
  db: DatabaseSync,
  text: string,
  tool: ToolSpec,
  minConfidence = REPAIR_MIN_CONFIDENCE,
): Promise<ModelRepairOutcome> {
  if (!featureEnabled(db, "tool_repair")) return { ok: false, reason: "disabled" };
  if (!text || !text.trim()) return { ok: false, reason: "no_arguments" };

  const needle = getNeedle();
  if (!needle.available()) return { ok: false, reason: "unavailable", detail: needle.why() };

  const call = await needle.reconstruct(text, tool, minConfidence);
  if (!call) {
    // reconstruct() returns null for abstain, low confidence, a different
    // tool, and no usable arguments. They are not distinguished here on
    // purpose: every one of them means "fall through", and the caller does
    // not act on the difference.
    return { ok: false, reason: "abstained" };
  }

  // The values still have to be right. Grammar-constrained decoding makes the
  // shape valid; it does not make `/tmp/b.bin` into `/etc/passwd`, and a
  // well-formed wrong value is worse than an honest failure because it gets
  // executed.
  const issues = validateAgainstSchema(call.arguments, tool.parameters);
  if (issues.length > 0) {
    return {
      ok: false,
      reason: "schema_invalid",
      detail: issues.map((i) => `${i.path}: ${i.message}`).join("; "),
    };
  }

  return { ok: true, args: call.arguments, confidence: call.confidence };
}
