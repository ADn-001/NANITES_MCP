/**
 * Router key bookkeeping: metrics, sticky pointers, and the bridge from the
 * pure `selectKey` to the real stores.
 *
 * Deliberately thin. Exhaustion, cooldowns, and the round-robin cursor all live
 * in the existing `ProviderKeyStore` — this records what that store has no
 * concept of (per-key spend and usage) and supplies the preference data
 * `selectKey` needs.
 */
import type { DatabaseSync } from "node:sqlite";
import { ProviderKeyStore } from "../../storage/providerKeyStore.js";
import { ProviderModelStore } from "../../storage/providerModelStore.js";
import { nowIso } from "../../storage/db.js";
import type { ProviderKind } from "../../storage/profileDefaults.js";
import { routerProfile } from "../constants.js";
import { selectKey, advanceCursor, type KeyCandidate, type KeyStrategy, type SelectionPolicy } from "./selector.js";

export interface KeyMetrics {
  provider: string;
  key_id: string;
  request_count: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
  /** null when pricing is unknown. NEVER 0 as a stand-in for "unknown". */
  spent_usd: number | null;
  avg_latency_ms: number | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  usage_threshold: number | null;
}

interface MetricsRow {
  provider: string;
  key_id: string;
  request_count: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
  spent_usd: number | null;
  avg_latency_ms: number | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  usage_threshold: number | null;
}

function rowToMetrics(r: MetricsRow): KeyMetrics {
  return {
    provider: r.provider,
    key_id: r.key_id,
    request_count: Number(r.request_count),
    error_count: Number(r.error_count),
    input_tokens: Number(r.input_tokens),
    output_tokens: Number(r.output_tokens),
    spent_usd: r.spent_usd === null ? null : Number(r.spent_usd),
    avg_latency_ms: r.avg_latency_ms === null ? null : Number(r.avg_latency_ms),
    last_success_at: r.last_success_at,
    last_failure_at: r.last_failure_at,
    usage_threshold: r.usage_threshold === null ? null : Number(r.usage_threshold),
  };
}

export class RouterKeyStore {
  constructor(private readonly db: DatabaseSync) {}

  getMetrics(provider: string, keyId: string): KeyMetrics | null {
    const row = this.db.prepare(
      "SELECT * FROM router_key_metrics WHERE provider = ? AND key_id = ?",
    ).get(provider, keyId) as MetricsRow | undefined;
    return row ? rowToMetrics(row) : null;
  }

  listMetrics(): KeyMetrics[] {
    const rows = this.db.prepare(
      "SELECT * FROM router_key_metrics ORDER BY provider, key_id",
    ).all() as unknown as MetricsRow[];
    return rows.map(rowToMetrics);
  }

  setUsageThreshold(provider: string, keyId: string, requests: number | null): void {
    this.upsertRow(provider, keyId);
    this.db.prepare(
      "UPDATE router_key_metrics SET usage_threshold = ? WHERE provider = ? AND key_id = ?",
    ).run(requests, provider, keyId);
  }

  private upsertRow(provider: string, keyId: string): void {
    this.db.prepare(
      `INSERT INTO router_key_metrics (provider, key_id) VALUES (?, ?)
       ON CONFLICT (provider, key_id) DO NOTHING`,
    ).run(provider, keyId);
  }

  /**
   * Record a completed call.
   *
   * `spentUsd` stays NULL when pricing is unknown. The existing computeCost
   * returns undefined rather than guessing a rate, and a metric that reports 0
   * for "we do not know what this cost" is worse than an explicit null — it
   * looks like a key that is free.
   *
   * `avg_latency_ms` is a running mean, not a window: a rolling N=20 like the
   * MCP registry would need the last 20 samples, which this table does not
   * keep. A mean over the key's lifetime is the honest thing to show here.
   */
  recordSuccess(args: {
    provider: string;
    keyId: string;
    inputTokens: number;
    outputTokens: number;
    spentUsd: number | null;
    latencyMs: number;
  }): void {
    const now = nowIso();
    const existing = this.getMetrics(args.provider, args.keyId);
    const n = (existing?.request_count ?? 0) + 1;
    const prevAvg = existing?.avg_latency_ms ?? args.latencyMs;
    const avg = n === 1 ? args.latencyMs : (prevAvg * (n - 1) + args.latencyMs) / n;

    this.upsertRow(args.provider, args.keyId);
    this.db.prepare(
      `UPDATE router_key_metrics SET
         request_count = request_count + 1,
         input_tokens = input_tokens + ?,
         output_tokens = output_tokens + ?,
         -- COALESCE here would turn "unknown" into a real 0 on the first
         -- write, and a key that looks free is a different claim from a key
         -- whose rate we do not know. A NULL argument leaves the column alone.
         spent_usd = CASE WHEN ? IS NULL THEN spent_usd ELSE spent_usd + ? END,
         avg_latency_ms = ?,
         last_success_at = ?
       WHERE provider = ? AND key_id = ?`,
    ).run(args.inputTokens, args.outputTokens, args.spentUsd, args.spentUsd, avg, now, args.provider, args.keyId);
  }

  recordFailure(provider: string, keyId: string): void {
    this.upsertRow(provider, keyId);
    this.db.prepare(
      "UPDATE router_key_metrics SET error_count = error_count + 1, last_failure_at = ? WHERE provider = ? AND key_id = ?",
    ).run(nowIso(), provider, keyId);
  }

  /* -------------------------------------------------------------- sticky */

  getSticky(modelId: string): { provider: string; key_id: string; turns_left: number } | null {
    const row = this.db.prepare("SELECT * FROM router_sticky WHERE model_id = ?").get(modelId) as {
      provider: string; key_id: string; turns_left: number;
    } | undefined;
    return row ? { provider: row.provider, key_id: row.key_id, turns_left: Number(row.turns_left) } : null;
  }

  setSticky(modelId: string, provider: string, keyId: string, turns: number): void {
    this.db.prepare(
      `INSERT INTO router_sticky (model_id, provider, key_id, turns_left, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (model_id) DO UPDATE SET
         provider = excluded.provider, key_id = excluded.key_id,
         turns_left = excluded.turns_left, updated_at = excluded.updated_at`,
    ).run(modelId, provider, keyId, turns, nowIso());
  }

  /** Consume one turn. Returns null when the pointer is exhausted or gone. */
  consumeSticky(modelId: string): { provider: string; key_id: string; turns_left: number } | null {
    const row = this.getSticky(modelId);
    if (!row) return null;
    if (row.turns_left <= 1) {
      this.clearSticky(modelId);
      return null;
    }
    this.db.prepare("UPDATE router_sticky SET turns_left = turns_left - 1, updated_at = ? WHERE model_id = ?")
      .run(nowIso(), modelId);
    return { ...row, turns_left: row.turns_left - 1 };
  }

  clearSticky(modelId: string): void {
    this.db.prepare("DELETE FROM router_sticky WHERE model_id = ?").run(modelId);
  }

  /**
   * Drop the sticky pointer when it points at a key that is no longer healthy.
   *
   * The release conditions matter MORE than the set condition. A sticky pointer
   * to a degrading key is precisely the failure this feature exists to prevent,
   * so a pointer is dropped the moment its key is retired, is failing, or has
   * aged out.
   */
  releaseIfUnhealthy(modelId: string, availableKeyIds: Set<string>, now: Date): void {
    const row = this.getSticky(modelId);
    if (!row) return;
    if (!availableKeyIds.has(row.key_id) || row.turns_left <= 0) this.clearSticky(modelId);
  }

  /* ------------------------------------------------------------ selection */

  /**
   * Build the candidate list and run the configured strategy.
   *
   * Returns the chosen key and the cursor to persist. Throws when the provider
   * has no eligible key at all — that is a distinct, actionable error from
   * "the strategy picked something else", so it is not folded into a null.
   */
  pickKey(args: {
    provider: ProviderKind;
    modelId: string;
    strategy: KeyStrategy;
    budgetThreshold: number;
    stickyTtlTurns: number;
    fallback: "random" | "round_robin";
    random: () => number;
    /** Restrict to one generic endpoint. */
    endpoint?: string | null;
  }): { key: { key_id: string; api_key: string; account_id: string | null; gateway_url: string | null; nickname: string | null }; cursor: number } {
    const keyStore = new ProviderKeyStore(this.db);
    let available = keyStore.availableKeys(routerProfile(), args.provider);

    // Endpoint scoping narrows the pool, and an endpoint with no key is a
    // distinct error rather than "fall back to another gateway" — the other
    // gateway may not even have the model.
    if (args.endpoint) {
      const scoped = available.filter((k) => k.nickname === args.endpoint);
      if (scoped.length === 0) {
        available = [];
      } else {
        available = scoped;
      }
    }

    if (available.length === 0) {
      const code = args.endpoint ? "endpoint_not_configured" : "all_keys_exhausted";
      const message = args.endpoint
        ? `No key for the generic endpoint "${args.endpoint}".`
        : `Provider "${args.provider}" has no enabled, un-exhausted key.`;
      const err = new Error(message) as Error & { code: string; details: Record<string, unknown> };
      err.code = code;
      err.details = { provider: args.provider, endpoint: args.endpoint ?? null };
      throw err;
    }

    const sticky = this.getSticky(args.modelId);
    this.releaseIfUnhealthy(args.modelId, new Set(available.map((k) => k.key_id)), new Date());

    const candidates: KeyCandidate[] = available.map((k, order) => {
      const metrics = this.getMetrics(args.provider, k.key_id);
      const threshold = metrics?.usage_threshold ?? null;
      const ratio = threshold && threshold > 0 ? (metrics?.request_count ?? 0) / threshold : 0;
      return {
        key_id: k.key_id,
        provider: k.provider,
        nickname: k.nickname,
        gateway_url: k.gateway_url,
        usage_ratio: ratio,
        is_sticky: sticky?.key_id === k.key_id,
        consecutive_failures: k.consecutive_failures,
        order,
      };
    });

    const state = keyStore.getKeyState(routerProfile(), args.provider);
    const policy: SelectionPolicy = {
      strategy: args.strategy,
      budget_threshold: args.budgetThreshold,
      fallback: args.fallback,
      cursor: Number(state.lastKeyIndex ?? -1) + 1,
      random: args.random,
    };

    const chosen = selectKey(candidates, policy);
    if (!chosen) {
      // Every candidate is over budget.
      const err = new Error(`Every key on "${args.provider}" is at or over its usage budget.`) as Error & { code: string };
      err.code = "all_keys_exhausted";
      throw err;
    }

    const key = available.find((k) => k.key_id === chosen.key_id)!;
    return { key, cursor: advanceCursor(policy.cursor, candidates.length) };
  }
}
