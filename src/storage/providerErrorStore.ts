/**
 * Provider error log store with 5-day retention.
 */
import type { DatabaseSync } from "node:sqlite";
import type { ProviderKind } from "./profileDefaults.js";
import { nowIso } from "./db.js";

export interface ProviderErrorLog {
  id?: number;
  profile_name: string;
  call_uid: string;
  provider: ProviderKind;
  model_id?: string | null;
  error_code: string;
  error_message: string;
  http_status?: number | null;
  provider_error_code?: string | null;
  retryable: boolean;
  retry_count: number;
  created_at: string;
}

export class ProviderErrorStore {
  constructor(private readonly db: DatabaseSync) {}

  logError(log: Omit<ProviderErrorLog, "id" | "created_at">): number {
    const result = this.db.prepare(`
      INSERT INTO provider_errors
        (profile_name, call_uid, provider, model_id, error_code, error_message,
         http_status, provider_error_code, retryable, retry_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      log.profile_name, log.call_uid, log.provider, log.model_id ?? null,
      log.error_code, log.error_message,
      log.http_status ?? null, log.provider_error_code ?? null,
      log.retryable ? 1 : 0, log.retry_count, nowIso(),
    );
    return Number(result.lastInsertRowid);
  }

  /** List errors with optional filters. */
  list(
    profileName: string,
    opts?: {
      provider?: ProviderKind;
      days?: number;
      retryable?: boolean;
    },
  ): ProviderErrorLog[] {
    const conditions = ["profile_name=?"];
    const params: unknown[] = [profileName];

    if (opts?.provider) {
      conditions.push("provider=?");
      params.push(opts.provider);
    }
    if (opts?.days !== undefined) {
      const cutoff = new Date(Date.now() - opts.days * 24 * 60 * 60 * 1000).toISOString();
      conditions.push("created_at >= ?");
      params.push(cutoff);
    }
    if (opts?.retryable !== undefined) {
      conditions.push("retryable=?");
      params.push(opts.retryable ? 1 : 0);
    }

    const sqlParams: (string | number | null)[] = [profileName];
    if (opts?.provider) sqlParams.push(opts.provider);
    if (opts?.days !== undefined) {
      sqlParams.push(new Date(Date.now() - opts.days * 24 * 60 * 60 * 1000).toISOString());
    }
    if (opts?.retryable !== undefined) sqlParams.push(opts.retryable ? 1 : 0);

    const rows = this.db.prepare(`
      SELECT id, profile_name, call_uid, provider, model_id, error_code, error_message,
             http_status, provider_error_code, retryable, retry_count, created_at
      FROM provider_errors
      WHERE profile_name=?
      ${opts?.provider ? "AND provider=?" : ""}
      ${opts?.days !== undefined ? "AND created_at >= ?" : ""}
      ${opts?.retryable !== undefined ? "AND retryable=?" : ""}
      ORDER BY created_at DESC
      LIMIT 200
    `).all(...sqlParams) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: Number(r.id),
      profile_name: String(r.profile_name),
      call_uid: String(r.call_uid),
      provider: String(r.provider) as ProviderKind,
      model_id: r.model_id ? String(r.model_id) : null,
      error_code: String(r.error_code),
      error_message: String(r.error_message),
      http_status: r.http_status != null ? Number(r.http_status) : null,
      provider_error_code: r.provider_error_code ? String(r.provider_error_code) : null,
      retryable: Boolean(r.retryable),
      retry_count: Number(r.retry_count),
      created_at: String(r.created_at),
    }));
  }

  /** Delete errors older than 5 days. Returns count deleted. */
  cleanup(): number {
    const cutoff = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare(`DELETE FROM provider_errors WHERE created_at < ?`).run(cutoff);
    return Number(result.changes);
  }

  /** Get last cleanup time from db user_meta (or 0 if never). */
  getLastCleanup(profileName: string): string {
    const row = this.db.prepare(`SELECT value FROM provider_cleanup_meta WHERE profile_name=? AND key=?`).get(profileName, "provider_error_cleanup") as { value: string } | undefined;
    return row ? String(row.value) : "1970-01-01T00:00:00.000Z";
  }

  /** Set last cleanup time. */
  setLastCleanup(profileName: string, ts: string): void {
    this.db.prepare(`
      INSERT INTO provider_cleanup_meta (profile_name, key, value) VALUES (?, ?, ?)
      ON CONFLICT(profile_name, key) DO UPDATE SET value=excluded.value
    `).run(profileName, "provider_error_cleanup", ts);
  }
}
