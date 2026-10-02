/**
 * Companion-UI HTTP server. A tiny node:http app (no Express) that serves the
 * single dashboard HTML file and exposes read-only JSON/SSE endpoints over a
 * shared NANITES_HOME DB. Runs as a SEPARATE process from the stdio MCP server
 * (`npm run ui`), so it cannot share an in-process EventEmitter with it — live
 * updates arrive by polling the `sub_agent_events` table and fanning out to
 * connected SSE clients.
 *
 * Nothing here returns raw LM Studio HTTP bodies or stack traces: every error
 * is a structured `{code, message, retryable}` shape, per §6 of the project
 * instructions.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { ToolDeps } from "../tools/deps.js";
import { readHelperState, applyHelperToggle } from "../tools/routerHelpers.js";
import { providerKeyCounts, providerModelCounts, routerTableCount } from "../router/providers/inventory.js";
import { readConfig } from "../router/auth.js";
import { routerProfile } from "../router/constants.js";
import { clientForProfile } from "../tools/deps.js";
import { runHealthCheck, defaultDiskDir as healthDiskDir, type RecoveryStep } from "../health/checker.js";
import { isAllowedHostHeader, isAllowedOrigin, newLanToken, tokensMatch, assertOutboundUrl, LAN_TOKEN_HEADER } from "./guards.js";
import { runBtwChatMessage } from "../workflows/btwChat.js";
import {
  profilePatchSchema,
  providerPreferenceOrderSchema,
  PROVIDER_KINDS,
  DEFAULT_THEME,
  type CreateProfileInput,
  type Profile,
} from "../storage/profileDefaults.js";
import { NanitesError } from "../helpers/errors.js";
import { configuredUiPort } from "../helpers/uiPort.js";
import { adviseGuardrails } from "../guardrails/advisor.js";
import { allowedPairsForVram } from "../guardrails/tiers.js";
import { sampleLiveFreeVram } from "../helpers/liveVram.js";
import {
  readDashboardSettings,
  writeDashboardSettings,
  lanIPv4,
  findFreePort,
  type BroadcastProjection,
} from "./broadcast.js";
import { ProviderKeyStore } from "../storage/providerKeyStore.js";
import { ProviderModelStore } from "../storage/providerModelStore.js";
import { ProviderErrorStore } from "../storage/providerErrorStore.js";
import { ProviderStickyStore } from "../storage/providerStickyStore.js";
import { RolePinStore } from "../storage/rolePinStore.js";
import { BUILT_IN_ROLES } from "../workflows/roleMatch.js";
import type { ProviderKind } from "../storage/profileDefaults.js";
import * as z from "zod/v4";

export const DEFAULT_UI_PORT = 4700;
export const SSE_POLL_MS = 200;
export const SSE_HEARTBEAT_MS = 15_000;
/** Connect replay window for /api/stream: events older than this never replay. */
export const STREAM_REPLAY_WINDOW_MS = 15 * 60_000;

/** Moby Dick ≈ 206k words ≈ 1.16M tokens — the "famous work" ledger yardstick. */
export const MOBY_DICK_TOKENS = 1_160_000;

export type LedgerRange = "7d" | "30d" | "all";

export interface UiServerOptions {
  port?: number;
  host?: string;
  /**
   * Pin the health report's free-disk reading. `/api/health` reports
   * `healthy` vs `degraded` partly from measured disk space, so a test that
   * asserts the verdict would otherwise depend on how full the host's system
   * volume happens to be. Tests pass a fixed value; production
   * leaves it undefined and the reading is measured.
   */
  diskAvailableGb?: number;
}

/**
 * Live binding state of the dashboard, exposed to the router so the Broadcast
 * toggle can rebind the running listener (127.0.0.1 <-> 0.0.0.0) without a
 * process restart. `server` must be assigned before any of these are callable.
 */
export interface UiBind {
  host: () => string;
  port: () => number;
  /**
   * LAN hostnames accepted while Broadcast is on; empty otherwise, which makes
   * LAN access fail closed. Resolved at bind time, never per request:
   * `lanIPv4()` opens a UDP socket with a 1.5s timeout, which would be
   * catastrophic on the request path.
   */
  lanHosts: () => readonly string[];
  /** Per-boot token a LAN peer must present to mutate anything. */
  lanToken: () => string;
  rebind: (host: string, port: number) => Promise<void>;
}

export interface UiServer {
  server: Server;
  host: string;
  port: number;
  /** Token a LAN peer must present to mutate. Absent unless Broadcast is on. */
  lanToken?: string;
  /** LAN hostnames accepted while Broadcast is on; empty otherwise. */
  lanHosts: readonly string[];
  close(): Promise<void>;
}

function listenOn(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

/**
 * Stop the live listener and relisten on a new host/port. `server.close()` only
 * completes once every socket is gone, so after closing we drop idle keep-alive
 * sockets (the caller must have already flushed any in-flight response).
 */
function relisten(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.close(() => {
      server.removeListener("error", reject);
      void listenOn(server, host, port).then(resolve, reject);
    });
    // Free idle keep-alive connections so close() above actually completes.
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  });
}

/** Projection shape for a concrete live bind (avoids re-probing for a free port). */
async function projectionFor(enabled: boolean, host: string, port: number): Promise<BroadcastProjection> {
  if (!enabled) return { enabled: false, host: "127.0.0.1", port, url: null };
  const ip = await lanIPv4();
  return { enabled: true, host, port, url: ip ? `http://${ip}:${port}` : null };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

/**
 * Provider text is mapped to a stable, caller-safe message. The provider
 * clients interpolate upstream response bodies — which carry account ids,
 * quota figures and request ids — into NanitesError.message, and those
 * routes are unauthenticated, so echoing them leaks provider internals to
 * the LAN. Log the real text server-side instead.
 */
const PROVIDER_ERROR_TEXT: Record<string, string> = {
  provider_auth_failed: "Provider rejected the key or account",
  provider_quota_exceeded: "Provider quota exhausted",
  provider_rate_limited: "Provider rate limited this request",
  provider_not_found: "Provider endpoint or model not found",
  provider_unreachable: "Could not reach the provider",
  connection_refused: "Could not reach the provider",
  request_timeout: "Provider did not respond in time",
};

function publicErrorMessage(e: unknown): { code: string; message: string; retryable: boolean } {
  if (e instanceof NanitesError) {
    return {
      code: e.code,
      message: PROVIDER_ERROR_TEXT[e.code] ?? "Provider request failed",
      retryable: e.retryable,
    };
  }
  return { code: "provider_unreachable", message: "Provider request failed", retryable: false };
}

function sendError(res: ServerResponse, status: number, code: string, message: string, retryable = false): void {
  sendJson(res, status, { code, message, retryable });
}

/**
 * True when a request arrived over loopback. The dashboard binds to 0.0.0.0
 * while broadcast is on, so the same-machine browser still arrives as
 * 127.0.0.1 (loopback) whereas a phone/other LAN device arrives as its own IP.
 */
function isLoopbackRequest(req: IncomingMessage): boolean {
  const addr = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  return addr === "127.0.0.1" || addr === "::1" || addr === "localhost";
}
/**
 * Broadcast makes the dashboard reachable from the LAN, where a hostile device
 * is as plausible as a phone. LAN peers get the read-only view; mutating
 * anything requires the per-boot token printed to the terminal. Loopback is
 * the user's own machine and keeps full access.
 *
 * Deliberately keyed on the socket address rather than Host: a caller controls
 * Host, not its own source address, and this is the last check before a
 * destructive route runs.
 */
function requireMutatorAccess(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  bind: UiBind,
): boolean {
  if (isLoopbackRequest(req)) return true;
  const presented = url.searchParams.get("token") ?? req.headers[LAN_TOKEN_HEADER];
  const token = Array.isArray(presented) ? presented[0] : presented;
  if (tokensMatch(token, bind.lanToken())) return true;
  sendError(
    res,
    403,
    "lan_read_only",
    "Mutations from the LAN require the dashboard token (?token= or the " + LAN_TOKEN_HEADER + " header).",
    false,
  );
  return false;
}

/** Reveals nothing but stays a password-field-dotted value in the editor. */
const REMOTE_SECRET_MASK = "••••••••••••••••";

/** For non-loopback (LAN) viewers a secret is never revealed — returns a mask. */
function secretFor(remote: boolean, secret: string | null | undefined): string | null {
  if (!remote) return secret ?? null;
  return secret ? REMOTE_SECRET_MASK : null;
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
  res.end(html);
}

function activeProfileName(deps: ToolDeps): string | null {
  return deps.profiles.getActiveProfile()?.name ?? null;
}

/** Read a JSON request body, rejecting malformed input with a structured error. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new NanitesError({ code: "body_too_large", message: "Request body too large", retryable: false }));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (raw.trim() === "") return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new NanitesError({ code: "bad_request", message: "Request body is not valid JSON", retryable: false }));
      }
    });
    req.on("error", reject);
  });
}

// ---- index ----

function loadIndexHtml(): string {
  // dist/ui/index.html is the built artifact (copied from frontend at build
  // time); the source mock is the dev fallback so `tsx src/ui/main.ts` works
  // before a build has run.
  const candidates = [
    path.resolve(process.cwd(), "dist", "ui", "index.html"),
    path.resolve(process.cwd(), "frontend", "nanites-dashboard.html"),
  ];
  for (const file of candidates) {
    if (existsSync(file)) return readFileSync(file, "utf8");
  }
  return "<!doctype html><title>Nanites</title><body><h1>Dashboard not built</h1><p>Run <code>npm run build</code> first.</p></body>";
}

// ---- static UI assets ----

/** Extensions the dashboard may reference by relative URL, and their types. */
const ASSET_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

/** Directory the built dashboard's assets live in (same dir as index.html). */
function uiAssetDir(): string | null {
  for (const dir of [
    path.resolve(process.cwd(), "dist", "ui"),
    path.resolve(process.cwd(), "frontend"),
  ]) {
    if (existsSync(path.join(dir, "index.html"))) return dir;
  }
  return null;
}

/**
 * Serve a dashboard asset. The name is taken as a basename, never a path, and
 * the resolved file is then checked for containment — so `..` in the URL has
 * no shape that can walk out of `dist/ui` and read an arbitrary file.
 */
function sendUiAsset(res: ServerResponse, urlPath: string): boolean {
  const dir = uiAssetDir();
  if (!dir) return false;
  const name = urlPath.slice(1);
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") return false;
  const type = ASSET_TYPES[path.extname(name).toLowerCase()];
  if (!type) return false;

  const resolved = path.resolve(dir, name);
  if (path.dirname(resolved) !== path.resolve(dir)) return false;
  if (!existsSync(resolved)) return false;

  const body = readFileSync(resolved);
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": body.length,
    // Assets change on rebuild; never let a stale one outlive its HTML.
    "Cache-Control": "no-cache",
  });
  res.end(body);
  return true;
}

// ---- leaderboard ----

function paramsLabel(params: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof params.context_length === "number") parts.push(`ctx ${params.context_length}`);
  if (typeof params.temperature === "number") parts.push(`temp ${params.temperature}`);
  return parts.length ? parts.join(" · ") : "—";
}

function handleLeaderboard(deps: ToolDeps, url: URL, res: ServerResponse): void {
  const profileName = activeProfileName(deps);
  if (!profileName) return sendError(res, 404, "no_active_profile", "No active profile set", false);

  // Role filter is any role name: built-ins like reviewer /
  // vision, custom unit roles, or "all". No enum gate.
  const rawRole = (url.searchParams.get("role") ?? "all").trim();
  const role = rawRole === "" ? "all" : rawRole;

  const view = url.searchParams.get("view") ?? "all";
  const isCloud = view === "cloud" || view === "all";
  const isLocal = view === "local" || view === "all";

  // Narrow to one provider. `view` only ever said all/local/cloud, so there
  // was no way to ask the leaderboard for a single provider's models.
  const provFilter = (url.searchParams.get("provider") ?? "").trim() || null;

  // Merged rows: the registry is the single per-model scoring
  // record (local + provider-tagged cloud rows). Real per-role scores drive the
  // row's `score` under a role filter; registered-but-untested cloud models
  // (provider catalog rows with no registry entry yet) are appended with a null
  // score. Registry rows keep local + cloud namespaces apart by provider.
  type Row = {
    model: string;
    model_id: string;
    provider: string | null;
    score: number | null;
    score_minima: number | null;
    params: string;
    tested: string | null;
  };

  const rows: Row[] = [];

  if (isLocal || isCloud) {
    const all = deps.registry.list(profileName);
    const entries =
      view === "all" ? all : isLocal ? all.filter((e) => e.provider === null) : all.filter((e) => e.provider !== null);
    for (const e of entries) {
      if (provFilter && (e.provider ?? null) !== provFilter) continue;
      if (role !== "all" && !e.roles.includes(role)) continue;
      const roleScore = role !== "all" ? (e.scores?.[role] ?? null) : null;
      rows.push({
        model: e.model_id,
        model_id: e.model_id,
        provider: e.provider ?? null,
        score: role !== "all" ? roleScore : (e.performance_score ?? null),
        score_minima: e.score_minima?.[role] ?? null,
        params: paramsLabel(e.best_params),
        tested: e.last_tested,
      });
    }
  }

  if (isCloud) {
    const modelStore = new ProviderModelStore(deps.db);
    // Keyed by provider AND id. Keying on the id alone meant a model another
    // provider had already tested suppressed this provider's copy of it, so a
    // registered model silently vanished from the board — the count in the
    // Providers tab and the rows on the board stopped agreeing.
    const registeredIds = new Set(
      deps.registry.list(profileName).map((e) => (e.provider ?? "local") + " " + e.model_id),
    );
    const catalog = modelStore
      .listModels(profileName, undefined, true)
      .filter((m) => !provFilter || m.provider === provFilter);
    for (const m of catalog) {
      // Registered catalog row with no registry entry yet = registered, untested.
      // Only inferable role for an untested catalog row is `vision` (from its
      // capabilities) — other role membership lives on the registry entry.
      if (registeredIds.has(m.provider + " " + m.model_id)) continue;
      if (role !== "all" && !(role === "vision" && m.capabilities.vision === true)) continue;
      rows.push({
        model: m.name || m.model_id,
        model_id: m.model_id,
        provider: m.provider ?? null,
        score: m.performance_score ?? null,
        score_minima: null,
        params: m.context_window ? `ctx ${m.context_window.toLocaleString()}` : "—",
        tested: m.last_refreshed,
      });
    }
  }

  // Order by score desc with null scores last (untested rows sink), then name.
  rows.sort(
    (a, b) => (b.score ?? -1) - (a.score ?? -1) || a.model.localeCompare(b.model),
  );

  sendJson(res, 200, { rows });
}

// ---- ledger ----

function rangeToCutoffMs(range: LedgerRange): number {
  if (range === "7d") return 7 * 86_400_000;
  if (range === "30d") return 30 * 86_400_000;
  return Number.POSITIVE_INFINITY;
}

function handleLedger(deps: ToolDeps, url: URL, res: ServerResponse): void {
  const profileName = activeProfileName(deps);
  if (!profileName) return sendError(res, 404, "no_active_profile", "No active profile set", false);

  const raw = url.searchParams.get("range") ?? "all";
  const range: LedgerRange = ["7d", "30d", "all"].includes(raw) ? (raw as LedgerRange) : "all";

  const nowMs = Date.now();
  const windowMs = rangeToCutoffMs(range);
  const cutoffMs = nowMs - windowMs;

  // Bounded in SQL rather than pulled whole and filtered here — the endpoint
  // used to materialize up to a million rows per request.
  const sinceIso = windowMs === Number.POSITIVE_INFINITY ? null : new Date(cutoffMs).toISOString();
  const localCalls = deps.callLogs.list(profileName, 1_000_000, sinceIso);
  const cloudCalls = deps.providerCallLogs.listRecent(profileName, { sinceIso });

  // One row shape for both namespaces. Cloud rows carry a real provider charge
  // and a finish_reason; local rows are free and have neither. Merging here
  // (rather than in the UI) keeps a cloud run from being invisible.
  interface LedgerRow {
    created_at: string;
    role: string | null;
    model_id: string;
    provider: string | null;
    tokens_in: number;
    tokens_out: number;
    duration_ms: number;
    cost_usd: number | null;
    error_code: string | null;
    finish_reason: string | null;
  }

  const calls: LedgerRow[] = [
    ...localCalls.map((c) => ({
      created_at: c.created_at ?? "",
      role: c.role ?? null,
      model_id: c.model_id,
      provider: null,
      tokens_in: c.tokens_in,
      tokens_out: c.tokens_out,
      duration_ms: c.duration_ms,
      cost_usd: c.cost_usd ?? null,
      error_code: c.error_code ?? null,
      finish_reason: null,
    })),
    ...cloudCalls.map((c) => ({
      created_at: c.created_at,
      role: c.role ?? null,
      model_id: c.model_id,
      provider: c.provider,
      tokens_in: c.tokens_in,
      tokens_out: c.tokens_out,
      duration_ms: c.duration_ms,
      cost_usd: c.cost_usd ?? null,
      error_code: c.status === "success" ? null : c.status,
      finish_reason: c.finish_reason ?? null,
    })),
  ];

  // Bucketed token timeseries, one bucket per calendar day.
  const dayBuckets = new Map<string, number>();
  for (const c of calls) {
    const d = c.created_at ? new Date(c.created_at) : new Date(0);
    const key = `${d.getMonth() + 1}/${d.getDate()}`;
    dayBuckets.set(key, (dayBuckets.get(key) ?? 0) + c.tokens_in + c.tokens_out);
  }
  const timeseries = { labels: [...dayBuckets.keys()], tokens: [...dayBuckets.values()] };

  // Role doughnut counts.
  const roleCounts = new Map<string, number>();
  for (const c of calls) {
    const role = c.role ?? "unassigned";
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
  }
  const roles = [...roleCounts.entries()].map(([role, count]) => ({ role, calls: count }));

  const totalRuns = calls.length;
  const errors = calls.filter((c) => c.error_code != null && c.error_code !== "").length;
  const successRate = totalRuns ? (totalRuns - errors) / totalRuns : 0;
  const totalTokens = calls.reduce((s, c) => s + c.tokens_in + c.tokens_out, 0);
  const totalDurationMs = calls.reduce((s, c) => s + c.duration_ms, 0);
  const avgTs = totalDurationMs > 0 ? totalTokens / (totalDurationMs / 1000) : 0;
  // A local row's cost_usd is the orchestrator-equivalent that was AVOIDED; a
  // cloud row's is money actually paid. Summing them together would report
  // spend as saving, so they stay separate.
  const savedUsd = calls.reduce((s, c) => s + (c.provider === null ? (c.cost_usd ?? 0) : 0), 0);
  const spentUsd = calls.reduce((s, c) => s + (c.provider !== null ? (c.cost_usd ?? 0) : 0), 0);

  const modelCounts = new Map<string, number>();
  for (const c of calls) modelCounts.set(c.model_id, (modelCounts.get(c.model_id) ?? 0) + 1);
  // Most-used model; ties break lexicographically so the UI is stable run-to-run.
  let favouriteModel: string | null = null;
  let favCount = 0;
  for (const [model, n] of modelCounts) {
    if (n > favCount || (n === favCount && (favouriteModel === null || model < favouriteModel))) {
      favCount = n;
      favouriteModel = model;
    }
  }

  sendJson(res, 200, {
    range,
    timeseries,
    roles,
    rows: calls.map((c) => ({
      ts: c.created_at ? c.created_at.slice(0, 19).replace("T", " ") : "",
      role: c.role ?? "unassigned",
      model: c.model_id,
      provider: c.provider,
      tin: c.tokens_in,
      tout: c.tokens_out,
      lat: c.duration_ms,
      cost_usd: c.cost_usd,
      finish_reason: c.finish_reason,
    })),
    fun_stats: {
      total_runs: totalRuns,
      success_rate: Math.round(successRate * 1000) / 1000,
      avg_t_s: Math.round(avgTs * 100) / 100,
      saved_usd: savedUsd,
      spent_usd: spentUsd,
      cloud_runs: cloudCalls.length,
      favourite_model: favouriteModel,
      tokens_vs_moby_dick: Math.round((totalTokens / MOBY_DICK_TOKENS) * 10000) / 10000,
    },
  });
}

// ---- health ----

/** No-op recovery so a dashboard poll never spawns `lms server start` or hangs 3s. */
const NOOP_RECOVERY: RecoveryStep = { run: async () => {}, waitMs: 0 };

async function handleHealth(
  deps: ToolDeps,
  req: IncomingMessage,
  res: ServerResponse,
  diskAvailableGb?: number,
): Promise<void> {
  const profile = deps.profiles.getActiveProfile();
  if (!profile) return sendError(res, 404, "no_active_profile", "No active profile set", false);
  const remote = !isLoopbackRequest(req);

  const client = clientForProfile(profile, { timeoutMs: 5000 });
  const live = await sampleLiveFreeVram();
  const report = await runHealthCheck({
    profile: profile.name,
    client,
    recovery: NOOP_RECOVERY,
    hardware: { vram_gb: profile.machine_specs.vram_gb, live_free_vram_gb: live.free_vram_gb },
    // Measured on the models volume, never the ambient system disk. Without
    // this the report's "healthy/degraded" verdict depends on whatever drive
    // the host happens to be low on. Tests pin `availableGb` instead.
    disk: deps.healthDisk ?? (diskAvailableGb !== undefined ? { availableGb: diskAvailableGb } : { dir: healthDiskDir() }),
  });

  // Resident cards: one per loaded model. `vram_pct` is a rough size-based
  // estimate relative to the profile's VRAM (the LM Studio listModels response
  // does not report per-model VRAM), kept deterministic so the gauge is stable.
  const vramGb = profile.machine_specs.vram_gb || 1;
  let resident: Array<{ id: string; quant: string | null; ctx: number | null; vram_pct: number; level: string }> = [];
  if (report.reachable) {
    try {
      const { models } = await client.listModels();
      resident = models
        .filter((m) => m.loaded_instances.length > 0)
        .map((m) => ({
          id: m.key,
          quant: m.quantization?.name ?? null,
          ctx: m.loaded_instances[0]?.config?.context_length ?? null,
          vram_pct: Math.max(4, Math.min(96, Math.round((m.size_bytes / (vramGb * 1e9)) * 100))),
          level: "ok",
        }));
    } catch {
      // reachability already decided above; leave resident empty
    }
  }

  sendJson(res, 200, {
    ...report,
    resident,
    theme: profile.theme ?? DEFAULT_THEME,
    inference: profile.inference ?? null,
    dynamic_model: profile.dynamic_model,
    endpoint: { auth_token: secretFor(remote, profile.endpoint.auth_token) },
    hardware: {
      vram_gb: vramGb,
      mode: profile.concurrency.mode,
      max_parallel_models: profile.concurrency.max_parallel_models,
      process_cap: profile.concurrency.max_parallel_models,
      num_parallel: profile.concurrency.num_parallel,
      allowed_pairs: allowedPairsForVram(vramGb),
      overridden: profile.concurrency_override != null,
    },
  });
}

// ---- profiles ----

/** Profiles + active name, trimmed for the dropdown and the 9:16 cards. */
function buildProfilesResponse(deps: ToolDeps): { active: string | null; profiles: unknown[] } {
  const active = activeProfileName(deps);
  const profiles = deps.profiles
    .listProfiles()
    .map((name) => {
      const p = deps.profiles.getProfile(name);
      if (!p) return null;
      const tier = adviseGuardrails({ vram_gb: p.machine_specs.vram_gb });
      return {
        name: p.name,
        theme: p.theme ?? null,
        effort: p.inference?.effort ?? "medium",
        concurrency_tier: tier.tier,
        mode: p.concurrency.mode,
        concurrency: {
          max_parallel_models: p.concurrency.max_parallel_models,
          num_parallel: p.concurrency.num_parallel,
        },
        allowed_pairs: allowedPairsForVram(p.machine_specs.vram_gb),
        overridden: p.concurrency_override != null,
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);
  return { active, profiles };
}

/** GET /api/profiles — trimmed profile list + active profile name. */
function handleProfiles(deps: ToolDeps, res: ServerResponse): void {
  sendJson(res, 200, buildProfilesResponse(deps));
}

/**
 * The editor projection of a profile, with secrets masked for remote callers.
 *
 * Extracted so GET /api/profile and POST /api/settings/profile share one
 * masking rule. The POST handler used to return the updated Profile verbatim,
 * so a cross-origin POST could read back the unmasked endpoint.auth_token and
 * ntfy.access_token that the GET carefully redacts.
 */
function editorProfileFor(p: Profile, remote: boolean): Record<string, unknown> {
  return {
    name: p.name,
    theme: p.theme ?? null,
    endpoint: { url: p.endpoint.url, auth_token: secretFor(remote, p.endpoint.auth_token) },
    machine_specs: p.machine_specs,
    pricing: p.pricing,
    ntfy: { ...p.ntfy, access_token: secretFor(remote, p.ntfy.access_token) },
    inference: p.inference
      ? {
          effort: p.inference.effort,
          output_token_ceiling: p.inference.output_token_ceiling,
          system_prompt: p.inference.system_prompt ?? null,
          ttl_s: p.inference.ttl_s ?? 0,
        }
      : null,
    dynamic_model: p.dynamic_model,
    vision_capable: p.vision_capable,
    use_case: p.use_case,
    concurrency_override: p.concurrency_override ?? null,
    concurrency: {
      mode: p.concurrency.mode,
      max_parallel_models: p.concurrency.max_parallel_models,
      num_parallel: p.concurrency.num_parallel,
    },
    allowed_pairs: allowedPairsForVram(p.machine_specs.vram_gb),
    overridden: p.concurrency_override != null,
  };
}

/** Editable fields of a named profile, for the Profile Editor to populate. */
function handleProfile(deps: ToolDeps, url: URL, req: IncomingMessage, res: ServerResponse): void {
  const name = url.searchParams.get("name") ?? "";
  const p = deps.profiles.getProfile(name);
  if (!p) return sendError(res, 404, "profile_not_found", `No profile named "${name}"`, false);
  sendJson(res, 200, { profile: editorProfileFor(p, !isLoopbackRequest(req)) });
}

// ---- settings ----

const wipeBodySchema = z.object({
  before_date: z.string().optional(),
  all: z.boolean().optional(),
});

async function handleWipe(deps: ToolDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const profileName = activeProfileName(deps);
  if (!profileName) return sendError(res, 404, "no_active_profile", "No active profile set", false);

  const body = await readJsonBody(req);
  const parsed = wipeBodySchema.safeParse(body);
  if (!parsed.success) {
    return sendError(res, 400, "bad_request", "Wipe body must be { before_date: ISO } or { all: true }", false);
  }

  const { before_date, all } = parsed.data;
  if (all === true) {
    return sendJson(res, 200, {
      deleted: {
        sub_agent_calls: deps.callLogs.deleteAll(profileName),
        sub_agent_events: deps.subAgentEvents.deleteAll(profileName),
        param_search_attempts: deps.paramSearch.deleteAll(profileName),
        jobs: deps.jobs.deleteAll(profileName),
        // Phase H ephemeral bucket (btw-spec-v2 §3): the throwaway chat and
        // the compaction caches all clear on wipe.
        btw_chat: deps.btwChat.deleteAll(profileName),
        btw_chat_messages: deps.btwChatMessages.deleteAll(profileName),
        btw_chunks: deps.chunkEmbeddings.deleteAll(profileName),
        context_caches: deps.contextCache.deleteAll(profileName),
      },
    });
  }
  if (typeof before_date === "string") {
    return sendJson(res, 200, {
      deleted: {
        sub_agent_calls: deps.callLogs.deleteBefore(profileName, before_date),
        sub_agent_events: deps.subAgentEvents.deleteBefore(profileName, before_date),
        param_search_attempts: deps.paramSearch.deleteBefore(profileName, before_date),
        jobs: deps.jobs.deleteBefore(profileName, before_date),
        btw_chat: deps.btwChat.deleteBefore(profileName, before_date),
        btw_chat_messages: deps.btwChatMessages.deleteBefore(profileName, before_date),
        btw_chunks: deps.chunkEmbeddings.deleteBefore(profileName, before_date),
        context_caches: deps.contextCache.deleteBefore(profileName, before_date),
      },
    });
  }
  return sendError(res, 400, "bad_request", "Wipe requires either 'before_date' or 'all': true", false);
}

async function handleSettingsProfile(deps: ToolDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const active = activeProfileName(deps);
  if (!active) return sendError(res, 404, "no_active_profile", "No active profile set", false);

  const body = (await readJsonBody(req)) as ({ profile?: unknown } & Record<string, unknown>) | null;
  // The dropdown may target a different profile than the active one; the patch
  // schema strips unknown keys, so pull `profile` off before parsing.
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return sendError(res, 400, "bad_request", "Profile patch is malformed", false);
  }
  const target = typeof body.profile === "string" && body.profile.trim() !== "" ? body.profile : active;
  const { profile: _drop, ...patchObj } = body ?? {};
  // Secrets are never readable over LAN, so never writeable over LAN either —
  // drop them so a remote editor can change non-secret fields without the
  // prefilled (masked) token being applied back over the real one.
  if (!isLoopbackRequest(req)) {
    if (patchObj.endpoint && typeof patchObj.endpoint === "object")
      delete (patchObj.endpoint as { auth_token?: unknown }).auth_token;
    if (patchObj.ntfy && typeof patchObj.ntfy === "object")
      delete (patchObj.ntfy as { access_token?: unknown }).access_token;
  }
  const parsed = profilePatchSchema.safeParse(patchObj);
  if (!parsed.success) {
    return sendError(res, 400, "bad_request", "Profile patch is malformed", false);
  }
  if (!deps.profiles.getProfile(target)) {
    return sendError(res, 404, "profile_not_found", `No profile named "${target}"`, false);
  }
  const updated = deps.profiles.updateProfile(target, parsed.data as unknown as CreateProfileInput);
  // Same projection as GET /api/profile. Returning the updated Profile
  // verbatim handed back the unmasked endpoint.auth_token and
  // ntfy.access_token that the GET redacts, so a cross-origin POST could
  // read the LM Studio token straight out of the response.
  return sendJson(res, 200, { profile: editorProfileFor(updated, !isLoopbackRequest(req)), active });
}

// ---- profile lifecycle: switch / create / delete ----

const profileSwitchSchema = z.object({ name: z.string().min(1) });
const profileCreateSchema = z.object({
  name: z.string().min(1),
  endpoint_url: z.string().optional(),
  vram_gb: z.number().positive().optional(),
});
// Mirrors ProfileManager's own guard. Both layers exist on purpose: this one
// turns an attack into a clean 400, the storage one means no caller can
// reintroduce the traversal. Note the regex alone would accept
// "." and "..", so those are rejected explicitly.
const profileNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+$/,
    "Profile name may only contain letters, digits, '_', '.', '-'",
  )
  .refine((n) => n !== "." && n !== "..", "Profile name may not be a path segment");

const profileDeleteSchema = z.object({ name: profileNameSchema });

async function handleProfileSwitch(deps: ToolDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const parsed = profileSwitchSchema.safeParse(body);
  if (!parsed.success) return sendError(res, 400, "bad_request", "Body must be { name }", false);
  deps.profiles.switchProfile(parsed.data.name);
  return sendJson(res, 200, buildProfilesResponse(deps));
}

async function handleProfileCreate(deps: ToolDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const parsed = profileCreateSchema.safeParse(body);
  if (!parsed.success) return sendError(res, 400, "bad_request", "Body must be { name, endpoint_url?, vram_gb? }", false);
  const input: CreateProfileInput = {
    name: parsed.data.name,
    endpoint: { url: parsed.data.endpoint_url || "http://localhost:1234" },
  };
  if (typeof parsed.data.vram_gb === "number") input.machine_specs = { vram_gb: parsed.data.vram_gb };
  deps.profiles.createProfile(input);
  return sendJson(res, 200, buildProfilesResponse(deps));
}

async function handleProfileDelete(deps: ToolDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const parsed = profileDeleteSchema.safeParse(body);
  if (!parsed.success) return sendError(res, 400, "bad_request", "Body must be { name }", false);
  const name = parsed.data.name;
  if (name === activeProfileName(deps)) {
    return sendError(res, 400, "profile_active", "Cannot delete the active profile", false);
  }
  if (deps.profiles.listProfiles().length <= 1) {
    return sendError(res, 409, "last_profile", "Cannot delete the last remaining profile", false);
  }
  deps.profiles.deleteProfile(name);
  return sendJson(res, 200, buildProfilesResponse(deps));
}

// ---- dashboard (global) settings: Broadcast ----

const dashboardSchema = z.object({ broadcast: z.boolean() });

async function handleGetDashboard(deps: ToolDeps, bind: UiBind, res: ServerResponse): Promise<void> {
  const enabled = bind.host() === "0.0.0.0";
  const port = enabled ? bind.port() : configuredUiPort();
  return sendJson(res, 200, { broadcast: await projectionFor(enabled, bind.host(), port) });
}

/** Wait until a response body has been handed to the OS, so we can safely close sockets. */
function responseFlushed(res: ServerResponse): Promise<void> {
  if (res.writableFinished) return Promise.resolve();
  return new Promise((resolve) => res.once("finish", resolve));
}

async function handlePostDashboard(
  deps: ToolDeps,
  bind: UiBind,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(req);
  const parsed = dashboardSchema.safeParse(body);
  if (!parsed.success) return sendError(res, 400, "bad_request", "Body must be { broadcast: boolean }", false);

  writeDashboardSettings(deps.home, { broadcast: parsed.data.broadcast });
  const configured = configuredUiPort();
  const enabled = parsed.data.broadcast;
  const currentlyEnabled = bind.host() === "0.0.0.0";

  // No change needed: report the current live bind.
  if (enabled === currentlyEnabled) {
    const port = enabled ? bind.port() : configured;
    return sendJson(res, 200, { broadcast: await projectionFor(enabled, bind.host(), port), applies: "now" });
  }

  // Rebind the live listener. Enabling binds 0.0.0.0 on a free port so a LAN
  // device can reach it; disabling returns to 127.0.0.1 on the configured port.
  let projection: BroadcastProjection;
  let redirectTo: string;
  if (enabled) {
    const port = await findFreePort(configured);
    projection = await projectionFor(true, "0.0.0.0", port);
    // Always loopback, even when Broadcast just came on. A browser on this
    // machine that follows the LAN URL sends the LAN IP as its source
    // address, so it would be classified a LAN peer and lose mutation rights
    // — locking the user out of their own dashboard. The LAN URL stays in
    // `projection.url` for the phone.
    redirectTo = `http://127.0.0.1:${port}`;
  } else {
    projection = await projectionFor(false, "127.0.0.1", configured);
    redirectTo = `http://127.0.0.1:${configured}`;
  }

  // Send the response first and wait for it to flush, THEN close sockets and
  // relisten — otherwise the reply to this very request dies with the old bind.
  sendJson(res, 200, { broadcast: projection, applies: "now", redirectTo });
  await responseFlushed(res);
  await bind.rebind(enabled ? "0.0.0.0" : "127.0.0.1", projection.port);
}

// ---- SSE stream ----

function handleStream(deps: ToolDeps, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const profileName = activeProfileName(deps);
  if (!profileName) {
    res.write(": no active profile\n\n");
    res.end();
    return;
  }

  // Replay recent events on connect, then poll for newer ones. The replay is
  // recency-bounded (last 15 minutes) so stale history — old btw chats, past
  // model loads — never repaints into the live terminal. Polling is id-only but
  // resumes from the max pre-connect id, so rows older than the window (which
  // were NOT replayed) can never leak back through the first poll either.
  const replayCutoff = new Date(Date.now() - STREAM_REPLAY_WINDOW_MS).toISOString();
  const recent = deps.subAgentEvents.listSinceByTime(profileName, replayCutoff, 200);
  const preExistingMax = deps.subAgentEvents.maxId(profileName);
  const replayTail = recent.length ? (recent[recent.length - 1]!.id ?? 0) : 0;
  let lastId = Math.max(preExistingMax, replayTail);
  if (recent.length) res.write(`data: ${JSON.stringify({ events: recent })}\n\n`);

  const poll = setInterval(() => {
    const events = deps.subAgentEvents.listSince(profileName, lastId, 200);
    if (events.length) {
      lastId = events[events.length - 1]!.id ?? lastId;
      res.write(`data: ${JSON.stringify({ events })}\n\n`);
    }
  }, SSE_POLL_MS);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), SSE_HEARTBEAT_MS);

  const cleanup = (): void => {
    clearInterval(poll);
    clearInterval(heartbeat);
  };
  res.on("close", cleanup);
  req.on("aborted", cleanup);
}

// ---- /nanites-btw chat (btw-spec-v2 §8) ----

/**
 * GET /api/btw/state — the pollable chat snapshot. Token deltas don't come
 * through here: the held-chat turn's `chat.*` events already stream over
 * `/api/stream`, which Vox Terminus renders into the transcript live. This
 * endpoint just reconciles the transcript + status (what happened, not what is
 * happening). No instance ids are exposed (§6 of the project instructions).
 */
function handleBtwState(deps: ToolDeps, res: ServerResponse): void {
  const profileName = activeProfileName(deps);
  if (!profileName) return sendError(res, 404, "no_active_profile", "No active profile set", false);

  const chat = deps.btwChat.get(profileName);
  const summary = deps.contextCache.getSummary(profileName);
  sendJson(res, 200, {
    chat: chat
      ? {
          status: chat.status,
          job_id: chat.job_id,
          model_id: chat.model_id,
          last_activity_at: chat.last_activity_at,
          created_at: chat.created_at,
        }
      : null,
    messages: deps.btwChatMessages
      .list(profileName)
      .map((m) => ({ turn_index: m.turn_index, role: m.role, content: m.content })),
    compact: summary ? { summary: summary.summary, summary_tokens: summary.summary_tokens } : null,
  });
}

const btwMessageSchema = z.object({ content: z.string().min(1).max(4000) });

/**
 * POST /api/btw/message — append a user turn, run the held-instance chat (§7),
 * append the assistant turn, and return the reply. Streaming deltas for this
 * turn arrive over `/api/stream` (the workflow emits chat.start/content/end).
 */
async function handleBtwMessage(deps: ToolDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const profileName = activeProfileName(deps);
  if (!profileName) return sendError(res, 404, "no_active_profile", "No active profile set", false);

  const body = await readJsonBody(req);
  const parsed = btwMessageSchema.safeParse(body);
  if (!parsed.success) return sendError(res, 400, "bad_request", "Body must be { content: string }", false);

  try {
    const out = await runBtwChatMessage(deps, profileName, parsed.data.content);
    sendJson(res, 200, { reply: out.reply, model_id: out.model_id, reacquired: out.reacquired });
  } catch (err) {
    if (err instanceof NanitesError) {
      const status = err.retryable ? 503 : err.code === "btw_chat_not_found" || err.code === "no_model_for_role" ? 409 : 400;
      return sendError(res, status, err.code, err.message, err.retryable);
    }
    throw err;
  }
}

/**
 * POST /api/btw/clear — wipe this profile's /nanites-btw chat: the row and its
 * whole transcript are deleted so the chat cannot resurrect on a later restart.
 * The live event tables are untouched, so Vox Terminus drops straight back to
 * server logs. Idempotent — clearing a nonexistent chat still returns ok.
 */
function handleBtwClear(deps: ToolDeps, res: ServerResponse): void {
  const profileName = activeProfileName(deps);
  if (!profileName) return sendError(res, 404, "no_active_profile", "No active profile set", false);
  deps.btwChat.remove(profileName);
  const cleared = deps.btwChatMessages.deleteAll(profileName);
  sendJson(res, 200, { ok: true, cleared });
}

// ---- provider API ----

const VALID_PROVIDERS: ProviderKind[] = ["cloudflare", "openrouter", "omniroute", "generic"];

function validateProvider(p: string): ProviderKind {
  if (VALID_PROVIDERS.includes(p as ProviderKind)) return p as ProviderKind;
  throw Object.assign(new NanitesError({ code: "invalid_arguments", message: `Provider must be one of: ${VALID_PROVIDERS.join(", ")}. Got: ${p}`, retryable: false }), { httpStatus: 400 });
}

function providerDeps(deps: ToolDeps) {
  const profileName = activeProfileName(deps);
  if (!profileName) throw Object.assign(new NanitesError({ code: "no_active_profile", message: "No active profile set", retryable: false }), { httpStatus: 404 });
  return { profileName, keyStore: new ProviderKeyStore(deps.db), modelStore: new ProviderModelStore(deps.db), errorStore: new ProviderErrorStore(deps.db), stickyStore: new ProviderStickyStore(deps.db) };
}

async function handleProviderKeys(deps: ToolDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET" && req.method !== "POST") return sendError(res, 405, "method_not_allowed", "Only GET/POST", false);
  const { profileName, keyStore } = providerDeps(deps);
  const url = new URL(req.url ?? "/", "http://localhost");
  const provParam = url.searchParams.get("provider") ?? "";
  const prov = provParam ? validateProvider(provParam) : null;
  if (req.method === "GET") {
    const keys = prov !== null
      ? keyStore.listKeys(profileName, prov)
      : VALID_PROVIDERS.flatMap(p => keyStore.listKeys(profileName, p));
    return sendJson(res, 200, prov !== null
      ? { provider: prov, keys: keys.map(k => ({ key_id: k.key_id, provider: k.provider, account_id: k.account_id, gateway_url: k.gateway_url, nickname: k.nickname, is_enabled: k.is_enabled, is_exhausted: k.is_exhausted, exhausted_until: k.exhausted_until, consecutive_failures: k.consecutive_failures })) }
      : keys.map(k => ({ key_id: k.key_id, provider: k.provider, account_id: k.account_id, gateway_url: k.gateway_url, nickname: k.nickname, is_enabled: k.is_enabled, is_exhausted: k.is_exhausted, exhausted_until: k.exhausted_until, consecutive_failures: k.consecutive_failures })));
  }
  const body = (await readJsonBody(req)) as { provider?: string; api_key?: string; account_id?: string; gateway_url?: string; nickname?: string } | null;
  if (!body || typeof body.api_key !== "string") return sendError(res, 400, "bad_request", "Body must be { api_key: string, provider?: string, account_id?: string, gateway_url?: string, nickname?: string }", false);
  if (!body.provider) return sendError(res, 400, "bad_request", "provider required in body", false);
  const p = validateProvider(body.provider);
  const keyId = keyStore.addKey(profileName, p, body.api_key, { accountId: body.account_id, gatewayUrl: body.gateway_url, nickname: body.nickname });
  return sendJson(res, 200, { key_id: keyId, provider: p });
}

async function handleProviderKeyOp(deps: ToolDeps, req: IncomingMessage, res: ServerResponse, op: "remove" | "toggle"): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const provParam = url.searchParams.get("provider") ?? "";
  if (!provParam) return sendError(res, 400, "bad_request", "provider query param required", false);
  const prov = validateProvider(provParam);
  const keyId = url.searchParams.get("key_id") ?? "";
  const { profileName, keyStore } = providerDeps(deps);
  if (op === "remove") {
    if (!keyId) return sendError(res, 400, "bad_request", "key_id query param required", false);
    // removeKey returns void, so probe for existence first. Reporting success
    // for a no-op left the UI showing a deleted key that was still stored and
    // still spendable.
    const known = keyStore.listKeys(profileName, prov).some((k) => k.key_id === keyId);
    if (!known) return sendError(res, 404, "key_not_found", `No key "${keyId}" for ${prov}`, false);
    keyStore.removeKey(profileName, prov, keyId);
    return sendJson(res, 200, { key_id: keyId, provider: prov, removed: true });
  }
  const body = (await readJsonBody(req)) as { key_id?: string; is_enabled?: boolean; enabled?: boolean } | null;
  const targetKeyId = body?.key_id ?? keyId;
  const enabled = typeof body?.is_enabled === "boolean" ? body.is_enabled : typeof body?.enabled === "boolean" ? body.enabled : true;
  keyStore.setEnabled(profileName, prov, targetKeyId, enabled);
  return sendJson(res, 200, { key_id: targetKeyId, is_enabled: enabled });
}

async function handleProviderModels(deps: ToolDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const provParam = url.searchParams.get("provider") ?? "";
  const prov = provParam ? validateProvider(provParam) : null;
  const registeredOnly = url.searchParams.get("registered_only") === "1";
  const { profileName, modelStore, stickyStore } = providerDeps(deps);
  const models = prov !== null
    ? modelStore.listModels(profileName, prov, registeredOnly)
    : VALID_PROVIDERS.flatMap(p => modelStore.listModels(profileName, p, registeredOnly));
  const sticky = prov !== null ? stickyStore.getSticky(profileName, prov) : null;
  // Role badges come from the registry entry (single per-model role record,
  // one per model); `vision` additionally lights up from catalog capabilities even
  // before a registry entry exists.
  const enrich = (m: { model_id: string; name: string; nickname: string | null; owned_by: string | null; is_registered: boolean; context_window: number | null; provider?: string; capabilities?: { vision?: boolean } }) => {
    const entry = deps.registry.get(profileName, m.model_id);
    return {
      model_id: m.model_id,
      name: m.name,
      nickname: m.nickname,
      owned_by: m.owned_by,
      is_registered: m.is_registered,
      context_window: m.context_window,
      roles: entry?.roles ?? [],
      vision: m.capabilities?.vision === true,
      ...(m.provider ? { provider: m.provider } : {}),
    };
  };
  return sendJson(res, 200, prov !== null
    ? { provider: prov, sticky_model: sticky, models: models.map(enrich) }
    : models.map(enrich));
}

async function handleProviderModelOp(deps: ToolDeps, req: IncomingMessage, res: ServerResponse, op: "register" | "deregister"): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  // Every other provider route takes its arguments from a JSON body, and the
  // bulk "register selected" path in the dashboard posts a body. This handler
  // read only the query string, so every one of those registrations came back
  // 400 "provider query param required" while the manual path — which does
  // build a query string — kept working. Accept both so neither caller breaks.
  const body = (await readJsonBody(req)) as {
    provider?: string;
    model_id?: string;
    nickname?: string;
  } | null;
  const provParam = body?.provider ?? url.searchParams.get("provider") ?? "";
  if (!provParam) return sendError(res, 400, "bad_request", "provider required (body or query param)", false);
  const prov = validateProvider(provParam);
  const modelId = body?.model_id ?? url.searchParams.get("model_id") ?? "";
  if (!modelId) return sendError(res, 400, "bad_request", "model_id required (body or query param)", false);
  const { profileName, modelStore } = providerDeps(deps);
  if (op === "register") {
    const nickname = body?.nickname ?? url.searchParams.get("nickname") ?? undefined;
    modelStore.registerModel(profileName, prov, modelId, modelId, undefined, nickname);
    return sendJson(res, 200, { provider: prov, model_id: modelId, nickname: nickname ?? null });
  }
  modelStore.deregisterModel(profileName, prov, modelId);
  return sendJson(res, 200, { message: `${prov} model '${modelId}' deregistered` });
}

async function handleProviderErrors(deps: ToolDeps, url: URL, res: ServerResponse): Promise<void> {
  const { profileName, errorStore } = providerDeps(deps);
  const days = url.searchParams.get("days");
  let daysFilter: number | undefined;
  if (days === "today") daysFilter = 1;
  else if (days && /^\d+$/.test(days)) daysFilter = Math.min(5, Math.max(1, parseInt(days, 10)));
  const errors = errorStore.list(profileName, { days: daysFilter });
  return sendJson(res, 200, { errors: errors.map((e) => ({ id: e.id, provider: e.provider, model_id: e.model_id, error_code: e.error_code, error_message: e.error_message.slice(0, 200), http_status: e.http_status, retryable: e.retryable, retry_count: e.retry_count, created_at: e.created_at })) });
}

/**
 * Both fields are validated: preference_order against the shared provider
 * enum, and provider_enabled keys against the same list, so a typo cannot
 * silently create a prefs entry for a provider that does not exist.
 */
const providerConfigSchema = z.object({
  preference_order: providerPreferenceOrderSchema.optional(),
  provider_enabled: z
    .record(z.enum(PROVIDER_KINDS), z.object({ enabled: z.boolean() }))
    .optional(),
});

async function handleProviderConfig(deps: ToolDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "GET") {
    const { profileName } = providerDeps(deps);
    const profile = deps.profiles.getProfile(profileName);
    return sendJson(res, 200, { preference_order: profile?.provider_preference_order ?? ["cloudflare", "openrouter", "omniroute", "generic", "local"], providers: profile?.providers ?? {} });
  }
  // POST — update preference order or provider enabled flags.
  // This used to be a bare TS cast with no runtime validation. A body of
  // {"preference_order":"cloudflare"} (a string) then iterated character by
  // character, matched no provider, and resolveProvider returned null — so
  // every cloud delegation died silently while the route still replied
  // {ok:true}.
  const raw = await readJsonBody(req);
  const parsedBody = providerConfigSchema.safeParse(raw);
  if (!parsedBody.success) {
    return sendError(
      res,
      400,
      "bad_request",
      "Body must be { preference_order?: ProviderKind[]; provider_enabled?: Record<ProviderKind, { enabled: boolean }> }",
      false,
    );
  }
  const body = parsedBody.data;
  const { profileName } = providerDeps(deps);
  if (body?.preference_order) {
    deps.profiles.updateProfile(profileName, { name: profileName, provider_preference_order: body.preference_order });
  }
  if (body?.provider_enabled) {
    const profile = deps.profiles.getProfile(profileName);
    if (profile) {
      const updated = { ...profile.providers };
      for (const [k, v] of Object.entries(body.provider_enabled)) {
        if (!updated[k as ProviderKind]) updated[k as ProviderKind] = { enabled: true };
        updated[k as ProviderKind]!.enabled = v.enabled;
      }
      deps.profiles.updateProfile(profileName, { name: profileName, providers: updated });
    }
  }
  return sendJson(res, 200, { ok: true });
}

async function handleProviderDiscover(deps: ToolDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const provParam = url.searchParams.get('provider') ?? '';
  // The provider may arrive in the body (how the dashboard calls it) or the
  // query string. It used to read the query string only, so a per-provider
  // discover silently scanned every configured provider instead.
  const body = (await readJsonBody(req)) as { provider?: string } | null;
  const prov = (body?.provider ?? provParam) ? validateProvider(body?.provider ?? provParam) : null;
  const { profileName, keyStore, modelStore } = providerDeps(deps);
  const { createProviderClient, GenericClient } = await import('../providers/client.js');

  const providers = prov ? [prov] : VALID_PROVIDERS;
  const allModels: Array<{ id: string; name: string; owned_by: string | null; context_length: number | null; provider: string }> = [];

  for (const p of providers) {
    const keys = keyStore.availableKeys(profileName, p);
    if (keys.length === 0) continue;
    const key = keys[0]!;
    try {
      let result;
      if (p === 'cloudflare') {
        if (!key.account_id) continue;
        result = await createProviderClient('cloudflare').listModels(key.api_key, key.account_id);
      } else if (p === 'openrouter') {
        result = await createProviderClient('openrouter').listModels(key.api_key);
      } else if (p === 'omniroute') {
        // Per-key gateway_url wins; fall back to the default local proxy.
        const base = key.gateway_url ?? 'http://localhost:20128/v1';
        result = await createProviderClient('omniroute', base).listModels(key.api_key);
      } else {
        const base = key.gateway_url ?? 'http://localhost:8080/v1';
        result = await new GenericClient(base).listModels(key.api_key);
      }
      modelStore.upsertModels(profileName, p, result.models);
      const mapped = result.models.slice(0, 20).map((m) => ({ id: m.id, name: m.name ?? m.id, owned_by: m.owned_by ?? null, context_length: m.context_length ?? null, provider: p }));
      allModels.push(...mapped);
    } catch {
      // skip providers that fail
    }
  }

  if (allModels.length === 0) {
    return sendJson(res, 200, { discovered: 0, models: [], code: "no_keys_configured" });
  }
  return sendJson(res, 200, { discovered: allModels.length, models: allModels });
}

async function handleProviderPing(deps: ToolDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return sendError(res, 405, "method_not_allowed", "POST only", false);
  const body = (await readJsonBody(req)) as { url?: string; api_key?: string } | null;
  if (!body || typeof body.url !== "string") return sendError(res, 400, "bad_request", "{ url: string } required", false);
  // The caller supplies both the URL and a bearer token, so an unvalidated
  // url turns this route into a request forger against loopback, link-local
  // (cloud metadata at 169.254.169.254) and private ranges — reachable from
  // any LAN device once Broadcast is on.
  const checked = assertOutboundUrl(body.url);
  if (!checked.ok) return sendError(res, 400, "bad_request", checked.error, false);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (body.api_key) headers["Authorization"] = `Bearer ${body.api_key}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const fetchRes = await fetch(`${body.url}/models`, { headers, signal: controller.signal as AbortSignal });
    clearTimeout(timeout);
    if (fetchRes.ok) return sendJson(res, 200, { ok: true });
    return sendJson(res, 200, { ok: false, error: `HTTP ${fetchRes.status}` });
  } catch (e) {
    console.error("nanites ui: provider ping failed", e);
    const pub = publicErrorMessage(e);
    return sendJson(res, 200, { ok: false, code: pub.code, error: pub.message });
  }
}

async function handleProviderKeyTest(deps: ToolDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return sendError(res, 405, "method_not_allowed", "POST only", false);
  const { profileName, keyStore } = providerDeps(deps);
  const body = (await readJsonBody(req)) as { provider?: string; key_id?: string } | null;
  if (!body || typeof body.provider !== "string") {
    return sendError(res, 400, "bad_request", "{ provider, key_id? } required", false);
  }
  const p = validateProvider(body.provider);
  let keyId = body.key_id;
  let keyRecord;
  if (keyId) {
    keyRecord = keyStore.getKey(profileName, p, keyId);
  } else {
    const available = keyStore.availableKeys(profileName, p);
    if (available.length === 0) return sendJson(res, 200, { ok: false, error: "No available API key for this provider" });
    keyRecord = available[0];
    keyId = keyRecord!.key_id;
  }
  if (!keyRecord) return sendJson(res, 200, { ok: false, error: "API key not found" });
  if (p === "cloudflare" && !keyRecord.account_id) {
    return sendJson(res, 200, { ok: false, error: "Cloudflare keys require an account_id — fill it when saving the key" });
  }

  const { createProviderClient } = await import("../providers/client.js");
  const client = createProviderClient(p, keyRecord.gateway_url ?? undefined);
  const startedAt = Date.now();
  try {
    await client.listModels(keyRecord.api_key, keyRecord.account_id ?? undefined);
    const latencyMs = Date.now() - startedAt;
    return sendJson(res, 200, { ok: true, latency_ms: latencyMs });
  } catch (e) {
    console.error("nanites ui: provider key test failed", e);
    const pub = publicErrorMessage(e);
    return sendJson(res, 200, { ok: false, code: pub.code, error: pub.message });
  }
}

async function handleProviderKeyNickname(deps: ToolDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "PATCH") return sendError(res, 405, "method_not_allowed", "PATCH only", false);
  const { profileName, keyStore } = providerDeps(deps);
  const body = (await readJsonBody(req)) as { provider?: string; key_id?: string; nickname?: string } | null;
  if (!body || typeof body.provider !== "string" || typeof body.key_id !== "string") {
    return sendError(res, 400, "bad_request", "{ provider, key_id, nickname } required", false);
  }
  const p = validateProvider(body.provider);
  keyStore.setNickname(profileName, p, body.key_id, body.nickname ?? null);
  return sendJson(res, 200, { key_id: body.key_id, nickname: body.nickname ?? null });
}

async function handleProviderModelNickname(deps: ToolDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "PATCH") return sendError(res, 405, "method_not_allowed", "PATCH only", false);
  const { profileName, modelStore } = providerDeps(deps);
  const body = (await readJsonBody(req)) as { provider?: string; model_id?: string; nickname?: string } | null;
  if (!body || typeof body.provider !== "string" || typeof body.model_id !== "string") {
    return sendError(res, 400, "bad_request", "{ provider, model_id, nickname } required", false);
  }
  const p = validateProvider(body.provider);
  modelStore.setNickname(profileName, p, body.model_id, body.nickname ?? null);
  return sendJson(res, 200, { model_id: body.model_id, nickname: body.nickname ?? null });
}

async function handleProviderModelTest(deps: ToolDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return sendError(res, 405, "method_not_allowed", "POST only", false);
  const { profileName, keyStore } = providerDeps(deps);
  const body = (await readJsonBody(req)) as { provider?: string; model_id?: string } | null;
  if (!body || typeof body.provider !== "string" || typeof body.model_id !== "string") {
    return sendError(res, 400, "bad_request", "{ provider, model_id } required", false);
  }
  const p = validateProvider(body.provider);
  const keys = keyStore.availableKeys(profileName, p);
  if (keys.length === 0) return sendJson(res, 200, { ok: false, error: "No available API key for this provider" });
  const key = keys[0]!;
  if (p === "cloudflare" && !key.account_id) {
    return sendJson(res, 200, { ok: false, error: "Cloudflare keys require an account_id — fill it when saving the key" });
  }
  const { createProviderClient } = await import("../providers/client.js");
  const client = createProviderClient(p, key.gateway_url ?? undefined);
  const chatReq = {
    model: body.model_id,
    messages: [{ role: "user" as const, content: "What is 2+2? Reply with just the number." }],
    // Reasoning models (Cloudflare glm-4.7-flash, OpenRouter nemotron, ...)
    // spend output tokens on reasoning first — a 20-token cap cuts them off
    // with empty content. Keep a real budget.
    max_tokens: 300,
    temperature: 0.1,
  };
  const startedAt = Date.now();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Free-tier models (OpenRouter `:free`) hit shared upstream pools that 429
  // intermittently, and OpenRouter occasionally answers a 200 with an empty
  // message {}. Both are transient — a couple of bounded retries ride through.
  const ATTEMPTS = 3;
  let lastError: string = "unknown error";
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(400 * attempt);
    try {
      const resp = await client.chat(chatReq, key.api_key, key.account_id ?? undefined, key.gateway_url ?? undefined);
      const content = (resp.content ?? "").trim();
      const reasoning = (resp.reasoning_content ?? resp.reasoning ?? "").trim();
      const hasOutput = content.length > 0 || reasoning.length > 0;
      if (!hasOutput) {
        lastError = "Model returned an empty response";
        continue; // empty-200 anomaly — retry
      }
      const latencyMs = Date.now() - startedAt;
      if (!content) {
        // Reasoning-only completion (model produced a thinking turn, no final
        // content). Still proof of life — surface the tail of the reasoning.
        const snippet = reasoning.slice(-200);
        return sendJson(res, 200, { ok: true, content: snippet || "ok", note: "reasoning_only", latency_ms: latencyMs });
      }
      return sendJson(res, 200, { ok: true, content, latency_ms: latencyMs });
    } catch (e) {
      const retryable = e instanceof NanitesError ? e.retryable : false;
      lastError = publicErrorMessage(e).message;
      if (!retryable) break; // auth/model errors are not transient
    }
  }
  return sendJson(res, 200, { ok: false, error: lastError });
}

// ---- role pins + role vocabulary ----

/** GET list / POST set / DELETE ?role= remove — one pin per role per profile. */
async function handlePins(deps: ToolDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const profileName = activeProfileName(deps);
  if (!profileName) return sendError(res, 404, "no_active_profile", "No active profile set", false);
  const store = new RolePinStore(deps.db);
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET") {
    return sendJson(res, 200, {
      profile: profileName,
      pins: store.list(profileName).map((p) => ({ role: p.role, provider: p.provider, model_id: p.model_id, updated_at: p.updated_at ?? null })),
    });
  }
  if (req.method === "DELETE") {
    const role = url.searchParams.get("role") ?? "";
    if (!role) return sendError(res, 400, "bad_request", "DELETE /api/pins?role=<role> required", false);
    return sendJson(res, 200, { role, removed: store.remove(profileName, role) });
  }
  if (req.method !== "POST") return sendError(res, 405, "method_not_allowed", "Only GET/POST/DELETE", false);

  const body = (await readJsonBody(req)) as { role?: unknown; provider?: unknown; model_id?: unknown } | null;
  if (!body || typeof body.role !== "string" || !body.role.trim() || typeof body.provider !== "string" || typeof body.model_id !== "string" || !body.model_id.trim()) {
    return sendError(res, 400, "bad_request", "Body must be { role, provider, model_id }", false);
  }
  const role = body.role.trim();
  const modelId = body.model_id.trim();
  // RolePinStore rejects a provider outside PIN_PROVIDERS (invalid_arguments ->
  // 400 via the router catch).
  const replaced = store.get(profileName, role) !== null;
  store.set(profileName, { role, provider: body.provider, model_id: modelId });
  return sendJson(res, 200, { role, provider: body.provider, model_id: modelId, replaced });
}

/**
 * GET /api/roles — the dashboard role-vocabulary surface: built-in roles
 * (eleven, incl. `vision`) plus any custom role from registered test units.
 * `roles` carries a row count per role from the merged model universe so the
 * UI can size its dynamic tabs.
 */
function handleRoles(deps: ToolDeps, res: ServerResponse): void {
  const profileName = activeProfileName(deps);
  if (!profileName) return sendError(res, 404, "no_active_profile", "No active profile set", false);

  const builtin = [...BUILT_IN_ROLES];
  const customSet = new Set<string>();
  for (const unit of deps.testUnits.list(profileName)) {
    for (const role of unit.applicable_roles) {
      if (!builtin.includes(role)) customSet.add(role);
    }
  }
  const custom = [...customSet].sort();

  const counts = new Map<string, number>();
  const bump = (role: string): void => { counts.set(role, (counts.get(role) ?? 0) + 1); };
  for (const e of deps.registry.list(profileName)) {
    for (const role of e.roles ?? []) bump(role);
  }
  // Untested registered vision-capable cloud models count toward `vision`,
  // mirroring the leaderboard merge so tab counts match the rows.
  const registeredIds = new Set(deps.registry.list(profileName).map((e) => e.model_id));
  for (const m of new ProviderModelStore(deps.db).listModels(profileName, undefined, true)) {
    if (registeredIds.has(m.model_id)) continue;
    if (m.capabilities.vision === true) bump("vision");
  }

  const roles = [...counts.keys()]
    .sort()
    .map((role) => ({ role, kind: builtin.includes(role) ? "builtin" : "custom", count: counts.get(role)! }));
  sendJson(res, 200, { profile: profileName, builtin, custom, roles });
}

// ---- router ----

export type UiHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function createUiHandler(deps: ToolDeps, bind: UiBind, opts: { diskAvailableGb?: number } = {}): UiHandler {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    // Guards run before the try block, so they precede every dispatch and no
    // response has been written yet. Host closes DNS rebinding;
    // Origin closes cross-site mutation. Both read bind.port() live, because
    // the Broadcast toggle rebinds to an ephemeral port.
    const guardOpts = { port: bind.port(), lanHosts: bind.lanHosts() };
    if (!isAllowedHostHeader(req.headers.host, guardOpts)) {
      return sendError(res, 403, "forbidden_host", "Host header not allowed", false);
    }
    const mutating = req.method !== "GET" && req.method !== "HEAD";
    if (mutating && !isAllowedOrigin(req.headers.origin, guardOpts)) {
      return sendError(res, 403, "forbidden_origin", "Origin not allowed", false);
    }
    if (mutating && !requireMutatorAccess(req, res, url, bind)) return;

    try {
      if (req.method === "GET" && (p === "/" || p === "/index.html")) return sendHtml(res, loadIndexHtml());
      // Logos and hover-skull frames are separate files next to the built HTML.
      if (req.method === "GET" && sendUiAsset(res, p)) return;
      if (req.method === "GET" && p === "/api/stream") return handleStream(deps, req, res);
      if (req.method === "GET" && p === "/api/leaderboard") return handleLeaderboard(deps, url, res);
      if (req.method === "GET" && p === "/api/ledger") return handleLedger(deps, url, res);
      if (req.method === "GET" && p === "/api/health") return await handleHealth(deps, req, res, opts.diskAvailableGb);
      if (req.method === "GET" && p === "/api/btw/state") return handleBtwState(deps, res);
      if (req.method === "POST" && p === "/api/btw/message") return await handleBtwMessage(deps, req, res);
      if (req.method === "POST" && p === "/api/btw/clear") return handleBtwClear(deps, res);
      if (req.method === "GET" && p === "/api/profiles") return handleProfiles(deps, res);
      if (req.method === "GET" && p === "/api/profile") return handleProfile(deps, url, req, res);
      if (req.method === "POST" && p === "/api/settings/wipe") return await handleWipe(deps, req, res);
      if (req.method === "POST" && p === "/api/settings/profile") return await handleSettingsProfile(deps, req, res);
      if (req.method === "POST" && p === "/api/settings/profile/switch") return await handleProfileSwitch(deps, req, res);
      if (req.method === "POST" && p === "/api/settings/profile/create") return await handleProfileCreate(deps, req, res);
      if (req.method === "POST" && p === "/api/settings/profile/delete") return await handleProfileDelete(deps, req, res);
      if (req.method === "GET" && p === "/api/settings/dashboard") return await handleGetDashboard(deps, bind, res);
      if (req.method === "POST" && p === "/api/settings/dashboard") return await handlePostDashboard(deps, bind, req, res);
      // The helper toggle, for the Settings panel. Same path as the MCP tool
      // (`nanites_toggleHelpers`) and the same shared database, so the three
      // surfaces cannot drift.
      // Identity probe. The dashboard launcher compares this against its own
      // repository root to decide whether the process already on the port is
      // THIS build or a leftover from another checkout. Without it the
      // launcher defers to any Nanites-shaped response, which is how a stale
      // dashboard kept the port and served a preview with missing routes.
      if (req.method === "GET" && p === "/api/instance") {
        return sendJson(res, 200, {
          name: "nanites-dashboard",
          // Forward slashes, so the comparison is not defeated by Windows
          // path separators differing between the two processes.
          root: instanceRoot(),
          version: 1,
        });
      }
      if (req.method === "GET" && p === "/api/router/config") return handleGetHelperConfig(deps, res);
      if (req.method === "POST" && p === "/api/router/config") return await handlePostHelperConfig(deps, req, res);
      if (req.method === "GET" && p === "/api/router/status") return handleGetRouterStatus(deps, res);
      // READS go through the proxy too. The browser calling the router
      // directly is a cross-origin request to a different port, which fails
      // the preflight -- and even if it did not, it would need the virtual
      // key in the page. Same reason as the writes.
      if (req.method === "GET" && (p === "/api/router/read" || p === "/api/router/read/")) {
        return await handleRouterRead(deps, res);
      }
      // Everything the Router tab mutates goes through the dashboard, which
      // holds the router's virtual key. The browser must never see that key --
      // it is the only thing between a public tunnel and real provider spend,
      // and a dashboard is not the place a secret lives.
      if (p === "/api/router/proxy") {
        return await handleRouterProxy(deps, req, res);
      }
      // ---- providers ----
      if (req.method === "GET" && p === "/api/pins") return await handlePins(deps, req, res);
      if (req.method === "POST" && p === "/api/pins") return await handlePins(deps, req, res);
      if (req.method === "DELETE" && p === "/api/pins") return await handlePins(deps, req, res);
      if (req.method === "GET" && p === "/api/roles") return handleRoles(deps, res);
      if ((req.method === "GET" || req.method === "POST") && p === "/api/providers/keys") return await handleProviderKeys(deps, req, res);
      if (req.method === "DELETE" && p === "/api/providers/keys") return await handleProviderKeyOp(deps, req, res, "remove");
      if (req.method === "PATCH" && p === "/api/providers/keys") return await handleProviderKeyOp(deps, req, res, "toggle");
      if (req.method === "GET" && p === "/api/providers/models") return await handleProviderModels(deps, req, res);
      if (req.method === "POST" && p === "/api/providers/models/register") return await handleProviderModelOp(deps, req, res, "register");
      if (req.method === "DELETE" && p === "/api/providers/models") return await handleProviderModelOp(deps, req, res, "deregister");
      if (req.method === "GET" && p === "/api/providers/errors") return await handleProviderErrors(deps, url, res);
      if (req.method === "GET" && p === "/api/providers/config") return await handleProviderConfig(deps, req, res);
      if (req.method === "POST" && p === "/api/providers/config") return await handleProviderConfig(deps, req, res);
      if (req.method === "POST" && p === "/api/providers/discover") return await handleProviderDiscover(deps, req, res);
      if (req.method === "POST" && p === "/api/providers/ping") return await handleProviderPing(deps, req, res);
      if (req.method === "POST" && p === "/api/providers/keys/test") return await handleProviderKeyTest(deps, req, res);
      if (req.method === "POST" && p === "/api/providers/models/test") return await handleProviderModelTest(deps, req, res);
      if (req.method === "PATCH" && p === "/api/providers/keys/nickname") return await handleProviderKeyNickname(deps, req, res);
      if (req.method === "PATCH" && p === "/api/providers/models/nickname") return await handleProviderModelNickname(deps, req, res);
      return sendError(res, 404, "not_found", `No route for ${req.method} ${p}`, false);
    } catch (err) {
      if (err instanceof NanitesError) {
        // Domain errors (invalid override, duplicate name, ...) are client
        // faults, not server faults: non-retryable -> 400, retryable -> 503.
        if (!res.headersSent) sendError(res, err.retryable ? 503 : 400, err.code, err.message, err.retryable);
        else res.end();
        return;
      }
      // Never echo err.message: Node fs and sqlite errors carry absolute
      // paths and machine names. The stack goes to the terminal,
      // never to a caller — and under Broadcast, never to the LAN.
      console.error("nanites ui: unhandled handler error", err);
      if (!res.headersSent) sendError(res, 500, "internal_error", "Internal error", false);
      else res.end();
    }
  };
}

/**
 * Hostnames accepted over the LAN while Broadcast is on. Resolves the
 * default-route source address (the same one the broadcast URL uses) and
 * falls back to an interface scan. Returns an empty list when the machine is
 * offline, so LAN access fails closed rather than open.
 */
async function resolveLanHosts(): Promise<string[]> {
  const ip = await lanIPv4();
  return ip ? [ip] : [];
}

export async function startUiServer(deps: ToolDeps, opts: UiServerOptions = {}): Promise<UiServer> {
  const requestedPort = opts.port ?? Number(process.env.NANITES_UI_PORT ?? process.env.PORT ?? DEFAULT_UI_PORT);
  let host = opts.host ?? "127.0.0.1";
  let port = requestedPort;

  // The bind handle lets the Broadcast toggle relisten live; `server` is only
  // referenced lazily (inside rebind), so declare it before it is assigned below.
  let server: Server;
  const lanToken = newLanToken();
  let lanHosts: string[] = [];
  const bind: UiBind = {
    host: () => host,
    port: () => port,
    lanHosts: () => lanHosts,
    lanToken: () => lanToken,
    async rebind(nextHost: string, nextPort: number): Promise<void> {
      await relisten(server, nextHost, nextPort);
      host = nextHost;
      port = nextPort;
      // Re-resolve the LAN allowlist. Switching Broadcast off must withdraw
      // LAN access immediately, not at the next restart.
      lanHosts = nextHost === "0.0.0.0" ? await resolveLanHosts() : [];
    },
  };

  const handler = createUiHandler(deps, bind, { diskAvailableGb: opts.diskAvailableGb });
  server = createServer((req, res) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) sendError(res, 500, "internal_error", "Unexpected server error", false);
      else res.end();
    });
  });

  // Broadcast is a global dashboard setting: when on (and the caller didn't pin a
  // host), bind 0.0.0.0 on a free port so a LAN device can reach the dashboard.
  if (readDashboardSettings(deps.home).broadcast && opts.host === undefined) {
    host = "0.0.0.0";
    port = await findFreePort(requestedPort);
    lanHosts = await resolveLanHosts();
  }
  await listenOn(server, host, port);

  const address = server.address() as AddressInfo;
  // With port 0 the OS chose the port, so the closure still holds the
  // requested value (0). Sync it before any request arrives: the Host guard
  // compares the request port against bind.port(), and a stale 0 there would
  // 403 every request.
  port = address.port;

  return {
    server,
    host,
    port: address.port,
    ...(host === "0.0.0.0" ? { lanToken } : {}),
    lanHosts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * GET /api/router/config — the helper feature flags and their evidence.
 *
 * A separate path from /api/settings/dashboard because these are ROUTER
 * settings, not dashboard settings, and the dashboard has no business being
 * the only way to read them.
 */
function handleGetHelperConfig(deps: ToolDeps, res: ServerResponse): void {
  try {
    sendJson(res, 200, readHelperState(deps.db));
  } catch (err) {
    sendError(res, 500, "internal", err instanceof Error ? err.message : String(err), false);
  }
}

/**
 * POST /api/router/config — flip the master switch or one feature.
 *
 * VALIDATED here rather than trusted from the browser: the same whitelist the
 * MCP tool uses, so a hand-typed field name is rejected instead of silently
 * writing a column that does nothing.
 */
async function handlePostHelperConfig(deps: ToolDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const parsed = helperConfigSchema.safeParse(body);
  if (!parsed.success) {
    return sendError(res, 400, "bad_request", "Body must be { enable?: boolean, features?: Record<string, boolean> }", false);
  }
  try {
    const result = applyHelperToggle(deps.db, {
      enable: parsed.data.enable,
      features: parsed.data.features,
    });
    sendJson(res, 200, result);
  } catch (err) {
    const code = (err as { code?: string }).code ?? "internal";
    const status = code === "invalid_arguments" ? 400 : 500;
    sendError(res, status, code, err instanceof Error ? err.message : String(err), false);
  }
}

const helperConfigSchema = z.object({
  enable: z.boolean().optional(),
  features: z.record(z.string(), z.boolean()).optional(),
});

/**
 * GET /api/router/status — the Router tab's whole data source.
 *
 * Read from the SHARED DATABASE rather than by calling the router's HTTP API,
 * so the tab still renders when the router is not running — which is the most
 * interesting state to look at, and the state a live call would fail on.
 * `running` is therefore an explicit field: the tab shows configuration and
 * key inventory offline, and says plainly that the process is down.
 */
function handleGetRouterStatus(deps: ToolDeps, res: ServerResponse): void {
  const cfg = readConfig(deps.db);
  // One implementation, shared with GET /v1/keys. These were two queries that
  // disagreed: this one filtered is_enabled, that one did not, so the same
  // database reported a different key count in each tab.
  const keys = providerKeyCounts(deps.db);
  const models = providerModelCounts(deps.db);
  const count = (sql: string): number => routerTableCount(deps.db, sql);
  sendJson(res, 200, {
    // False rather than omitted: the tab must not assume the process is up.
    running: false,
    configured: Boolean(cfg),
    port: cfg ? Number(cfg.port) : 4800,
    bind: cfg ? String(cfg.bind) : "127.0.0.1",
    key_present: Boolean(cfg?.virtual_key_hash),
    default_strategy: cfg?.default_strategy ?? null,
    budget_threshold: cfg ? Number(cfg.budget_threshold) : null,
    tunnel_enabled: Boolean(cfg?.tunnel_enabled),
    providers: keys,
    registered_models: models,
    advertised: count("SELECT COUNT(*) AS n FROM router_advertised"),
    aliases: count("SELECT COUNT(*) AS n FROM router_aliases"),
    jobs: {
      total: count("SELECT COUNT(*) AS n FROM router_jobs"),
      running: count("SELECT COUNT(*) AS n FROM router_jobs WHERE status = 'running'"),
      failed: count("SELECT COUNT(*) AS n FROM router_jobs WHERE status = 'failed'"),
    },
    helpers: readHelperState(deps.db),
  });
}

/**
 * The repository this dashboard is serving from.
 *
 * Resolved from the location of the BUILT server file, not from an env var or
 * a config row: those can be inherited from another process and would report a
 * root that is not the code actually running.
 */
function instanceRoot(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..")
    .split(path.sep).join("/");
}

/**
 * Proxy a mutating router call, holding the virtual key server-side.
 *
 * The router authenticates on `Authorization: Bearer <virtual key>`, and the
 * dashboard has no copy of it: the key is stored HASHED and was printed once at
 * boot. So the tab cannot call the router directly, and this is the only way
 * to change aliases or broadcast state from the UI.
 *
 * `target` is validated against an ALLOWLIST of router paths. A proxy that
 * forwards an arbitrary path with a server-held credential is a confused-deputy
 * waiting to happen, and the browser controls `target`.
 */
async function handleRouterProxy(deps: ToolDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req).catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return sendError(res, 400, "bad_request", "Body must be a JSON object", false);
  }
  const target = typeof body["target"] === "string" ? body["target"] : "";
  const ALLOWED = ["/v1/aliases", "/v1/broadcast", "/v1/tunnel"];
  if (!ALLOWED.some((a) => target === a || target.startsWith(`${a}/`))) {
    return sendError(res, 400, "bad_request", `target must be one of: ${ALLOWED.join(", ")}`, false);
  }

  const cfg = readConfig(deps.db);
  const port = cfg ? Number(cfg.port) : 4800;
  const host = cfg ? String(cfg.bind) : "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost") {
    return sendError(res, 400, "bad_request", `router is bound to ${host}; the dashboard only proxies loopback`, false);
  }

  // The key, if one was supplied at start-up. Without it the proxy cannot
  // authenticate, and saying so beats a confusing 401 from the router.
  const key = process.env["NANITES_ROUTER_KEY"];
  if (!key) {
    return sendError(res, 503, "no_router_key",
      "Set NANITES_ROUTER_KEY in the environment so the dashboard can talk to the router. The key is never stored, only hashed.", false);
  }

  try {
    const upstream = await fetch(`http://127.0.0.1:${port}${target}`, {
      method: req.method,
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body["payload"] ?? {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8" });
    res.end(text);
  } catch (err) {
    sendError(res, 502, "router_unreachable",
      `Could not reach the router on port ${port}: ${err instanceof Error ? err.message : String(err)}`, false);
  }
}

/**
 * Read-only router fetch for the dashboard tab: aliases and broadcast state.
 *
 * Same reasoning as the mutating proxy -- the browser has no virtual key and
 * the router is on a different port, so it cannot call it directly. The target
 * allowlist applies here too.
 */
async function handleRouterRead(deps: ToolDeps, res: ServerResponse): Promise<void> {
  const key = process.env["NANITES_ROUTER_KEY"];
  const cfg = readConfig(deps.db);
  const port = cfg ? Number(cfg.port) : 4800;
  const GETTABLE = ["/v1/aliases", "/v1/broadcast"];
  const out: Record<string, unknown> = {};
  if (!key) {
    return sendJson(res, 200, {
      error: "Set NANITES_ROUTER_KEY in the environment so the dashboard can talk to the router.",
      aliases: { data: [] },
      broadcast: { models: [], advertised: [] },
    });
  }
  for (const target of GETTABLE) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${target}`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(8000),
      });
      out[target === "/v1/aliases" ? "aliases" : "broadcast"] = await r.json();
    } catch (err) {
      out[target === "/v1/aliases" ? "aliases" : "broadcast"] = {
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  sendJson(res, 200, out);
}
