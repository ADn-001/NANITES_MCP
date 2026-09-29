/**
 * Opt-in request logging, for collecting real traffic to train a classifier on.
 *
 * ## Why this exists
 *
 * The router had no inbound request log at all, so "collect real data" was not
 * something you could switch on — it was a thing that had to be built. The
 * export is deliberately a SINGLE self-contained file, because the intended use
 * is: let the router collect for a few days, email yourself the file, drag it
 * into an offline labeling app. Anything that required a database dump would
 * make that workflow a chore and would drag unrelated state along with it.
 *
 * ## Redaction is a default, not a promise
 *
 * A request log is exactly where a user pastes a credential by accident. The
 * patterns below catch the common shapes — bearer tokens, provider keys, JWTs,
 * private keys, account ids, `password=` pairs. That is a filter, not a
 * guarantee: a novel secret format will pass through. So the log is OFF by
 * default, the setting is a per-install choice, and the export carries the
 * redaction patterns it ran, so a reader can see what was and was not filtered.
 *
 * This is the honest position: cheap protection, clearly bounded, and stated.
 */
import type { DatabaseSync } from "node:sqlite";
import { readConfig, ensureConfigRow } from "./auth.js";
import { nowIso } from "../storage/db.js";
import type { IRRequest } from "./ir/types.js";

export interface TrafficRecord {
  created_at: string;
  model: string | null;
  provider: string | null;
  dialect: string | null;
  status: number | null;
  latency_ms: number | null;
  last_user: string | null;
  system_head: string | null;
  tool_names: string | null;
  n_messages: number | null;
  n_tools: number | null;
  has_media: number;
  stream: number;
  error_code: string | null;
}

/**
 * Patterns replaced before anything is written to disk.
 *
 * Ordered most-specific first, because a generic rule can otherwise eat the
 * informative part of a message. Each is applied globally over the text, which
 * is the right trade: a partial redaction inside a log is worse than a blunt
 * one, because it looks safe.
 */
export const REDACTION_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "private_key", re: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g },
  // MOST SPECIFIC FIRST. `sk-ant-...` and `sk-or-v1-...` both also match the
  // generic `sk-` pattern below, so listing the generic one first swallowed
  // every Anthropic and OpenRouter key and their specific patterns never
  // fired. Caught by a test asserting the hit NAME, not merely that the
  // secret disappeared — a redactor that removes a key with the wrong label
  // still leaves the export's audit trail wrong.
  { name: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openrouter_key", re: /\bsk-or-v1-[A-Za-z0-9]{20,}/g },
  { name: "openai_key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: "google_key", re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { name: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: "huggingface_token", re: /\bhf_[A-Za-z0-9]{30,}/g },
  { name: "kaggle_token", re: /\bKGAT_[A-Za-z0-9]{20,}/g },
  { name: "aws_access_key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: "bearer_header", re: /(?:bearer|authorization\s*:\s*)\s*[A-Za-z0-9._~+/-]{16,}=*/gi },
  // key=value / "key": "value" where the KEY looks secret.
  { name: "assigned_secret", re: /((?:api[_-]?key|secret|password|passwd|token|access[_-]?key|private[_-]?key|client[_-]?secret)\s*[=:]\s*["']?)([^\s"',;]{8,})/gi },
  // 32-char hex: covers Cloudflare account ids, and is lossy on purpose.
  { name: "hex32", re: /\b[0-9a-f]{32}\b/gi },
];

/** Replace every pattern, returning the text and what fired. */
export function redact(text: string): { text: string; hits: string[] } {
  const hits = new Set<string>();
  let out = text;
  for (const { name, re } of REDACTION_PATTERNS) {
    // A fresh RegExp each pass: these are /g, and a shared lastIndex across
    // calls silently skips matches after the first one.
    const pattern = new RegExp(re.source, re.flags);
    if (pattern.test(out)) hits.add(name);
    out = out.replace(pattern, `[REDACTED:${name}]`);
  }
  return { text: out, hits: [...hits] };
}

function configOf(db: DatabaseSync): { enabled: boolean; maxChars: number } {
  try {
    const c = readConfig(db) as unknown as Record<string, unknown> | null;
    return {
      // Off unless explicitly turned on. A missing column is also off, so an
      // older database cannot accidentally start logging.
      enabled: Number(c?.traffic_log_enabled ?? 0) === 1,
      maxChars: Math.max(200, Math.min(Number(c?.traffic_log_max_chars ?? 4000) || 4000, 100_000)),
    };
  } catch {
    return { enabled: false, maxChars: 4000 };
  }
}

export function trafficLogEnabled(db: DatabaseSync): boolean {
  return configOf(db).enabled;
}

/** Turn logging on or off, and set the per-record character cap. */
export function setTrafficLog(db: DatabaseSync, enabled: boolean, maxChars?: number): void {
  // A FRESH home has zero rows in router_config -- migrations create the
  // TABLE, not a row. Every `UPDATE ... WHERE id = 1` then matches nothing and
  // silently does nothing, so enabling logging on a new install appeared to
  // work and recorded nothing. Verified: a virgin home had 0 config rows and
  // the flag stayed unset.
  ensureConfigRow(db);
  if (maxChars !== undefined) {
    const n = Math.max(200, Math.min(Math.round(maxChars), 100_000));
    db.prepare("UPDATE router_config SET traffic_log_enabled = ?, traffic_log_max_chars = ?, updated_at = ? WHERE id = 1")
      .run(enabled ? 1 : 0, n, nowIso());
    return;
  }
  db.prepare("UPDATE router_config SET traffic_log_enabled = ?, updated_at = ? WHERE id = 1")
    .run(enabled ? 1 : 0, nowIso());
}

export interface LogInput {
  request: IRRequest;
  provider: string | null;
  dialect: string;
  status: number;
  latencyMs: number;
  errorCode?: string;
}

/**
 * Write one record. NEVER throws.
 *
 * This runs on the request path after a provider call. A logging failure there
 * would turn a completed, billed request into an error, which is the worst
 * possible trade for a diagnostic.
 */
export function logRequest(db: DatabaseSync, input: LogInput): void {
  const cfg = configOf(db);
  if (!cfg.enabled) return;
  try {
    const { request, provider, dialect, status, latencyMs, errorCode } = input;
    const lastUser = lastUserText(request);
    const { text: lastUserSafe } = redact(truncate(lastUser, cfg.maxChars));
    const { text: systemSafe } = redact(truncate(request.system ?? "", 600));
    const hasMedia = request.messages.some((m) =>
      typeof m.content !== "string" && m.content.some((p) => p.type !== "text"));

    db.prepare(`
      INSERT INTO router_traffic
        (created_at, model, provider, dialect, status, latency_ms, last_user,
         system_head, tool_names, n_messages, n_tools, has_media, stream, error_code)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      nowIso(),
      request.model ?? null,
      provider,
      dialect,
      status,
      latencyMs,
      lastUserSafe || null,
      systemSafe || null,
      JSON.stringify((request.tools ?? []).map((t) => t.name)),
      request.messages.length,
      (request.tools ?? []).length,
      hasMedia ? 1 : 0,
      request.stream ? 1 : 0,
      errorCode ?? null,
    );
  } catch {
    // A log write that fails is not a request failure.
  }
}

function lastUserText(request: IRRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const m = request.messages[i]!;
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    return m.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  // Keep the head: an instruction override ("ignore everything above...") is
  // at the START of a message, so tail-truncating would drop exactly the part
  // a prompt-injection classifier needs.
  return `${text.slice(0, max)}\n[truncated ${text.length - max} chars]`;
}

export interface ExportOptions {
  since?: string;
  until?: string;
  limit?: number;
}

/**
 * Export as a self-contained JSON file.
 *
 * Carries the redaction patterns that ran, so a downstream reader can see what
 * was filtered rather than having to trust that it was.
 */
export function exportTraffic(
  db: DatabaseSync,
  opts: ExportOptions = {},
): { filename: string; content: string } {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (opts.since) { where.push("created_at >= ?"); params.push(opts.since); }
  if (opts.until) { where.push("created_at <= ?"); params.push(opts.until); }
  const sql = `SELECT * FROM router_traffic
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY id DESC LIMIT ?`;
  params.push(Math.max(1, Math.min(opts.limit ?? 100_000, 1_000_000)));

  const rows = db.prepare(sql).all(...params) as unknown as TrafficRecord[];

  const payload = {
    format: "nanites-router-traffic-log",
    version: 1,
    exported_at: nowIso(),
    note:
      "Collected by an opt-in request log. Credential-shaped strings were replaced " +
      "before writing; see redaction.applied for the pattern set. This is a filter, " +
      "not a guarantee -- review before publishing.",
    count: rows.length,
    redaction: {
      applied: REDACTION_PATTERNS.map((p) => p.name),
      guarantee: "best-effort pattern filter, not a proven scrubber",
    },
    records: rows,
  };

  const stamp = nowIso().replace(/[:.]/g, "-").slice(0, 19);
  return {
    filename: `nanites-traffic-${stamp}.json`,
    content: `${JSON.stringify(payload, null, 2)}\n`,
  };
}

export function trafficStats(db: DatabaseSync): { total: number; enabled: boolean; maxChars: number } {
  const cfg = configOf(db);
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM router_traffic").get() as { n: number };
    return { total: Number(row.n), ...cfg };
  } catch {
    return { total: 0, ...cfg };
  }
}
