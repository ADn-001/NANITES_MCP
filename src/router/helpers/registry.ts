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
import {
  HELPER_FEATURES, HELPER_FEATURE_NAMES, featureEnabled, featureColumn, readHelperFlags, type HelperFeature,
} from "./features.js";
import type { HelperModel } from "./interface.js";
import type { IRContentPart, IRRequest, IRResponse } from "../ir/types.js";
import type { Modality } from "../ir/types.js";

export interface HelperStatus {
  needle: { available: boolean; reason: string };
  laya: { available: boolean; reason: string };
}

/** What a helper alias does when dispatched. */
export type HelperOp = "extract" | "embed" | "classify" | "score";

export interface HelperAlias {
  /** The harness-safe name a client sees and sends back. */
  alias: string;
  /** The canonical `helper:<model>:<op>` id. */
  real_id: string;
  /** Which adapter serves it. */
  helper: "needle3" | "laya";
  op: HelperOp;
  modalities: Modality[];
  context_window: number | null;
}

/**
 * The single source of truth for the helper surface.
 *
 * ONE constant, TWO readers: `/v1/models` synthesizes the catalog from it and
 * `resolveTarget` resolves against it. That is what makes "advertised means
 * callable" true by construction instead of by two lists happening to agree —
 * which is the failure this constant exists to prevent.
 *
 * Deliberately NOT persisted to `router_advertised`. `setAdvertised` validates
 * `real_id` against `provider_models`, and a helper is in no such table; a
 * compile-time constant also has no business in an operator-writable table.
 */
export const HELPER_ALIASES: readonly HelperAlias[] = [
  { alias: "nanites-needle-extract", real_id: "helper:needle3:extract", helper: "needle3", op: "extract", modalities: ["text"], context_window: null },
  { alias: "nanites-needle-embed", real_id: "helper:needle3:embed", helper: "needle3", op: "embed", modalities: ["text"], context_window: null },
  { alias: "nanites-laya-classify", real_id: "helper:laya:classify", helper: "laya", op: "classify", modalities: ["text"], context_window: 512 },
  { alias: "nanites-laya-score", real_id: "helper:laya:score", helper: "laya", op: "score", modalities: ["text"], context_window: 512 },
];

/** The alias for a name, or null. Accepts the alias and the namespaced id. */
export function resolveHelperAlias(id: string): HelperAlias | null {
  const want = id.trim();
  if (!want) return null;
  return HELPER_ALIASES.find((h) => h.alias === want || h.real_id === want) ?? null;
}

let needleInstance: NeedleHelper | null = null;
let layaInstance: LayaHelper | null = null;

/** Construct (once) or return the existing helper. Gated on `enable_helpers`. */
function helpers(_db?: DatabaseSync): { needle: NeedleHelper; laya: LayaHelper } {
  if (!needleInstance) needleInstance = new NeedleHelper();
  if (!layaInstance) layaInstance = new LayaHelper();
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

/** Per-feature flag state, for GET /v1/config. */
/** The flat `{feature: bool}` view, for GET /v1/config. */
export function helperFeatureFlags(db: DatabaseSync): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const name of HELPER_FEATURE_NAMES) out[name] = featureEnabled(db, name);
  return out;
}

/** Why a feature is unavailable right now, or "" when it is ready. */
export function featureReason(db: DatabaseSync, feature: HelperFeature): string {
  if (!readConfig(db)?.enable_helpers) return "helpers are disabled";
  if (!featureEnabled(db, feature)) return "feature is off";
  const { needle, laya } = helpers(db);
  const model = HELPER_FEATURES[feature].helper === "needle3" ? needle : laya;
  if (!model.available()) return model.why() || `${HELPER_FEATURES[feature].helper} is not available`;
  return "";
}

/**
 * Kick off availability probes without blocking.
 *
 * The fire-and-forget form, for the boot path: spawning a Python subprocess
 * must not delay the listener. Its callers that go on to REPORT availability
 * must use `awaitProbeHelpers` instead — see there.
 */
export function warmHelpers(db: DatabaseSync): void {
  if (!readConfig(db)?.enable_helpers) return;
  const { needle, laya } = helpers(db);
  void needle.probe().catch(() => undefined);
  void laya.probe().catch(() => undefined);
}

/**
 * Await the probes, for a caller that is about to report availability.
 *
 * A route that turns helpers ON and immediately answers "needle: false" is
 * not slow, it is WRONG: the probe had not finished, so the answer describes
 * a moment before the request rather than the state it created. The probes are
 * already in flight from `warmHelpers`, so awaiting them costs only the
 * remaining wait, and the adapters' own timeouts bound it.
 */
export async function awaitProbeHelpers(db: DatabaseSync): Promise<void> {
  if (!readConfig(db)?.enable_helpers) return;
  const { needle, laya } = helpers(db);
  await Promise.all([
    needle.probe().catch(() => undefined),
    laya.probe().catch(() => undefined),
  ]);
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

/**
 * Run a helper op and return its raw result, or a reason it could not run.
 *
 * Separate from `dispatchHelper` so the dedicated `/v1/helpers/*` routes can
 * return the RESULT itself — `{value}`, `{vector}` — instead of a
 * JSON-in-a-text-block shaped like a chat completion.
 */
export async function runHelperOp(
  db: DatabaseSync,
  entry: HelperAlias,
  args: { text?: string; state?: string; options?: string[]; criteria?: string[]; schema?: Record<string, unknown> },
): Promise<{ ok: true; result: unknown } | { ok: false; code: string; message: string }> {
  // ARGUMENT VALIDATION FIRST, then availability.
  //
  // A malformed request is a 400 whatever state the helpers are in. Checking
  // availability first would report "helpers are disabled" to a caller who
  // sent one option to a two-option question, sending them to debug the wrong
  // thing — and it would refuse a request it could have rejected for free.
  const badRequest = (message: string): { ok: false; code: string; message: string } =>
    ({ ok: false, code: "router_invalid_request", message });
  if (entry.op === "extract" && (!args.schema || Object.keys(args.schema).length === 0)) {
    return badRequest("`schema` is required for extract, and must name at least one field.");
  }
  if (entry.op === "classify" && (args.options ?? []).length < 2) {
    return badRequest("`options` must name at least two choices; one option is not a decision.");
  }
  if (entry.op === "score" && (args.criteria ?? []).length === 0) {
    return badRequest("`criteria` must be a non-empty array.");
  }

  // The endpoint's own feature flag, not just the master gate. Otherwise
  // enabling helpers would silently switch on every feature at once, which is
  // the bundling the per-feature flags exist to undo.
  const feature: HelperFeature = entry.op === "classify" || entry.op === "score"
    ? (entry.helper === "laya" ? "laya_preflight" : "structured_output")
    : "structured_output";
  if (!readConfig(db)?.enable_helpers) {
    return { ok: false, code: "helper_unavailable", message: "Helpers are disabled. PATCH /v1/config {\"enable_helpers\":true} to enable them." };
  }
  if (!featureEnabled(db, feature)) {
    return { ok: false, code: "helper_unavailable", message: `The "${feature}" feature is off. PATCH /v1/config {\"${featureColumn(feature)}\":true} to enable it.` };
  }
  const { needle, laya } = helpers(db);
  const model = entry.helper === "needle3" ? needle : laya;

  if (!model.available()) {
    // "disabled" and "installed but broken" need different fixes, so the
    // adapter's own reason travels with the refusal.
    return { ok: false, code: "helper_unavailable", message: `${entry.helper} is not available: ${model.why() || "unknown reason"}` };
  }

  switch (entry.op) {
    case "extract": {
      const value = await needle.extract<unknown>(args.text ?? "", args.schema!);
      // A null here is the adapter failing to satisfy the schema, which is a
      // request the model could not fulfil — not a helper outage.
      if (value === null) return { ok: false, code: "helper_no_result", message: "Needle could not satisfy the requested schema." };
      return { ok: true, result: value };
    }
    case "embed": {
      const vector = await needle.embed(args.text ?? "");
      if (!vector) return { ok: false, code: "helper_no_result", message: "Needle produced no embedding." };
      return { ok: true, result: vector };
    }
    case "classify": {
      return { ok: true, result: await laya.classify(args.state ?? "", args.options!) };
    }
    case "score": {
      const scored = await laya.score(args.state ?? "", args.criteria!);
      if (scored.score === null) return { ok: false, code: "helper_no_result", message: "Laya produced no score." };
      return { ok: true, result: scored };
    }
  }
}

/**
 * Run a helper and shape it as an `IRResponse`, so the normal chat encoders
 * serve it unchanged.
 *
 * `usage` is an honest zero. These models run locally and report no token
 * accounting, and a chars/4 estimate in a metered field is worse than an
 * admitted zero — a client budgets off this number.
 */
export async function dispatchHelper(db: DatabaseSync, entry: HelperAlias, request: IRRequest): Promise<IRResponse> {
  const started = Date.now();
  const out = await runHelperOp(db, entry, {
    text: partsTextOf(request),
    state: partsTextOf(request),
    options: helperOptionsOf(request),
    criteria: helperCriteriaOf(request),
    schema: request.output_schema,
  });
  if (!out.ok) {
    const err = new Error(out.message) as Error & { code: string; details: Record<string, unknown> };
    err.code = out.code;
    err.details = { alias: entry.alias, real_id: entry.real_id, op: entry.op };
    throw err;
  }
  return {
    model: request.model,
    content: [{ type: "text", text: JSON.stringify(out.result) }],
    thinking: [],
    tool_calls: [],
    stop_reason: "end_turn",
    usage: { input_tokens: 0, output_tokens: 0 },
    latency_ms: Date.now() - started,
    // No key exists for a local helper; null says so rather than inventing one.
    served_by: { provider: "helper", model_id: entry.real_id, key_id: null },
  };
}

function partsTextOf(request: IRRequest): string {
  return request.messages
    .map((m) => (typeof m.content === "string"
      ? m.content
      : m.content.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join("")))
    .join("\n");
}

/**
 * Choices for `classify` ride on `response_format.options`.
 *
 * There is no standard wire field for "here are the labels", and inventing a
 * top-level one would be a dialect only this router speaks. `response_format`
 * is already the structured-output slot on the OpenAI dialect, so an
 * unrecognized member of it is the least surprising place.
 */
function helperOptionsOf(request: IRRequest): string[] | undefined {
  const fmt = request.response_format as { options?: unknown } | undefined;
  return Array.isArray(fmt?.options) ? fmt.options.filter((o): o is string => typeof o === "string") : undefined;
}

function helperCriteriaOf(request: IRRequest): string[] | undefined {
  const fmt = request.response_format as { criteria?: unknown } | undefined;
  return Array.isArray(fmt?.criteria) ? fmt.criteria.filter((c): c is string => typeof c === "string") : undefined;
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

export { NeedleHelper, LayaHelper, readHelperFlags };
export type { HelperModel };

/**
 * Kill both resident workers.
 *
 * Called when `enable_helpers` goes false. This is what makes the toggle mean
 * what a user expects: a worker is not merely idle, it is holding a loaded
 * model in memory, and someone turning these off is usually doing so because
 * they do not want the model resident at all. The next enable respawns.
 */
export async function stopHelperWorkers(): Promise<void> {
  const needle = needleInstance;
  const laya = layaInstance;
  // The instances stay reachable so a later enable reuses the same objects,
  // but their cached `ready` is cleared, so the next probe re-establishes the
  // truth rather than reporting a process that no longer exists.
  await Promise.all([needle?.stop(), laya?.stop()].filter(Boolean) as Promise<void>[]);
}

/**
 * The concrete adapter for a helper model.
 *
 * Exposed so a call site that needs a capability beyond the `HelperModel`
 * interface — `reconstruct` on Needle, `decide` on Laya — can reach the shared
 * instance rather than constructing its own, which would bypass both the
 * singleton and the "probe once" cache.
 *
 * Gating stays with the caller: this returns the adapter either way, so a
 * feature that is switched off still gets a clean `{ok:false, reason:"disabled"}`
 * instead of a type error.
 */
export function getNeedle(): NeedleHelper {
  return helpers().needle;
}

export function getLaya(): LayaHelper {
  return helpers().laya;
}
