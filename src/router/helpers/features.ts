/**
 * Per-feature helper flags.
 *
 * The single `enable_helpers` flag was wrong for what these models now do. It
 * bundled a 7/7-accurate repair rung (measured) together with Laya decisions
 * that score 40% zero-shot (measured), so an operator could not take the
 * useful one without also taking the weak one. Each feature is a separate flag,
 * each default off, because a feature you do not trust must be switchable
 * without giving up the ones you do.
 *
 * A flag being ON does not promise the helper is installed. `availability` is
 * reported separately by `helperStatus`, because "enabled but not installed"
 * and "disabled" need different fixes.
 */
import type { DatabaseSync } from "node:sqlite";
import { readConfig } from "../auth.js";

/**
 * The feature set, and the evidence behind shipping each one.
 *
 * `evidence` is in the code rather than only in a commit message, because the
 * next person to ask "is this on by default, and why" should not have to go
 * looking for a benchmark.
 */
export const HELPER_FEATURES = {
  /**
   * Needle reconstructs a mangled tool call from the model's raw text, after
   * the deterministic ladder has already failed.
   *
   * Measured 7/7 exact recovery on truncated JSON, kwargs spelling, prose
   * arguments, and string-instead-of-object arguments, plus 1/1 correct
   * abstention. Gated on Needle's confidence, which separates cleanly
   * (0.25-0.81 for calls, 0.06 for abstain).
   */
  tool_repair: {
    helper: "needle3" as const,
    evidence: "7/7 repair, 1/1 abstain, confidence gap 0.25-0.81 vs 0.06",
  },
  /**
   * Needle extracts a `response_format` schema from free text.
   *
   * Measured 4/4 on a real order record. No confidence on this path, so it is
   * validated against the schema rather than gated on a score.
   */
  structured_output: {
    helper: "needle3" as const,
    evidence: "4/4 exact on a prose order record",
  },
  /**
   * Laya answers routing and moderation questions in one batched pass.
   *
   * NOT RECOMMENDED. Measured zero-shot: modality 90% against a deterministic
   * baseline that is already 100%; cache-poisoning 40%; refusal 35%. Shipping
   * it fail-open at those numbers trains operators to ignore it. Exposed so the
   * signal can be inspected and, eventually, fine-tuned — see the labelling
   * plan in docs/.
   */
  laya_preflight: {
    helper: "laya" as const,
    evidence: "40% cache-poisoning, 35% refusal, 90% modality (baseline 100%)",
  },
  /**
   * Laya judges whether a reply refused or hedged.
   *
   * NOT RECOMMENDED. 35% zero-shot. Same reasoning as laya_preflight.
   */
  laya_postflight: {
    helper: "laya" as const,
    evidence: "35% zero-shot on a 20-case labeled set",
  },
} as const;

export type HelperFeature = keyof typeof HELPER_FEATURES;

/** Every feature, in a stable order for API responses. */
export const HELPER_FEATURE_NAMES = Object.keys(HELPER_FEATURES) as HelperFeature[];

export function isHelperFeature(name: string): name is HelperFeature {
  return Object.prototype.hasOwnProperty.call(HELPER_FEATURES, name);
}

export function helperForFeature(feature: HelperFeature): "needle3" | "laya" {
  return HELPER_FEATURES[feature].helper;
}

/**
 * The master switch, and the per-feature flags.
 *
 * `enable_helpers` is RETAINED as a master gate so the existing
 * `PATCH {"enable_helpers": false}` keeps meaning "off" — the user-facing
 * promise is that turning helpers off stops them being used in flight, and a
 * new flag name would break that.
 */
export function readHelperFlags(db: DatabaseSync): {
  enabled: boolean;
  features: Record<HelperFeature, boolean>;
} {
  const config = readConfig(db);
  const enabled = Boolean(config?.enable_helpers);
  const flags = {} as Record<HelperFeature, boolean>;
  for (const name of HELPER_FEATURE_NAMES) {
    const raw = (config as unknown as Record<string, unknown> | null)?.[`feature_${name}`];
    flags[name] = enabled && (raw === undefined ? false : Boolean(raw));
  }
  return { enabled, features: flags };
}

/** True when the feature is enabled. A disabled master gate turns all off. */
export function featureEnabled(db: DatabaseSync, feature: HelperFeature): boolean {
  return readHelperFlags(db).features[feature];
}

/**
 * The column name a feature's flag lives in.
 *
 * Kept as a function rather than a constant map so a feature added to
 * HELPER_FEATURES cannot be wired to a column that does not exist.
 */
export function featureColumn(feature: HelperFeature): string {
  return `feature_${feature}`;
}
