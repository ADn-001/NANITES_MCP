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
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { bearerToken, verifyVirtualKey, readConfig } from "./auth.js";
import { detectDialect, errorFor, type Dialect } from "./dialect.js";
import { assertOutboundUrl } from "../ui/guards.js";
import { NanitesError } from "../helpers/errors.js";
import { decodeAnthropicRequest, encodeAnthropicResponse } from "./inbound/anthropic.js";
import { decodeOpenAiRequest, encodeOpenAiResponse } from "./inbound/openai.js";
import { resolveTarget, type ResolvedTarget } from "./outbound/resolve.js";
import { listAdvertised, renderCatalog } from "./models/catalog.js";
import { getAlias, walkChain, setStickyWinner, type ChainCandidate } from "./models/aliases.js";
import { createSseWriter } from "./stream/sse.js";
import { createAnthropicStream, type AnthropicStreamEncoder } from "./stream/anthropicStream.js";
import { createOpenAiStream, type OpenAiStreamEncoder } from "./stream/openaiStream.js";
import { openUpstreamStream, type OpenedUpstream } from "./outbound/streamDispatch.js";
import { needsRunPath, dispatchCfRun, toIRResponse } from "./outbound/cloudflareRun.js";
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
import { ROUTER_PROFILE } from "./constants.js";

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

export interface RouterServerOptions {
  db: DatabaseSync;
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

interface HealthPayload {
  status: "ok";
  port: number;
  bind: string;
  broadcast: boolean;
  key_present: boolean;
  providers: Array<{ provider: string; keys: number }>;
  advertised: number;
  aliases: number;
  tunnel: { enabled: boolean; url: string | null };
  helpers: { needle: boolean; laya: boolean };
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

function providerKeyCounts(db: DatabaseSync): Array<{ provider: string; keys: number }> {
  try {
    const rows = db.prepare(
      `SELECT provider, COUNT(*) AS n FROM provider_api_keys
        WHERE profile_name = ? GROUP BY provider ORDER BY provider`,
    ).all(ROUTER_PROFILE) as Array<{ provider: string; n: number }>;
    return rows.map((r) => ({ provider: r.provider, keys: Number(r.n) }));
  } catch {
    return [];
  }
}

function buildHealth(opts: RouterServerOptions, port: number, bind: string, startedAt: number): HealthPayload {
  const config = readConfig(opts.db);
  const helpers = opts.helperStatus?.() ?? { needle: false, laya: false };
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
    tunnel: { enabled: Boolean(config?.tunnel_enabled), url: config?.tunnel_url ?? null },
    helpers,
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

  const request = anthropicPath ? decodeAnthropicRequest(body) : decodeOpenAiRequest(body);

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
          const resolved: ResolvedTarget = {
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
    const target = resolveTarget(opts.db, request.model);
    const response = await dispatchWithFailover({ db: opts.db, target, request });
    const payload = anthropicPath
      ? encodeAnthropicResponse(response, `msg_${randomUUID()}`)
      : encodeOpenAiResponse(response, `chatcmpl_${randomUUID()}`, Math.floor(Date.now() / 1000));
    sendJson(res, 200, payload);
    return;
  }

  const target = resolveTarget(opts.db, request.model);

  // A Cloudflare model outside the chat-completions shim goes to /ai/run,
  // which serves image, TTS, ASR, and the VQA models. Text-generation models
  // deliberately do NOT come here — the existing OpenAI-compatible path
  // already handles them, and the chat shim is the better-tested one.
  if (target.provider === "cloudflare" && needsRunPath(target.model_id)) {
    try {
      const run = await dispatchCfRun({ db: opts.db, target, request });
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
      const code = (err as { code?: string }).code ?? "unexpected_error";
      sendError(res, dialect, statusForCode(code), code, (err as Error).message);
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
  target: ResolvedTarget,
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

  // 2. OUTBOUND GUARD — a stub for R0, but the seam is placed now so every
  //    handler added later is automatically behind it.
  const requestedUpstream = url.searchParams.get("upstream");
  if (requestedUpstream) {
    const check = assertOutboundUrl(requestedUpstream);
    if (!check.ok) {
      sendError(res, dialect, 400, "router_invalid_request", check.error);
      return;
    }
  }

  // 3. ROUTES
  if (req.method === "POST" && (pathname === "/v1/messages" || pathname === "/v1/chat/completions")) {
    await handleInference(req, res, opts, dialect, pathname);
    return;
  }

  if (req.method === "GET" && (pathname === "/v1/health" || pathname === "/v1/health/")) {
    sendJson(res, 200, buildHealth(opts, port, bind, startedAt));
    return;
  }

  if (req.method === "GET" && (pathname === "/v1/models" || pathname === "/v1/models/")) {
    // ONLY the advertised subset. A harness pings this on connect, and
    // returning the whole consolidated provider catalog would fill its model
    // picker with ids the operator never chose to expose.
    const advertised = listAdvertised(opts.db);
    sendJson(res, 200, renderCatalog(advertised, dialect));
    return;
  }

  if (req.method === "GET" && (pathname === "/v1/keys" || pathname === "/v1/keys/")) {
    // Aggregate health per provider key. No secrets, and no per-key metrics
    // yet — those land in R3.
    sendJson(res, 200, { object: "list", data: providerKeyCounts(opts.db) });
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
