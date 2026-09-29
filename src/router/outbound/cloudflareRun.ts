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
import type { IRRequest, IRResponse } from "../ir/types.js";
import type { ResolvedTarget } from "./resolve.js";

/** True when this model must go through /ai/run rather than the chat shim. */
export function needsRunPath(modelId: string): boolean {
  const def = findCfModel(modelId);
  if (!def) return false;
  // text-generation is the only category the OpenAI-compatible shim serves.
  return def.category !== "text-generation";
}

export interface CfDispatchInput {
  db: DatabaseSync;
  target: ResolvedTarget;
  request: IRRequest;
  key_id?: string;
}

export interface CfDispatchResult {
  text: string | null;
  artifact: CfArtifact | null;
  served_by: { provider: string; model_id: string; key_id: string };
  latency_ms: number;
}

function selectKey(db: DatabaseSync, provider: ProviderKind, keyId?: string) {
  const keyStore = new ProviderKeyStore(db);
  const available = keyStore.availableKeys(ROUTER_PROFILE, provider);
  if (keyId) {
    const found = available.find((k) => k.key_id === keyId);
    if (found) return found;
  }
  if (available.length === 0) {
    throw new NanitesError({
      code: "provider_key_required",
      message: `Provider "${provider}" has no enabled, un-exhausted key.`,
      retryable: false,
      details: { provider },
    });
  }
  return available[0]!;
}

export async function dispatchCfRun(input: CfDispatchInput): Promise<CfDispatchResult> {
  const { db, target, request } = input;
  const model = findCfModel(target.model_id);

  // A model we have no request shape for is a hard stop, not a guess. The
  // registry is what makes a modality routable at all, and an unknown model
  // has no verified body.
  if (!model) {
    throw new NanitesError({
      code: "modality_unsupported",
      message: `No verified Workers AI request shape for "${target.model_id}". It may not be in the free-tier registry.`,
      retryable: false,
      details: { model_id: target.model_id, provider: target.provider },
    });
  }

  // An unverified model is reachable only by naming it explicitly AND only
  // after a probe confirmed the shape. Until then it is refused with a
  // message that says why, rather than being offered and then 400ing.
  if (model.unverified) {
    throw new NanitesError({
      code: "modality_unsupported",
      message: `"${model.id}" has no confirmed request shape — the documented one was rejected by the live API.`,
      retryable: false,
      details: { model_id: model.id, category: model.category, unverified: true },
    });
  }

  const key = selectKey(db, target.provider, input.key_id);
  if (!key.account_id) {
    throw new NanitesError({
      code: "provider_auth_error",
      message: "A Cloudflare key requires an account_id.",
      retryable: false,
      details: { provider: target.provider },
    });
  }

  const base = key.gateway_url ?? "https://api.cloudflare.com/client/v4";
  const audio = extractAudio(request);
  const body = buildRunBody(model, request, audio);

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(runUrl(base, key.account_id, model.id), {
      method: "POST",
      headers: { Authorization: `Bearer ${key.api_key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(240_000),
    });
  } catch (err) {
    // mapFetchError strips the URL, which carries the account id.
    const message = err instanceof Error ? err.message : String(err);
    throw new NanitesError({
      code: "provider_network_error",
      message: `Could not reach Workers AI: ${message}`,
      retryable: true,
    });
  }

  if (!res.ok) {
    const raw = await res.text();
    const err = await classifyRunError(res.status, raw, model);
    throw err;
  }

  const decoded = await decodeRunResponse(res, model, Date.now() - started);
  return {
    text: decoded.text,
    artifact: decoded.artifact,
    served_by: { provider: target.provider, model_id: target.model_id, key_id: key.key_id },
    latency_ms: decoded.latency_ms,
  };
}

/** Map a Workers AI failure onto the existing provider error taxonomy. */
async function classifyRunError(status: number, raw: string, model: CfModelDef): Promise<NanitesError> {
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

  // The measured Cloudflare codes, reusing the mapping the MCP router already
  // has rather than inventing a second one.
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
    return new NanitesError({ code: "provider_rate_limited", message, retryable: true });
  }
  if (status >= 500) {
    return new NanitesError({ code: "provider_server_error", message, retryable: true });
  }
  // A shape rejection is a 400 and is NOT retryable on another candidate —
  // the body is wrong for this model specifically.
  return new NanitesError({
    code: "router_invalid_request",
    message: `Workers AI rejected the request for ${model.id}: ${message}`,
    retryable: false,
    details: { model_id: model.id, category: model.category, status },
  });
}

/** The first base64 audio part in the request, if any. */
function extractAudio(request: IRRequest): string | undefined {
  for (const m of request.messages) {
    if (typeof m.content === "string") continue;
    for (const p of m.content) {
      if (p.type === "input_audio") return p.data;
    }
  }
  return undefined;
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
