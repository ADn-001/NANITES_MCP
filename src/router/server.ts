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
import type { DatabaseSync } from "node:sqlite";
import { bearerToken, verifyVirtualKey, readConfig } from "./auth.js";
import { detectDialect, errorFor, type Dialect } from "./dialect.js";
import { assertOutboundUrl } from "../ui/guards.js";

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
    ).all("__router__") as Array<{ provider: string; n: number }>;
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
    void handle(req, res, opts, startedAt).catch(() => {
      if (!res.headersSent) {
        sendError(res, "openai", 500, "unexpected_error", "Unhandled router error");
      } else {
        res.end();
      }
    });
  });
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
  if (req.method === "GET" && (pathname === "/v1/health" || pathname === "/v1/health/")) {
    sendJson(res, 200, buildHealth(opts, port, bind, startedAt));
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
