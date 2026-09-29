/**
 * Provider inventory for the router's read-only views.
 *
 * ## Why this file exists
 *
 * Two surfaces need "how many keys and models does this profile have, per
 * provider": the router's own `GET /v1/keys`, and the dashboard's Router tab.
 * They were two hand-written queries, and they DISAGREED — one filtered
 * `is_enabled = 1` and the other did not, so the same database reported
 * different key counts depending on which tab you looked at.
 *
 * One implementation, one filter. The `enabledOnly` distinction is now an
 * explicit argument rather than an accident of which file the query landed in.
 *
 * Never throws: an inventory read is a diagnostic, and a missing table or an
 * unresolvable profile must render as "nothing to show", not as a 500 on a
 * status page.
 */
import type { DatabaseSync } from "node:sqlite";
import { routerProfile } from "../constants.js";

export interface ProviderKeyCount {
  provider: string;
  keys: number;
}

export interface ProviderModelCount {
  provider: string;
  models: number;
}

/**
 * Keys per provider for the router's profile.
 *
 * `enabledOnly` defaults to TRUE, which is the honest number for "how many
 * keys can this router actually use" — a disabled key cannot serve a request,
 * and counting it made the inventory look healthier than the gateway is.
 */
export function providerKeyCounts(
  db: DatabaseSync,
  opts: { profile?: string; enabledOnly?: boolean } = {},
): ProviderKeyCount[] {
  try {
    const rows = db.prepare(
      `SELECT provider, COUNT(*) AS n FROM provider_api_keys
        WHERE profile_name = ?${opts.enabledOnly === false ? "" : " AND is_enabled = 1"}
        GROUP BY provider ORDER BY provider`,
    ).all(opts.profile ?? routerProfile()) as Array<{ provider: string; n: number }>;
    return rows.map((r) => ({ provider: r.provider, keys: Number(r.n) }));
  } catch {
    return [];
  }
}

/** Registered models per provider. */
export function providerModelCounts(
  db: DatabaseSync,
  opts: { profile?: string } = {},
): ProviderModelCount[] {
  try {
    const rows = db.prepare(
      `SELECT provider, COUNT(*) AS n FROM provider_models
        WHERE profile_name = ? AND is_registered = 1
        GROUP BY provider ORDER BY provider`,
    ).all(opts.profile ?? routerProfile()) as Array<{ provider: string; n: number }>;
    return rows.map((r) => ({ provider: r.provider, models: Number(r.n) }));
  } catch {
    return [];
  }
}

/** Row count for a router table, 0 when the table is absent. */
export function routerTableCount(db: DatabaseSync, sql: string): number {
  try {
    const row = db.prepare(sql).get() as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}
