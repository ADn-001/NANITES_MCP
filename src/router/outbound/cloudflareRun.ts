/**
 * Cloudflare modality dispatch.
 *
 * A Cloudflare model is served one of two ways, and picking the wrong one is a
 * 404 or a shape error:
 *
 *  - `/ai/v1/chat/completions` — the OpenAI-compatible shim. Text and
 *    natively-multimodal text models work here, and the existing
 *    `dispatchWithFailover` path already covers them, so they are NOT routed
 *    through this module.
 *  - `/ai/run/{model}` — everything else: image generation, TTS, ASR, and the
 *    VQA models that want `prompt` rather than `messages`.
 *
 * The category decides, not the provider. A caller asking for a Flux image and
 * a caller asking Llama for text both arrive on the same endpoint and take
 * different paths.
 */
import type { DatabaseSync } from "node:sqlite";
import { ProviderKeyStore } from "../../storage/providerKeyStore.js";
import type { ProviderKind } from "../../storage/profileDefaults.js";
import { NanitesError } from "../../helpers/errors.js";
import { ROUTER_PROFILE } from "../constants.js";
import { findCfModel, type CfModelDef } from "../providers/cloudflare/catalog.js";
import { buildRunBody, decodeRunResponse, runUrl, type CfArtifact } from "../providers/cloudflare/run.js";
import type { IRRequest, IRResponse, Modality } from "../ir/types.js";
import type { RoutableTarget } from "./resolve.js";
import { selectKey } from "./dispatch.js";

/**
 * True when this model must go through /ai/run rather than the chat shim.
 *
 * An UNKNOWN model returns TRUE, not false. Sending it to the chat shim
 * produces an opaque 500 from Workers AI; routing it here produces a
 * `modality_unsupported` error that names the model and says the registry has
 * no shape for it — which is actionable, and costs nothing because the refusal
 * happens before any request.
 */
export function needsRunPath(modelId: string): boolean {
  const def = findCfModel(modelId);
  if (!def) return true;
  // text-generation is the only category the OpenAI-compatible shim serves.
  return def.category !== "text-generation";
}

/**
 * The output modality a Cloudflare model's CATEGORY implies.
 *
 * Used to detect a caller who addressed a generator but sent it something
 * else. Derived from the registry rather than from the id string, because the
 * id is exactly the thing that may be wrong.
 *
 * `image-to-text` is deliberately "text": a VQA model CONSUMES an image and
 * PRODUCES text, so calling it a text request is correct.
 */
export function cfCategoryModality(modelId: string): Modality {
  const def = findCfModel(modelId);
  switch (def?.category) {
    case "text-to-image":
    case "image-to-image":
      return "image";
    case "text-to-speech":
      return "audio";
    default:
      return "text";
  }
}

export interface CfDispatchInput {
  db: DatabaseSync;
  target: RoutableTarget;
  request: IRRequest;
  key_id?: string;
  /**
   * Caller-declared budget, in ms. A generation model that takes a minute is
   * not a hang, so a caller who knows they are asking for one can raise the
   * router's ceiling above the default.
   */
  timeout_ms?: number;
  /**
   * Aborted when the client hangs up. A generation can run for 70 seconds
   * (measured, SDXL Base), so without this a client that disconnects early
   * still costs the full render.
   */
  signal?: AbortSignal;
}

export interface CfDispatchResult {
  text: string | null;
  artifact: CfArtifact | null;
  served_by: { provider: string; model_id: string; key_id: string };
  latency_ms: number;
}

export async function dispatchCfRun(input: CfDispatchInput): Promise<CfDispatchResult> {
  const { db, target } = input;
  const model = findCfModel(target.model_id);

  // A model we have no request shape for is a hard stop. Deliberately
  // `alias_unknown`, NOT `modality_unsupported`: a model that is not in the
  // registry at all is almost always a typo or something never discovered, and
  // blaming modality sends an operator to look in the wrong place.
  if (!model) {
    throw new NanitesError({
      code: "alias_unknown",
      message: `Unknown Cloudflare model "${target.model_id}". It is not in the free-tier registry — run discovery, or check the id.`,
      retryable: false,
      details: { model_id: target.model_id, provider: target.provider },
    });
  }

  // A model whose shape was never confirmed is refused with an explanation,
  // rather than being offered and then 400ing on use.
  if (model.unverified) {
    throw new NanitesError({
      code: "modality_unsupported",
      message: `"${model.id}" has no confirmed request shape — the documented one was rejected by the live API.`,
      retryable: false,
      details: { model_id: model.id, category: model.category, unverified: true },
    });
  }

  const body = buildRunBody(model, request0Of(input));
  const budgetMs = resolveTimeout(input.request, input.timeout_ms);

  const attempted = new Set<string>();
  const reasons: Array<{ key_id: string; code: string; message: string }> = [];

  // Key-scoped failures walk to the next key, as the chat path does. This path
  // had NO failover at all: it picked one key, so a single spent account failed
  // every request while five healthy accounts sat unused. Scoped to the named
  // provider (decision D5).
  for (let attempt = 0; attempt < 8; attempt++) {
    const key = input.key_id
      ? selectKey(db, target, input.key_id)
      : nextAvailableKey(db, target, attempted);
    if (!key) break;
    attempted.add(key.key_id);

    if (!key.account_id) {
      throw new NanitesError({
        code: "provider_auth_error",
        message: "A Cloudflare key requires an account_id.",
        retryable: false,
        details: { provider: target.provider },
      });
    }

    const base = key.gateway_url ?? "https://api.cloudflare.com/client/v4";
    const started = Date.now();
    // The caller's budget and the client's patience race each other.
    const budget = AbortSignal.timeout(budgetMs);
    const composite = input.signal ? AbortSignal.any([budget, input.signal]) : budget;

    let res: Response;
    try {
      res = await fetch(runUrl(base, key.account_id, model.id), {
        method: "POST",
        headers: { Authorization: `Bearer ${key.api_key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: composite,
      });
    } catch (err) {
      // A client that hung up is a cancellation, not a failure to report.
      if (input.signal?.aborted) {
        throw new NanitesError({
          code: "request_cancelled",
          message: "The client disconnected before the generation finished.",
          retryable: false,
          details: { model_id: model.id },
        });
      }
      const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      if (isTimeout) {
        // A timeout on a generation model is usually a SLOW model, not a broken
        // one, and the message has to say so: the right response is a larger
        // budget, not a blind retry against a model that is working.
        throw new NanitesError({
          code: "provider_timeout",
          message: `${model.id} did not answer within ${Math.round(budgetMs / 1000)}s. ` +
            `This model is slow rather than unavailable — retry with a higher ` +
            `"timeout_ms" if the request is a large render.`,
          retryable: true,
          details: { model_id: model.id, category: model.category, timeout_ms: budgetMs },
        });
      }
      // The URL carries the account id, so it must not appear in the message.
      const netErr: NanitesError = new NanitesError({
        code: "provider_network_error",
        message: `Could not reach Workers AI: ${err instanceof Error ? err.message : String(err)}`,
        retryable: true,
      });
      reasons.push({ key_id: key.key_id, code: netErr.code, message: netErr.message });
      break;
    }

    if (!res.ok) {
      const raw = await res.text();
      const err = await classifyRunError(res.status, raw, model);
      reasons.push({ key_id: key.key_id, code: err.code, message: err.message });
      // A shape rejection is about the BODY, not the account, so another key
      // fails identically. Only key-scoped codes advance.
      if (!KEY_SCOPED.has(err.code)) throw err;
      retireKey(db, target.provider, key.key_id, err.code);
      continue;
    }

    const decoded = await decodeRunResponse(res, model, Date.now() - started);
    return {
      text: decoded.text,
      artifact: decoded.artifact,
      served_by: { provider: target.provider, model_id: target.model_id, key_id: key.key_id },
      latency_ms: decoded.latency_ms,
    };
  }

  // The per-key reasons go IN the message, not only in `details`. An operator
  // reading a 402 needs to see that the cause was a spent allocation, and
  // `details` is not surfaced to a harness that only prints the error text.
  const cause = reasons[0]?.code ?? "unknown";
  throw new NanitesError({
    code: "all_keys_exhausted",
    message: `Every key on provider "${target.provider}" failed for ${model.id} (${reasons.length} tried). `
      + `First reason: ${cause}. ${reasons[0]?.message?.slice(0, 160) ?? ""}`.trim(),
    retryable: true,
    details: { provider: target.provider, model_id: model.id, reasons },
  });
}

function request0Of(input: CfDispatchInput) {
  return input.request;
}

/** The next un-attempted key on the named provider, or null when none is left. */
function nextAvailableKey(
  db: DatabaseSync,
  target: RoutableTarget,
  attempted: Set<string>,
): ReturnType<typeof selectKey> | null {
  for (let i = 0; i < 12; i++) {
    let key;
    try {
      key = selectKey(db, target);
    } catch {
      return null;
    }
    if (!attempted.has(key.key_id)) return key;
  }
  return null;
}

/** Key-scoped codes, mirroring providers/errors.ts KEY_SCOPED_CODES. */
const KEY_SCOPED = new Set([
  "provider_auth_error",
  "provider_forbidden",
  "provider_insufficient_credits",
  "provider_quota_exhausted",
  "provider_rate_limited",
]);

/** Retire a key: a spent allocation lasts until midnight, others for a day. */
function retireKey(db: DatabaseSync, provider: ProviderKind, keyId: string, code: string): void {
  const until = code === "provider_quota_exhausted"
    ? new Date(Date.UTC(
        new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1, 0, 0, 0, 0,
      ))
    : new Date(Date.now() + 24 * 60 * 60 * 1000);
  new ProviderKeyStore(db).exhaustKey(ROUTER_PROFILE, provider, keyId, until);
}

/** The default ceiling. Generous enough for the slowest model measured live. */
export const DEFAULT_GENERATION_TIMEOUT_MS = 240_000;

/** A caller may not raise the ceiling arbitrarily; this is the ceiling. */
export const MAX_GENERATION_TIMEOUT_MS = 600_000;

/**
 * Resolve the effective timeout.
 *
 * PROBED 2026-09-29 across 3 runs per model: FLUX 1.4s, Aura 0.6s,
 * MeloTTS 5.8s, and SDXL Base at 20 steps / 1024x1024 averaged 69.6s with an
 * 83.4s max. Only SDXL is slow, and it fits the default with headroom, so
 * there is no need for a job queue here. A caller who wants a bigger ceiling
 * asks for one explicitly rather than having every request wait on it.
 */
export function resolveTimeout(request: IRRequest, requested?: number): number {
  const declared = requested ?? (request as { timeout_ms?: number }).timeout_ms;
  if (declared === undefined || !Number.isFinite(declared) || declared <= 0) {
    return DEFAULT_GENERATION_TIMEOUT_MS;
  }
  return Math.min(Math.round(declared), MAX_GENERATION_TIMEOUT_MS);
}

/** Map a Workers AI failure onto the existing provider error taxonomy. */
export async function classifyRunError(status: number, raw: string, model: CfModelDef): Promise<NanitesError> {
  let message = raw.slice(0, 300);
  let cfCode: number | undefined;
  try {
    const parsed = JSON.parse(raw) as { errors?: Array<{ message?: string; code?: number }> };
    const first = parsed.errors?.[0];
    if (first?.message) message = first.message.slice(0, 300);
    if (typeof first?.code === "number") cfCode = first.code;
  } catch {
    // Not a Workers AI envelope; the raw text is the message.
  }

  // The measured Cloudflare codes are checked FIRST, because they are more
  // specific than the HTTP status: a 400 carrying code 4006 is a QUOTA
  // failure, not a shape rejection, and treating it as the latter would refuse
  // to retry something that is genuinely worth retrying.
  if (cfCode === 4006) {
    return new NanitesError({ code: "provider_quota_exhausted", message, retryable: false });
  }
  if (cfCode === 6293) {
    return new NanitesError({ code: "provider_rate_limited", message, retryable: true });
  }
  if (status === 401 || status === 403) {
    return new NanitesError({ code: "provider_auth_error", message, retryable: false });
  }
  if (status === 404) {
    return new NanitesError({ code: "provider_model_not_found", message, retryable: false });
  }
  if (status === 429) {
    // Cloudflare returns 429 for BOTH a transient rate limit and a spent
    // daily allocation. The message distinguishes them, and the difference
    // matters: a quota key is done until midnight and must be RETIRED, while
    // a rate limit is worth retrying. Reading every 429 as a rate limit left a
    // dead key in the rotation forever.
    const exhausted = /used up|allocation|quota|insufficient/i.test(message);
    if (exhausted) {
      return new NanitesError({ code: "provider_quota_exhausted", message, retryable: false });
    }
    return new NanitesError({ code: "provider_rate_limited", message, retryable: true });
  }

  // 5xx is a TRANSIENT inference fault, and the status is checked BEFORE the
  // shape branch below. A 500 carrying an unrecognised Cloudflare code used to
  // fall through to `router_invalid_request` — a permanent-failure code for a
  // fault that succeeds on retry, which is exactly backwards.
  if (status >= 500) {
    return new NanitesError({ code: "provider_server_error", message, retryable: true });
  }

  // A 4xx with no recognised code is a shape rejection: the body is wrong for
  // this model, and retrying the same body fails identically every time.
  return new NanitesError({
    code: "router_invalid_request",
    message: `Workers AI rejected the request for ${model.id}: ${message}`,
    retryable: false,
    details: { model_id: model.id, category: model.category, status, cf_code: cfCode ?? null },
  });
}

/** Shape a run result into the IR, so callers share one response type. */
export function toIRResponse(
  result: CfDispatchResult,
  request: IRRequest,
): IRResponse {
  return {
    model: request.model,
    content: result.artifact
      ? [{ type: result.artifact.kind === "audio" ? "input_audio" : "image_url", ...(
          result.artifact.kind === "audio"
            ? { data: result.artifact.b64, mime: result.artifact.mime }
            : { url: `data:${result.artifact.mime};base64,${result.artifact.b64}` }
        ) } as IRResponse["content"][number]]
      : result.text
        ? [{ type: "text", text: result.text }]
        : [],
    thinking: [],
    tool_calls: [],
    stop_reason: "end_turn",
    usage: { input_tokens: 0, output_tokens: 0 },
    latency_ms: result.latency_ms,
    served_by: result.served_by,
  };
}
