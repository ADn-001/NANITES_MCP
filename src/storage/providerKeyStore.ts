/**
 * Provider API key store. Manages per-profile provider keys: add, remove,
 * toggle enable/disable, exhaustion tracking, and round-robin index.
 */
import { safeJsonParse } from "./registryStore.js";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { ProviderKey } from "../providers/types.js";
import type { ProviderKind } from "./profileDefaults.js";
import { nowIso } from "./db.js";

export class ProviderKeyStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Add a new key for a profile+provider. Returns the generated key_id. */
  addKey(
    profileName: string,
    provider: ProviderKind,
    apiKey: string,
    opts?: { accountId?: string; gatewayUrl?: string; nickname?: string },
  ): string {
    const keyId = randomUUID();
    this.db.prepare(`
      INSERT INTO provider_api_keys
        (profile_name, provider, key_id, api_key, account_id, gateway_url, nickname, is_enabled, is_exhausted, consecutive_failures, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?)
    `).run(profileName, provider, keyId, apiKey, opts?.accountId ?? null, opts?.gatewayUrl ?? null, opts?.nickname ?? null, nowIso());
    return keyId;
  }

  /** Remove a key by key_id. */
  removeKey(profileName: string, provider: ProviderKind, keyId: string): void {
    this.db.prepare(`DELETE FROM provider_api_keys WHERE profile_name=? AND provider=? AND key_id=?`).run(profileName, provider, keyId);
  }

  /** Toggle is_enabled for a key. */
  setEnabled(profileName: string, provider: ProviderKind, keyId: string, enabled: boolean): void {
    this.db.prepare(`UPDATE provider_api_keys SET is_enabled=? WHERE profile_name=? AND provider=? AND key_id=?`).run(enabled ? 1 : 0, profileName, provider, keyId);
  }

  /** List all keys for a profile+provider. */
  listKeys(profileName: string, provider: ProviderKind): ProviderKey[] {
    const rows = this.db.prepare(`
      SELECT profile_name, provider, key_id, api_key, account_id, gateway_url, nickname,
             is_enabled, is_exhausted, exhausted_until, consecutive_failures, created_at
      FROM provider_api_keys
      WHERE profile_name=? AND provider=?
      ORDER BY created_at, key_id
    `).all(profileName, provider) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      profile_name: String(r.profile_name),
      provider: String(r.provider) as ProviderKind,
      key_id: String(r.key_id),
      api_key: String(r.api_key),
      account_id: r.account_id ? String(r.account_id) : null,
      gateway_url: r.gateway_url ? String(r.gateway_url) : null,
      nickname: r.nickname ? String(r.nickname) : null,
      is_enabled: Boolean(r.is_enabled),
      is_exhausted: Boolean(r.is_exhausted),
      exhausted_until: r.exhausted_until ? String(r.exhausted_until) : null,
      consecutive_failures: Number(r.consecutive_failures),
      created_at: String(r.created_at),
    }));
  }

  /** Get all enabled, non-exhausted keys for round-robin selection. */
  availableKeys(profileName: string, provider: ProviderKind): ProviderKey[] {
    const now = nowIso();
    const rows = this.db.prepare(`
      SELECT profile_name, provider, key_id, api_key, account_id, gateway_url, nickname,
             is_enabled, is_exhausted, exhausted_until, consecutive_failures, created_at
      FROM provider_api_keys
      WHERE profile_name=? AND provider=?
        AND is_enabled=1
        AND (is_exhausted=0 OR exhausted_until IS NULL OR exhausted_until<=?)
      ORDER BY created_at, key_id
    `).all(profileName, provider, now) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      profile_name: String(r.profile_name),
      provider: String(r.provider) as ProviderKind,
      key_id: String(r.key_id),
      api_key: String(r.api_key),
      account_id: r.account_id ? String(r.account_id) : null,
      gateway_url: r.gateway_url ? String(r.gateway_url) : null,
      nickname: r.nickname ? String(r.nickname) : null,
      is_enabled: Boolean(r.is_enabled),
      is_exhausted: Boolean(r.is_exhausted),
      exhausted_until: r.exhausted_until ? String(r.exhausted_until) : null,
      consecutive_failures: Number(r.consecutive_failures),
      created_at: String(r.created_at),
    }));
  }

  /** Update nickname for a key. */
  setNickname(profileName: string, provider: ProviderKind, keyId: string, nickname: string | null): void {
    this.db.prepare(`UPDATE provider_api_keys SET nickname=? WHERE profile_name=? AND provider=? AND key_id=?`).run(nickname, profileName, provider, keyId);
  }

  /**
   * Get key state (round-robin index + exhausted keys) for a provider.
   *
   * `lastKeyIndex` is the index of the last key USED, so a fresh state is `-1`,
   * not `0`. Advancing with `(lastKeyIndex + 1) % n` then selects `keys[0]` on
   * the first call. Seeding it at `0` silently skipped the first key on every
   * new profile.
   */
  getKeyState(profileName: string, provider: ProviderKind): { lastKeyIndex: number; exhaustedKeys: Record<string, string> } {
    const row = this.db.prepare(`SELECT last_key_index, exhausted_keys FROM provider_key_state WHERE profile_name=? AND provider=?`).get(profileName, provider) as { last_key_index: number; exhausted_keys: string } | undefined;
    return {
      lastKeyIndex: row ? Number(row.last_key_index) : -1,
      exhaustedKeys: safeJsonParse<Record<string, string>>(row?.exhausted_keys ?? "", {}),
    };
  }

  /** Save key state (round-robin index + exhausted keys map). */
  saveKeyState(profileName: string, provider: ProviderKind, lastKeyIndex: number, exhaustedKeys: Record<string, string>): void {
    this.db.prepare(`
      INSERT INTO provider_key_state (profile_name, provider, last_key_index, exhausted_keys)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(profile_name, provider) DO UPDATE SET last_key_index=excluded.last_key_index, exhausted_keys=excluded.exhausted_keys
    `).run(profileName, provider, lastKeyIndex, JSON.stringify(exhaustedKeys));
  }

  /** Record a failure on a key; auto-exhaust at 3 consecutive failures. */
  recordFailure(profileName: string, provider: ProviderKind, keyId: string): void {
    const row = this.db.prepare(`SELECT consecutive_failures FROM provider_api_keys WHERE profile_name=? AND provider=? AND key_id=?`).get(profileName, provider, keyId) as { consecutive_failures: number } | undefined;
    if (!row) return;
    const failures = Number(row.consecutive_failures) + 1;
    if (failures >= 3) {
      const exhaustedUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      this.db.prepare(`UPDATE provider_api_keys SET consecutive_failures=?, is_exhausted=1, exhausted_until=? WHERE profile_name=? AND provider=? AND key_id=?`).run(failures, exhaustedUntil, profileName, provider, keyId);
    } else {
      this.db.prepare(`UPDATE provider_api_keys SET consecutive_failures=? WHERE profile_name=? AND provider=? AND key_id=?`).run(failures, profileName, provider, keyId);
    }
  }

  /** Clear exhaustion on a key (called on success). */
  clearExhaustion(profileName: string, provider: ProviderKind, keyId: string): void {
    this.db.prepare(`UPDATE provider_api_keys SET consecutive_failures=0, is_exhausted=0, exhausted_until=NULL WHERE profile_name=? AND provider=? AND key_id=?`).run(profileName, provider, keyId);
  }

  /**
   * Retire a key that cannot serve until `until`. Used for failures that are
   * the KEY's fault rather than the model's — a rejected credential or a spent
   * metered allowance. The default 3-strikes exhaustion in `recordFailure` is
   * wrong for these: a spent daily quota and a rejected key both retry
   * identically forever, burning every remaining attempt.
   */
  exhaustKey(profileName: string, provider: ProviderKind, keyId: string, until: Date): void {
    this.db
      .prepare(`UPDATE provider_api_keys SET is_exhausted=1, exhausted_until=? WHERE profile_name=? AND provider=? AND key_id=?`)
      .run(until.toISOString(), profileName, provider, keyId);
  }

  /** Get a key by key_id. */
  getKey(profileName: string, provider: ProviderKind, keyId: string): ProviderKey | null {
    const row = this.db.prepare(`
      SELECT profile_name, provider, key_id, api_key, account_id, gateway_url, nickname,
             is_enabled, is_exhausted, exhausted_until, consecutive_failures, created_at
      FROM provider_api_keys
      WHERE profile_name=? AND provider=? AND key_id=?
    `).get(profileName, provider, keyId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      profile_name: String(row.profile_name),
      provider: String(row.provider) as ProviderKind,
      key_id: String(row.key_id),
      api_key: String(row.api_key),
      account_id: row.account_id ? String(row.account_id) : null,
      gateway_url: row.gateway_url ? String(row.gateway_url) : null,
      nickname: row.nickname ? String(row.nickname) : null,
      is_enabled: Boolean(row.is_enabled),
      is_exhausted: Boolean(row.is_exhausted),
      exhausted_until: row.exhausted_until ? String(row.exhausted_until) : null,
      consecutive_failures: Number(row.consecutive_failures),
      created_at: String(row.created_at),
    };
  }
}
