/**
 * The router's HTTP server.
 *
 * Deliberately `node:http` with no framework, matching `src/ui/server.ts`. The
 * router's job is to be a small, dependable, always-on process; a dependency
 * that can fail to load is a dependency that takes the gateway down.
 *
 * Request order is fixed and load-bearing: auth runs FIRST, before the body is
 * read, so an unauthenticated caller cannot make the process buffer a payload
 * it will only reject. Outbound-URL guard and body-size cap sit between auth and
 * the handler.
 */
import http from "node:http";
import { randomUUID, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { bearerToken, verifyVirtualKey, readConfig, updateConfig } from "./auth.js";
import { detectDialect, errorFor, type Dialect } from "./dialect.js";
import { assertOutboundUrl } from "../ui/guards.js";
import { NanitesError } from "../helpers/errors.js";
import { decodeAnthropicRequest, encodeAnthropicResponse } from "./inbound/anthropic.js";
import { decodeOpenAiRequest, encodeOpenAiResponse } from "./inbound/openai.js";
import { resolveTarget, isRoutable, type ResolvedTarget, type RoutableTarget } from "./outbound/resolve.js";
import { listAdvertised, renderCatalog, type AdvertisedModel } from "./models/catalog.js";
import { getAlias, walkChain, setStickyWinner, type ChainCandidate } from "./models/aliases.js";
import { createSseWriter } from "./stream/sse.js";
import { createAnthropicStream, type AnthropicStreamEncoder } from "./stream/anthropicStream.js";
import { createOpenAiStream, type OpenAiStreamEncoder } from "./stream/openaiStream.js";
import { openUpstreamStream, type OpenedUpstream } from "./outbound/streamDispatch.js";
import { RateLimiter, DEFAULT_RATE_LIMIT } from "./security/rateLimit.js";
import { startTunnel, type TunnelHandle } from "./transport/tunnel.js";
import { JobStore, type JobRow } from "./jobs/store.js";
import { helperStatus, warmHelpers, awaitProbeHelpers, guessModality, helperFeatureFlags, featureReason, stopHelperWorkers, HELPER_ALIASES, dispatchHelper, runHelperOp, resolveHelperAlias, type HelperAlias } from "./helpers/registry.js";
import { HELPER_FEATURE_NAMES, type HelperFeature } from "./helpers/features.js";
import { runJob } from "./jobs/runner.js";
import { needsRunPath, dispatchCfRun, toIRResponse, cfCategoryModality } from "./outbound/cloudflareRun.js";
import type { IRRequest } from "./ir/types.js";
import { countTokens } from "../helpers/tokenize.js";
import { partsToText } from "./ir/types.js";

/**
 * Best-effort input-token estimate for the opening frame.
 *
 * Deliberately an ESTIMATE and labelled as one. It is overwritten by the real
 * provider count in the final usage block, which is the one clients bill and
 * budget from.
 */
function estimateInputTokens(request: IRRequest): number {
  let total = request.system ? countTokens(request.system) : 0;
  for (const m of request.messages) total += countTokens(partsToText(m.content));
  for (const t of request.tools ?? []) total += countTokens(`${t.name}${t.description}`);
  return total;
}
import { dispatchWithFailover } from "./outbound/dispatch.js";
import { routerProfile } from "./constants.js";
import { providerKeyCounts } from "./providers/inventory.js";

/** Distinct from the dashboard's 4700 so both can run simultaneously. */
export const DEFAULT_ROUTER_PORT = 4800;

/** Loopback only. Widening requires NANITES_ROUTER_BIND, and it warns. */
export const DEFAULT_ROUTER_BIND = "127.0.0.1";

/**
 * 8 MB. Large enough for a base64 image or a chunk of audio, small enough that
 * a single request cannot exhaust the process's memory. R5b raises this for
 * video input, with a pre-dispatch size check rather than a bigger global cap.
 */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * One limiter per PROCESS, not per request. A per-request limiter would be
 * discarded immediately and limit nothing.
 */
const rateLimiter = new RateLimiter(DEFAULT_RATE_LIMIT);

/** Record a freshly-started tunnel on the server options, for /v1/health. */
function attachTunnel(opts: RouterServerOptions, tunnel: TunnelHandle): void {
  opts.tunnel = tunnel;
}

/** Drop rate-limit buckets that have been idle, so the map cannot grow forever. */
export function sweepIdleRateLimitBuckets(idleMs?: number): number {
  return rateLimiter.sweep(idleMs);
}

export interface RouterServerOptions {
  db: DatabaseSync;
  /** Injectable so tests can drive the clock instead of sleeping. */
  rateLimiter?: RateLimiter;
  /** Live tunnel handle, when one is running. Null otherwise. */
  tunnel?: TunnelHandle | null;
  port?: number;
  bind?: string;
  /** The stored hash every request is verified against. */
  keyHash: string;
  /** Injected so tests can observe helper availability without loading them. */
  helperStatus?: () => { needle: boolean; laya: boolean };
}

export interface RouterServerHandle {
  server: http.Server;
  port: number;
  bind: string;
  close(): Promise<void>;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res: http.ServerResponse, dialect: Dialect, status: number, code: string, message: string): void {
  const err = errorFor(dialect, status, code, message);
  sendJson(res, err.status, err.body);
}

/** Read and parse a JSON body, with the size cap enforced while reading. */
async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    // Abort as soon as the cap is passed rather than after buffering the
    // whole thing, so an oversized upload costs bounded memory.
    if (total > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(buf);
  }
  if (total === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid_json");
  }
}

interface HealthPayloadShape {
  status: "ok";
  port: number;
  bind: string;
  broadcast: boolean;
  key_present: boolean;
  providers: Array<{ provider: string; keys: number }>;
  advertised: number;
  aliases: number;
  tunnel: { enabled: boolean; url: string | null; running: boolean };
  helpers: { needle: boolean; laya: boolean; detail?: { needle: string; laya: string } };
  uptime_s: number;
}

function countRows(db: DatabaseSync, sql: string): number {
  try {
    const row = db.prepare(sql).get() as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  } catch {
    // A table that does not exist yet is 0 rows, not a startup failure.
    return 0;
  }
}

/**
 * The body of GET and PATCH /v1/config.
 *
 * One shape for both, so a caller can read the result of a write with the same
 * code it used to read the state. Reports the master flag, the per-feature
 * flags, and EFFECTIVE availability per feature — a flag being on is not the
 * same as the model being installed, and those need different fixes.
 */
function configPayload(db: DatabaseSync): Record<string, unknown> {
  const c = readConfig(db);
  const features = helperFeatureFlags(db);
  const availability: Record<string, { enabled: boolean; available: boolean; reason: string }> = {};
  for (const name of HELPER_FEATURE_NAMES) {
    const enabled = features[name] === true;
    const reason = featureReason(db, name as HelperFeature);
    availability[name] = { enabled, available: enabled && reason === "", reason: enabled ? reason : (reason || "off") };
  }
  return {
    enable_helpers: Boolean(c?.enable_helpers),
    enable_model_repair: Boolean(c?.enable_model_repair),
    features,
    availability,
    helpers: helperStatus(db),
  };
}

function buildHealth(opts: RouterServerOptions, port: number, bind: string, startedAt: number): HealthPayloadShape {
  // Real availability, read from the registry. An injected override exists for
  // tests, and the `detail` carries WHY a helper is unavailable — "not
  // installed" and "installed but broken" need different fixes.
  const status = helperStatus(opts.db);
  const helpers = {
    needle: opts.helperStatus?.().needle ?? status.needle.available,
    laya: opts.helperStatus?.().laya ?? status.laya.available,
    detail: { needle: status.needle.reason, laya: status.laya.reason },
  };
  const config = readConfig(opts.db);
  return {
    status: "ok",
    port,
    bind,
    // broadcast is true whenever the socket is not loopback-only. Surfaced so
    // the dashboard and the tunnel banner can warn without re-deriving it.
    broadcast: bind !== DEFAULT_ROUTER_BIND && bind !== "localhost",
    // NEVER the key itself. A boolean is all a caller needs.
    key_present: Boolean(config?.virtual_key_hash),
    providers: providerKeyCounts(opts.db),
    advertised: countRows(opts.db, "SELECT COUNT(*) AS n FROM router_advertised"),
    aliases: countRows(opts.db, "SELECT COUNT(*) AS n FROM router_aliases"),
    helpers,
    tunnel: {
      enabled: Boolean(opts.tunnel?.running ?? config?.tunnel_enabled),
      url: opts.tunnel?.url ?? config?.tunnel_url ?? null,
      // Never the pid or the error detail here: /v1/health is reachable by
      // anything that has the key, and a pid is more than a caller needs.
      running: Boolean(opts.tunnel?.running),
    },

    uptime_s: Math.floor((Date.now() - startedAt) / 1000),
  };
}

export function createRouterServer(opts: RouterServerOptions): http.Server {
  const startedAt = Date.now();

  return http.createServer((req, res) => {
    // The catch-all dialect is a guess only for a failure that happens before
    // the request handler could determine one. A handler that already knows
    // sends its own shaped error; this is the last-resort net.
    const fallbackDialect = detectDialect(req.headers);
    void handle(req, res, opts, startedAt).catch((err: unknown) => {
      if (!res.headersSent) {
        const code = (err as { code?: string })?.code ?? "unexpected_error";
        const message = (err as { message?: string })?.message ?? "Unhandled router error";
        const status = statusForCode(code);
        sendError(res, fallbackDialect, status, code, message);
      } else {
        res.end();
      }
    });
  });
}

/** The public shape of a job. The stored request is never echoed back. */
function publicJob(job: JobRow): Record<string, unknown> {
  return {
    job_id: job.job_id,
    status: job.status,
    phase: job.phase,
    // null when the provider reports no progress, which is the common case.
    progress: job.progress,
    model: job.model,
    source: job.source,
    target: job.target,
    artifact_uri: job.artifact_uri,
    error: job.error,
    created_at: job.created_at,
    updated_at: job.updated_at,
    completed_at: job.completed_at,
  };
}

async function readBodyText(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A list of strings, or undefined. A non-array is undefined, not a crash. */
function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Map a router/provider error code onto an HTTP status. */
function statusForCode(code: string): number {
  switch (code) {
    case "router_unauthorized":
      return 401;
    case "router_invalid_request":
    case "alias_unknown":
    case "alias_candidate_unknown":
    case "endpoint_not_configured":
    case "tool_call_unrepairable":
    case "modality_unsupported":
      return 400;
    case "provider_auth_error":
    case "provider_forbidden":
      return 403;
    case "provider_model_not_found":
      return 404;
    case "provider_rate_limited":
      return 429;
    case "provider_quota_exhausted":
    case "provider_insufficient_credits":
    case "all_keys_exhausted":
    case "provider_key_required":
      return 402;
    case "provider_timeout":
      return 504;
    case "chain_exhausted":
    case "all_models_exhausted":
      return 503;
    // A helper that is off, or installed but broken. 503 and not 500: the
    // router is fine and the request was well-formed, so a client should
    // retry rather than treat this as a permanent failure.
    case "helper_unavailable":
      return 503;
    // The helper ran and could not satisfy the request. The upstream worked.
    case "helper_no_result":
      return 422;
    default:
      return 500;
  }
}

/**
 * The inference path: decode -> resolve -> dispatch -> encode.
 *
 * Every failure here is already a structured NanitesError, so the outer
 * handler's catch can shape it into the caller's dialect without this function
 * needing to know which dialect it is serving.
 */
async function handleInference(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: RouterServerOptions,
  dialect: Dialect,
  pathname: string,
): Promise<void> {
  const anthropicPath = pathname.startsWith("/v1/messages");

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "body_too_large") {
      sendError(res, dialect, 413, "router_invalid_request", `Request body exceeds ${MAX_BODY_BYTES} bytes`);
      return;
    }
    sendError(res, dialect, 400, "router_invalid_request", "Request body is not valid JSON");
    return;
  }
  if (body === null) {
    sendError(res, dialect, 400, "router_invalid_request", "Request body is required");
    return;
  }

  let request = anthropicPath ? decodeAnthropicRequest(body) : decodeOpenAiRequest(body);

  // An alias is a CHAIN, not a single target. Resolve it first; a bare
  // advertised name or a namespaced id resolves to exactly one candidate and
  // skips the walk.
  const alias = request.model.includes(":") ? null : getAlias(opts.db, request.model);
  if (alias) {
    const startAt = alias.sticky_winner ?? 0;
    try {
      const walked = await walkChain(
        alias.alias,
        alias.candidates,
        startAt,
        async (candidate: ChainCandidate) => {
          const resolved: RoutableTarget = {
            provider: candidate.provider as never,
            endpoint: candidate.endpoint ?? null,
            model_id: candidate.model_id,
            stored_id: candidate.endpoint
              ? `${candidate.provider}:${candidate.endpoint}:${candidate.model_id}`
              : `${candidate.provider}:${candidate.model_id}`,
          };
          const hop: IRRequest = candidate.max_output_tokens
            ? { ...request, max_output_tokens: candidate.max_output_tokens }
            : request;
          const out = await dispatchWithFailover({ db: opts.db, target: resolved, request: hop });
          return { content: out.content, tool_calls: out.tool_calls };
        },
      );
      setStickyWinner(opts.db, alias.alias, walked.winner);
    } catch (err) {
      const code = (err as { code?: string }).code ?? "chain_exhausted";
      const message = (err as Error).message;
      sendError(res, dialect, statusForCode(code), code, message);
      return;
    }
    // The chain walker returns the raw answer shape; re-dispatch the winner so
    // the caller gets the full response with usage and served_by.
    // Past the helper branch above, so this target is a real provider.
    const target = resolveTarget(opts.db, request.model);
    if (!isRoutable(target)) throw new Error("unreachable: a helper cannot reach the chain re-dispatch");
    const response = await dispatchWithFailover({ db: opts.db, target, request });
    const payload = anthropicPath
      ? encodeAnthropicResponse(response, `msg_${randomUUID()}`)
      : encodeOpenAiResponse(response, `chatcmpl_${randomUUID()}`, Math.floor(Date.now() / 1000));
    sendJson(res, 200, payload);
    return;
  }

  const target = resolveTarget(opts.db, request.model);

  // A LOCAL HELPER. Checked before the Cloudflare branch and before the
  // streaming branch, because neither applies: a helper has no provider key
  // (so the key machinery would fail with a misleading "all keys exhausted"),
  // and it produces a single result rather than a token stream.
  if (target.provider === "helper") {
    const entry = resolveHelperAlias(target.model_id);
    if (!entry) {
      sendError(res, dialect, 400, "alias_unknown",
        `"${request.model}" resolved to helper model "${target.model_id}", which is not a known helper.`);
      return;
    }
    if (request.stream) {
      // Refused here, BEFORE any header is written, so the caller gets a
      // proper JSON error rather than a 200 followed by a fabricated stream.
      sendError(res, dialect, 400, "router_invalid_request",
        `"${entry.alias}" is a local model and does not support stream:true. Send a non-streaming request, or use POST /v1/helpers/${entry.op}.`);
      return;
    }
    try {
      const ir = await dispatchHelper(opts.db, entry, request);
      const payload = anthropicPath
        ? encodeAnthropicResponse(ir, `msg_${randomUUID()}`)
        : encodeOpenAiResponse(ir, `chatcmpl_${randomUUID()}`, Math.floor(Date.now() / 1000));
      sendJson(res, 200, payload);
    } catch (err) {
      const code = (err as { code?: string }).code ?? "helper_unavailable";
      sendError(res, dialect, statusForCode(code), code, (err as Error).message);
    }
    return;
  }

  // Past the helper branch, so this target is a real provider with a real
  // account. Narrowed once here rather than at four call sites below.
  if (!isRoutable(target)) {
    sendError(res, dialect, 400, "alias_unknown", `"${request.model}" is not a dispatchable model.`);
    return;
  }

  // A Cloudflare model outside the chat-completions shim goes to /ai/run,
  // which serves image, TTS, ASR, and the VQA models. Text-generation models
  // deliberately do NOT come here — the existing OpenAI-compatible path
  // already handles them, and the chat shim is the better-tested one.
  if (target.provider === "cloudflare" && needsRunPath(target.model_id)) {
    // A CONFIDENT contradiction is refused, never a reroute. The generation
    // path is already chosen because the MODEL is a generator; a text-only
    // request that Laya confidently calls "image" is a caller mistake worth
    // naming, but the router has no business silently swapping models on the
    // strength of a small classifier. Not confident -> carry on, which is
    // exactly the behaviour from before helpers existed.
    const declared = request.output_modality;
    const hasMedia = request.messages.some((m) =>
      typeof m.content !== "string" && m.content.some((p) => p.type !== "text"));
    if (!declared && !hasMedia) {
      const guess = await guessModality(opts.db, [], undefined);
      request = { ...request, output_modality: guess.modality };
      if (guess.source === "laya" && guess.modality !== "text" && guess.modality !== cfCategoryModality(target.model_id)) {
        sendError(res, dialect, 400, "router_invalid_request",
          `"${target.model_id}" generates ${cfCategoryModality(target.model_id)} output, but this request looks like a ${guess.modality} request and carries no ${guess.modality} input. Send the image, or address a text model instead.`);
        return;
      }
    }

    // A generation can run for over a minute, so a client that hangs up must
    // actually cancel it rather than paying for a render nobody receives.
    const generationAbort = new AbortController();
    const onClientGone = (): void => generationAbort.abort();
    res.once("close", onClientGone);

    try {
      const run = await dispatchCfRun({ db: opts.db, target, request, signal: generationAbort.signal });
      const ir = toIRResponse(run, request);
      // A modality reply is not a chat completion. The OpenAI image shape is
      // what a client expects for a generation request, so an artifact is
      // rendered as `data[0].b64_json` rather than as message content.
      if (run.artifact) {
        sendJson(res, 200, {
          created: Math.floor(Date.now() / 1000),
          model: request.model,
          data: [{ b64_json: run.artifact.b64, mime_type: run.artifact.mime }],
        });
        return;
      }
      const payload = anthropicPath
        ? encodeAnthropicResponse(ir, `msg_${randomUUID()}`)
        : encodeOpenAiResponse(ir, `chatcmpl_${randomUUID()}`, Math.floor(Date.now() / 1000));
      sendJson(res, 200, payload);
    } catch (err) {
      // A cancelled generation has no one left to tell: the socket is gone.
      if (generationAbort.signal.aborted) return;
      const code = (err as { code?: string }).code ?? "unexpected_error";
      sendError(res, dialect, statusForCode(code), code, (err as Error).message);
    } finally {
      res.removeListener("close", onClientGone);
    }
    return;
  }

  if (request.stream) {
    await handleStreaming(req, res, opts, anthropicPath, target, request);
    return;
  }

  const response = await dispatchWithFailover({ db: opts.db, target, request });

  const payload = anthropicPath
    ? encodeAnthropicResponse(response, `msg_${randomUUID()}`)
    : encodeOpenAiResponse(response, `chatcmpl_${randomUUID()}`, Math.floor(Date.now() / 1000));

  sendJson(res, 200, payload);
}

/**
 * The streaming path.
 *
 * Two failure modes dominate here, and both are handled explicitly:
 *
 *  - An error BEFORE `message_start` can still be a proper JSON error envelope,
 *    because nothing has been written yet.
 *  - An error AFTER the stream has begun cannot: the client has committed to
 *    the SSE contract. The stream is still terminated, so the client is never
 *    left waiting on a socket that will never close.
 */
async function handleStreaming(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: RouterServerOptions,
  anthropicPath: boolean,
  target: RoutableTarget,
  request: IRRequest,
): Promise<void> {
  const dialect: Dialect = anthropicPath ? "anthropic" : "openai";
  const abort = new AbortController();

  // The provider is contacted BEFORE headers are committed. That ordering is
  // deliberate: once writeHead has run, a JSON error envelope is impossible,
  // and a client that asked for a stream would get a 200 plus a stream of
  // nothing. Contacting first means a pre-delta failure (auth, rate limit,
  // unreachable provider) is reported as a normal error response, and only a
  // genuinely live stream commits to 200 + text/event-stream.
  let opened: OpenedUpstream;
  try {
    opened = await openUpstreamStream({ db: opts.db, target, request, signal: abort.signal });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? "unexpected_error";
    const message = (err as { message?: string })?.message ?? "upstream unavailable";
    sendError(res, dialect, statusForCode(code), code, message);
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders?.();

  const writer = createSseWriter({
    res,
    // A harness that hangs up mid-generation must stop the provider call, or
    // the user's credits burn on output nobody receives.
    onClose: () => abort.abort(),
    pingIntervalMs: 15_000,
  });

  const messageId = anthropicPath ? `msg_${randomUUID()}` : `chatcmpl_${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  // The two encoders are deliberately separate types, so the dialect is
  // narrowed once here rather than cast at every call site.
  const anthropic = anthropicPath ? createAnthropicStream(writer, messageId) : null;
  const openai = anthropicPath ? null : createOpenAiStream(writer, messageId, created);

  // message_start carries a chars/4 ESTIMATE because the provider has not been
  // contacted yet. Anthropic clients read the authoritative count from the
  // final accumulated message, which message_delta carries for real. A zero
  // here would not break either Claude Code or the Anthropic SDKs — they read
  // the final message — but an estimate is more useful than a hard zero and
  // costs nothing, since countTokens is a synchronous chars/4 fast path.
  const emptyAssembly = {
    content: "", thinking: "", signature: "", toolCalls: [],
    finish_reason: "", usage: { input_tokens: 0, output_tokens: 0 },
  };

  let began = false;
  try {
    if (anthropic) await anthropic.start(estimateInputTokens(request), request.model, messageId);
    else if (openai) await openai.start(request.model, messageId, created);
    began = true;

    // Events are pulled from the already-open upstream rather than awaited
    // inside dispatchStream, so headers commit the moment the stream is live.
    for await (const event of opened.events()) {
      if (anthropic) await anthropic.handle(event);
      else if (openai) await openai.handle(event);
    }
    const result = await opened.result;

    if (anthropic) await anthropic.endAll(result);
    else if (openai) await openai.endAll(result);
  } catch (err) {
    // Terminate regardless. A stream that stops without its dialect's
    // terminator hangs the client until it times out.
    const code = (err as { code?: string })?.code ?? "unexpected_error";
    const message = (err as { message?: string })?.message ?? "stream failed";
    try {
      // Headers are already committed, so a JSON error envelope is not
      // available here. The only correct move is to TERMINATE the stream in
      // its own dialect — a client left waiting on a socket that never closes
      // is worse than one that receives a well-formed empty completion.
      if (began) {
        if (anthropic) await anthropic.endAll(emptyAssembly);
        else if (openai) await openai.endAll(emptyAssembly);
      } else {
        if (anthropic) await anthropic.start(estimateInputTokens(request), request.model, messageId);
        if (anthropic) await anthropic.endAll(emptyAssembly);
        else if (openai) {
          await openai.start(request.model, messageId, created);
          await openai.endAll(emptyAssembly);
        }
      }
      void code; void message;
    } catch {
      // The socket is already gone; nothing left to report to.
    }
  } finally {
    await writer.close();
  }
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: RouterServerOptions,
  startedAt: number,
): Promise<void> {
  const bind = opts.bind ?? DEFAULT_ROUTER_BIND;
  const port = opts.port ?? DEFAULT_ROUTER_PORT;
  const dialect = detectDialect(req.headers);
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  // 1. AUTH — before the body is read, so an unauthenticated caller cannot
  //    make this process buffer a payload it will only reject.
  const presented = bearerToken(req.headers.authorization);
  if (!presented) {
    sendError(res, dialect, 401, "router_unauthorized", "Missing Authorization: Bearer <key> header");
    return;
  }
  const verdict = verifyVirtualKey(presented, opts.keyHash);
  if (!verdict.ok) {
    sendError(res, dialect, 401, "router_unauthorized", "Invalid API key");
    return;
  }

  // 4. RATE LIMIT — after auth, so an unauthenticated flood cannot consume a
  //    legitimate caller's budget, and before any body is read, so a rejected
  //    request costs nothing.
  //
  //    Bucketed on a HASH of the key rather than the key itself. The limiter
  //    lives in memory, and storing the presented secret as a map key would
  //    put it in a heap dump.
  const bucketKey = createHash("sha256").update(presented).digest("base64url");
  const limit = (opts.rateLimiter ?? rateLimiter).take(bucketKey);
  if (!limit.allowed) {
    res.setHeader("retry-after", String(limit.retryAfterSeconds));
    sendError(res, dialect, 429, "rate_limit_exceeded",
      `Rate limit exceeded. Retry in ${limit.retryAfterSeconds}s.`);
    return;
  }

  // 5. OUTBOUND GUARD — a stub for R0, but the seam is placed now so every
  //    handler added later is automatically behind it.
  const requestedUpstream = url.searchParams.get("upstream");
  if (requestedUpstream) {
    const check = assertOutboundUrl(requestedUpstream);
    if (!check.ok) {
      sendError(res, dialect, 400, "router_invalid_request", check.error);
      return;
    }
  }

  // 6. ROUTES
  if (req.method === "POST" && (pathname === "/v1/messages" || pathname === "/v1/chat/completions")) {
    await handleInference(req, res, opts, dialect, pathname);
    return;
  }

  if (req.method === "GET" && (pathname === "/v1/health" || pathname === "/v1/health/")) {
    sendJson(res, 200, buildHealth(opts, port, bind, startedAt));
    return;
  }

  /* --------------------------------------------------------------- config */
  // Behind the virtual key like everything else: a flag that turns a local
  // model on or off is not an anonymous action, and the router may be exposed
  // through a tunnel.
  if (pathname === "/v1/config" || pathname === "/v1/config/") {
    if (req.method === "GET") {
      const c = readConfig(opts.db);
      sendJson(res, 200, configPayload(opts.db));
      return;
    }
    if (req.method === "PATCH" || req.method === "POST") {
      let patch: Record<string, unknown>;
      try {
        patch = JSON.parse(await readBodyText(req)) as Record<string, unknown>;
      } catch {
        sendError(res, dialect, 400, "router_invalid_request", "Body is not valid JSON.");
        return;
      }
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        sendError(res, dialect, 400, "router_invalid_request", "Body must be a JSON object of config fields.");
        return;
      }
      try {
        const c = updateConfig(opts.db, patch);
        // Turning helpers ON has to AWAIT the probe, not fire it: the response
        // reports availability, and an unawaited probe would answer "false" for
        // a model that is installed and about to load.
        //
        // Turning them OFF is the opposite: the user-facing promise is that
        // turning helpers off STOPS them being used in flight, so the workers
        // are killed rather than left warm. A worker that is merely idle is not
        // "used", but a resident 1.16B-parameter model is exactly what the
        // user is trying to get rid of when they do not want to download and
        // run these models locally.
        if (c.enable_helpers) {
          await awaitProbeHelpers(opts.db);
        } else {
          await stopHelperWorkers();
        }
        sendJson(res, 200, configPayload(opts.db));
      } catch (err) {
        const code = (err as { code?: string }).code ?? "router_invalid_request";
        sendError(res, dialect, statusForCode(code), code, (err as Error).message);
      }
      return;
    }
  }

  /* -------------------------------------------------------------- helpers */
  // The dedicated surface: the helper's own result shape, not a chat
  // completion with the answer buried in a text block.
  const helperRoute = /^\/v1\/helpers\/(extract|classify|embed|score)\/?$/.exec(pathname);
  if (helperRoute && req.method === "POST") {
    const op = helperRoute[1] as "extract" | "classify" | "embed" | "score";
    const entry = HELPER_ALIASES.find((h) => h.op === op)!;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBodyText(req)) as Record<string, unknown>;
    } catch {
      sendError(res, dialect, 400, "router_invalid_request", "Body is not valid JSON.");
      return;
    }
    const out = await runHelperOp(opts.db, entry, {
      text: typeof body["text"] === "string" ? body["text"] : undefined,
      state: typeof body["state"] === "string" ? body["state"] : undefined,
      options: stringArray(body["options"]),
      criteria: stringArray(body["criteria"]),
      schema: isRecord(body["schema"]) ? body["schema"] : undefined,
    });
    if (!out.ok) {
      // 503 for "not available", 400 for "your request was wrong". Conflating
      // them sends an operator to debug their payload when the real problem is
      // a missing Python package.
      const status = out.code === "router_invalid_request" ? 400 : 503;
      sendError(res, dialect, status, out.code, out.message);
      return;
    }
    sendJson(res, 200, { object: "helper.result", helper: entry.helper, op: entry.op, result: out.result });
    return;
  }

  // ---- async generation jobs ----
  if (pathname === "/v1/jobs" || pathname === "/v1/jobs/") {
    const store = new JobStore(opts.db);
    if (req.method === "POST") {
      let body: { model?: string; body?: unknown; source?: string; target?: string };
      try {
        body = JSON.parse(await readBodyText(req)) as typeof body;
      } catch {
        sendError(res, dialect, 400, "router_invalid_request", "Body is not valid JSON.");
        return;
      }
      if (!body?.model) {
        sendError(res, dialect, 400, "router_invalid_request", "`model` is required.");
        return;
      }
      if (!body.body || typeof body.body !== "object") {
        sendError(res, dialect, 400, "router_invalid_request", "`body` is the request to run and is required.");
        return;
      }
      // A job runs the SAME request the sync path would, so a caller can move
      // from one to the other by wrapping the body — no second dialect to learn.
      const job = store.create({
        source: (body.source as never) ?? "text",
        target: (body.target as never) ?? "image",
        model: body.model,
        request: { body: body.body, dialect },
      });
      // Fire and forget. The job row is the source of truth; the caller polls
      // or subscribes.
      const jobAbort = new AbortController();
      void runJob({ db: opts.db, jobId: job.job_id, signal: jobAbort.signal })
        .catch(() => undefined);
      sendJson(res, 202, { job_id: job.job_id, status: job.status });
      return;
    }
    if (req.method === "GET") {
      sendJson(res, 200, { data: store.list().map(publicJob) });
      return;
    }
  }

  const jobMatch = /^\/v1\/jobs\/([A-Za-z0-9-]+)(\/events)?\/?$/.exec(pathname);
  if (jobMatch) {
    const store = new JobStore(opts.db);
    const jobId = jobMatch[1]!;
    const job = store.get(jobId);
    if (!job) {
      sendError(res, dialect, 404, "job_not_found", `No job ${jobId}.`);
      return;
    }
    if (req.method === "DELETE" && !jobMatch[2]) {
      sendJson(res, 200, { job_id: jobId, cancelled: store.cancel(jobId) });
      return;
    }
    if (req.method === "GET" && jobMatch[2]) {
      // SSE progress. Reuses the R2 writer; the frames are the same contract.
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.flushHeaders?.();
      const writer = createSseWriter({ res, pingIntervalMs: 15_000 });
      let last = "";
      for (;;) {
        const current = store.get(jobId);
        if (!current) break;
        const sig = `${current.status}:${current.phase}`;
        if (sig !== last) {
          last = sig;
          await writer.data({ type: "job", job: publicJob(current) });
        }
        if (store.isTerminal(current.status)) {
          await writer.data({ type: "job", job: publicJob(current) });
          break;
        }
        if (writer.closed) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      await writer.close();
      return;
    }
    if (req.method === "GET") {
      sendJson(res, 200, publicJob(job));
      return;
    }
  }

  if (req.method === "POST" && (pathname === "/v1/tunnel" || pathname === "/v1/tunnel/")) {
    // Control the tunnel from a harness. Requiring the virtual key is the
    // point: a tunnel is a PUBLIC URL pointed at the user's provider spend, so
    // turning one on is not an unauthenticated action.
    // A tunnel already running means the answer is its URL, not a second
    // tunnel. Starting another would leave the first one orphaned with a live
    // public URL.
    if (opts.tunnel?.running) {
      sendJson(res, 200, { running: true, url: opts.tunnel.url, already: true });
      return;
    }
    try {
      const fresh = await startTunnel({ port, timeoutMs: 60_000 });
      attachTunnel(opts, fresh);
      sendJson(res, 200, { running: true, url: fresh.url });
    } catch (err) {
      const reason = (err as { reason?: string }).reason ?? "spawn_failed";
      // A missing cloudflared is the NORMAL case and is a 501 "not
      // implemented here", not a 500: the router itself is fine.
      sendError(res, dialect, reason === "not_installed" ? 501 : 504,
        "tunnel_unavailable", err instanceof Error ? err.message : String(err));
    }
    return;
  }

  if (req.method === "GET" && (pathname === "/v1/models" || pathname === "/v1/models/")) {
    // ONLY the advertised subset. A harness pings this on connect, and
    // returning the whole consolidated provider catalog would fill its model
    // picker with ids the operator never chose to expose.
    const advertised = listAdvertised(opts.db);
    const hStatus = helperStatus(opts.db);
    // Helpers are advertised ONLY when actually available. A model listed here
    // that turns out to be missing produces a request-time failure, which is
    // the exact confusion an advertised catalog exists to prevent.
    //
    // Rendered from HELPER_ALIASES — the same constant resolveTarget consults.
    // These entries used to be a hand-written pair here, which is how a name
    // could be listed and then 400 as alias_unknown when a client sent it back.
    const helperModels: AdvertisedModel[] = HELPER_ALIASES
      .filter((h) => (h.helper === "needle3" ? hStatus.needle.available : hStatus.laya.available))
      .map((h) => ({
        alias: h.alias,
        real_id: h.real_id,
        provider: "helper",
        modalities: h.modalities,
        context_window: h.context_window,
        created_at: new Date(0).toISOString(),
      }));
    sendJson(res, 200, renderCatalog([...advertised, ...helperModels], dialect));
    return;
  }

  if (req.method === "GET" && (pathname === "/v1/keys" || pathname === "/v1/keys/")) {
    // Aggregate health per provider key. No secrets, and no per-key metrics
    // yet — those land in R3.
    sendJson(res, 200, { object: "list", data: providerKeyCounts(opts.db, { enabledOnly: false }) });
    return;
  }

  if (pathname === "/" || pathname === "/index.html") {
    sendJson(res, 200, {
      name: "nanites-router",
      status: "starting",
      docs: "/v1/health",
    });
    return;
  }

  sendError(res, dialect, 404, "router_invalid_request", `No route for ${req.method} ${pathname}`);
}

export async function startRouterServer(opts: RouterServerOptions): Promise<RouterServerHandle> {

  const port = opts.port ?? DEFAULT_ROUTER_PORT;
  const bind = opts.bind ?? DEFAULT_ROUTER_BIND;
  const server = createRouterServer(opts);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(port, bind, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;

  // Probing spawns a subprocess, so it must not delay the listener. The timer
  // is CLEARED on close: a probe that outlived a closed database threw
  // "database is not open" as an unhandled rejection, once per test run.
  const warm = setTimeout(() => {
    try {
      warmHelpers(opts.db);
    } catch {
      // A helper that cannot warm is simply unavailable.
    }
  }, 0);
  warm.unref?.();
  server.once("close", () => clearTimeout(warm));

  // Write the RESOLVED port back into the options the request closure captured.
  // Port 0 asks the OS for an ephemeral port, so the configured value and the
  // real one differ — and /v1/health must report where the socket actually is.
  opts.port = actualPort;

  return {
    server,
    port: actualPort,
    bind,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
