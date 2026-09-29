/**
 * The router's virtual API key: the single credential a harness presents to
 * reach the gateway.
 *
 * It is stored HASHED, which is a deliberate inconsistency with the existing
 * `provider_api_keys` table (that one is plaintext, honestly documented in the
 * README). The difference is justified rather than accidental: provider keys are
 * stored plaintext because Nanites has to SEND them somewhere, but the virtual
 * key is only ever compared against — the router never forwards it upstream — so
 * there is no reason to store a recoverable copy of it.
 *
 * The salt is per-install, so two routers with the same key do not share a
 * digest, and a stolen database cannot be attacked with a precomputed table.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "../storage/db.js";
import { tokensMatch } from "../ui/guards.js";
import { NanitesError } from "../helpers/errors.js";

/** scrypt cost parameters. N=16384 is the Node default and ~100ms per call. */
const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LENGTH = 32;

/** Prefixed so a future scheme change is recognizable in a stored value. */
const HASH_PREFIX = "scrypt";

/** Length of a generated key. 32 bytes → 43 base64url chars, URL-safe. */
const GENERATED_KEY_BYTES = 32;

export interface KeyResolution {
  /** The plaintext key, ONLY when this call generated it. Never persisted. */
  generated: string | null;
  hash: string;
  salt: string;
  /** True when the key came from NANITES_ROUTER_KEY rather than the store. */
  fromEnv: boolean;
}

export function newVirtualKey(): string {
  return randomBytes(GENERATED_KEY_BYTES).toString("base64url");
}

export function newKeySalt(): string {
  return randomBytes(16).toString("base64url");
}

/** scrypt a key with the install salt. Returns a self-describing string. */
export function hashVirtualKey(key: string, salt: string): string {
  const derived = scryptSync(key, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p });
  return `${HASH_PREFIX}$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt}$${derived.toString("base64")}`;
}

export interface VerifyResult {
  ok: boolean;
  reason: "ok" | "missing" | "malformed_header" | "bad_bearer" | "mismatch";
}

/**
 * Verify a presented key against a stored hash.
 *
 * The parse of the stored hash is defensive: a value written by a future
 * version with a different scheme must fail CLOSED rather than throwing out of
 * the request path, and it must not fall through to a comparison.
 */
export function verifyVirtualKey(presented: string | undefined, storedHash: string): VerifyResult {
  if (!presented) return { ok: false, reason: "missing" };

  const parts = storedHash.split("$");
  if (parts.length !== 6 || parts[0] !== HASH_PREFIX) {
    return { ok: false, reason: "malformed_header" };
  }
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = parts[4]!;
  const expected = parts[5]!;
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p) || !salt || !expected) {
    return { ok: false, reason: "malformed_header" };
  }

  let derived: Buffer;
  try {
    derived = scryptSync(presented, salt, KEY_LENGTH, { N: n, r, p });
  } catch {
    return { ok: false, reason: "mismatch" };
  }

  let expectedBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expected, "base64");
  } catch {
    return { ok: false, reason: "malformed_header" };
  }
  if (expectedBuf.length !== derived.length) return { ok: false, reason: "malformed_header" };

  return timingSafeEqual(derived, expectedBuf) ? { ok: true, reason: "ok" } : { ok: false, reason: "mismatch" };
}

/**
 * Pull a bearer token off a request. Returns null when the header is absent or
 * is not a well-formed `Authorization: Bearer <token>`.
 */
export function bearerToken(headerValue: string | string[] | undefined): string | null {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!raw) return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1]!.trim() : null;
}

/** Constant-time compare of two plaintexts. Used for the env-supplied path. */
export function keysMatch(a: string, b: string): boolean {
  return tokensMatch(a, b);
}

export interface RouterConfigRow {
  id: number;
  /** null until a key is provisioned. See the migration's note on the column. */
  virtual_key_hash: string | null;
  key_salt: string | null;
  port: number;
  bind: string;
  default_strategy: string;
  budget_threshold: number;
  sticky_ttl_turns: number;
  enable_model_repair: number;
  enable_helpers: number;
  /** Per-feature helper flags. Present from migration 26. */
  feature_tool_repair: number;
  feature_structured_output: number;
  feature_laya_preflight: number;
  feature_laya_postflight: number;
  tunnel_enabled: number;
  tunnel_url: string | null;
  created_at: string;
  updated_at: string;
}

/** A nullable numeric column, defaulting to 0. Never NaN. */
function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function rowToConfig(row: Record<string, unknown>): RouterConfigRow {
  return {
    id: Number(row.id),
    virtual_key_hash: nullableString(row.virtual_key_hash),
    key_salt: nullableString(row.key_salt),
    port: Number(row.port),
    bind: String(row.bind),
    default_strategy: String(row.default_strategy),
    budget_threshold: Number(row.budget_threshold),
    sticky_ttl_turns: Number(row.sticky_ttl_turns),
    enable_model_repair: Number(row.enable_model_repair),
    enable_helpers: Number(row.enable_helpers),
    // Number(undefined) is NaN, which is falsy but not 0 — and a NaN in a
    // flag field serialises to null in JSON, so the dashboard renders "off"
    // for a feature that is genuinely on. Number(x) || 0 would also swallow a
    // legitimate 0, so the default is applied explicitly.
    feature_tool_repair: num(row.feature_tool_repair),
    feature_structured_output: num(row.feature_structured_output),
    feature_laya_preflight: num(row.feature_laya_preflight),
    feature_laya_postflight: num(row.feature_laya_postflight),
    tunnel_enabled: Number(row.tunnel_enabled),
    tunnel_url: nullableString(row.tunnel_url),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function readConfig(db: DatabaseSync): RouterConfigRow | null {
  const row = db.prepare("SELECT * FROM router_config WHERE id = 1").get() as Record<string, unknown> | undefined;
  return row ? rowToConfig(row) : null;
}

/**
 * Create the singleton config row if absent. A fresh row has NO key — that is
 * not a failure state, it is the state a first boot is in.
 */
export function ensureConfigRow(db: DatabaseSync): RouterConfigRow {
  const existing = readConfig(db);
  if (existing) return existing;
  const now = nowIso();
  db.prepare(
    "INSERT INTO router_config (id, virtual_key_hash, key_salt, created_at, updated_at) VALUES (1, NULL, NULL, ?, ?)",
  ).run(now, now);
  return readConfig(db)!;
}

/** Persist a new hash (used when the key is generated or supplied). */
export function saveKeyHash(db: DatabaseSync, key: string, salt: string): void {
  db.prepare("UPDATE router_config SET virtual_key_hash = ?, key_salt = ?, updated_at = ? WHERE id = 1")
    .run(hashVirtualKey(key, salt), salt, nowIso());
}

/**
 * The only config fields a runtime caller may change.
 *
 * A WHITELIST, not a column list. `port` and `bind` change what the process is
 * reachable on, and `virtual_key_hash` would lock the caller out of their own
 * gateway — neither belongs behind a JSON patch. Everything here is a boolean
 * feature flag with a defined off state, so there is no such thing as a
 * partial write to recover from.
 */
const WRITABLE_FLAGS = [
  "enable_helpers",
  "enable_model_repair",
  // Per-feature helper flags. Named as `feature_*` to match the migration's
  // column names exactly, so a typo is a rejected request rather than a
  // setting that silently does nothing.
  "feature_tool_repair",
  "feature_structured_output",
  "feature_laya_preflight",
  "feature_laya_postflight",
] as const;

export type WritableFlag = (typeof WRITABLE_FLAGS)[number];

/**
 * Apply a config patch and return the effective row.
 *
 * Unknown keys are REJECTED rather than ignored. A silently-dropped field
 * reads as "the router accepted my setting" and is discovered days later, when
 * the flag is still off and nobody remembers sending the request.
 */
export function updateConfig(db: DatabaseSync, patch: Record<string, unknown>): RouterConfigRow {
  for (const key of Object.keys(patch)) {
    if (!(WRITABLE_FLAGS as readonly string[]).includes(key)) {
      throw new NanitesError({
        code: "router_invalid_request",
        message: `"${key}" is not a writable config field. Writable: ${WRITABLE_FLAGS.join(", ")}.`,
        retryable: false,
        details: { key, writable: [...WRITABLE_FLAGS] },
      });
    }
    if (typeof patch[key] !== "boolean") {
      throw new NanitesError({
        code: "router_invalid_request",
        message: `"${key}" must be a boolean.`,
        retryable: false,
        details: { key },
      });
    }
  }
  if (Object.keys(patch).length > 0) {
    const sets = Object.keys(patch).map((k) => `${k} = ?`).join(", ");
    db.prepare(`UPDATE router_config SET ${sets}, updated_at = ? WHERE id = 1`)
      .run(...Object.values(patch).map((v) => (v ? 1 : 0)), nowIso());
  }
  return ensureConfigRow(db);
}

/**
 * Startup resolution, in the order the spec fixes: an explicit env var wins,
 * then whatever is already stored, then generate a fresh key and print it once.
 *
 * An env-supplied key is hashed into the store on first sight so the
 * verification path is identical regardless of where the key came from — there
 * is no second, weaker code path to keep in sync.
 *
 * Regenerating on every boot would invalidate every configured harness the
 * moment the process restarted, so a stored hash is always reused as-is.
 */
export function resolveVirtualKey(db: DatabaseSync, env: NodeJS.ProcessEnv = process.env): KeyResolution {
  const config = ensureConfigRow(db);

  const fromEnv = (env.NANITES_ROUTER_KEY ?? "").trim();
  if (fromEnv) {
    const salt = config.key_salt ?? newKeySalt();
    if (hashVirtualKey(fromEnv, salt) !== config.virtual_key_hash) saveKeyHash(db, fromEnv, salt);
    return { generated: null, hash: hashVirtualKey(fromEnv, salt), salt, fromEnv: true };
  }

  if (config.virtual_key_hash && config.key_salt) {
    return { generated: null, hash: config.virtual_key_hash, salt: config.key_salt, fromEnv: false };
  }

  const generated = newVirtualKey();
  const salt = config.key_salt ?? newKeySalt();
  saveKeyHash(db, generated, salt);
  return { generated, hash: hashVirtualKey(generated, salt), salt, fromEnv: false };
}
