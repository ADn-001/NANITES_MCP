/**
 * Model aliases and ordered chains.
 *
 * An alias maps to an ordered list of catalog candidates. The router walks the
 * chain in order and stops at the first candidate that returns a real answer;
 * the winner is recorded as sticky so later requests skip the ones that failed.
 *
 * The walking rule that matters (design decision D7, and the easy one to get
 * wrong): a chain absorbs "this model is unavailable RIGHT NOW" and is NOT a
 * general error sink. A provider that 500s on everything will fail on every
 * candidate, so walking the chain just burns four times the latency before
 * returning the same error. Those failures propagate.
 */
import type { DatabaseSync } from "node:sqlite";
import { NanitesError } from "../../helpers/errors.js";
import { ProviderModelStore } from "../../storage/providerModelStore.js";
import { nowIso } from "../../storage/db.js";
import { ROUTER_PROFILE } from "../constants.js";

export interface ChainCandidate {
  provider: string;
  /** Only for generic endpoints, which scope the key pool. */
  endpoint?: string;
  model_id: string;
  max_output_tokens?: number;
  temperature?: number;
}

export interface AliasDef {
  alias: string;
  candidates: ChainCandidate[];
  /** Index of the last candidate that succeeded, or null. */
  sticky_winner: number | null;
}

/**
 * A REAL answer: non-empty content or a non-empty tool call. The same emptiness
 * test `isEmptyCloudReply` applies on the MCP side — an empty completion is
 * not a success, and treating it as one would pin a chain to a model that
 * answers with nothing.
 */
export function isRealAnswer(r: { content: unknown; tool_calls?: unknown[] }): boolean {
  const hasText = typeof r.content === "string"
    ? r.content.trim().length > 0
    : Array.isArray(r.content) && r.content.length > 0;
  const hasTools = Array.isArray(r.tool_calls) && r.tool_calls.length > 0;
  return hasText || hasTools;
}

/** Failure codes worth walking past. Everything else propagates. */
const WALKABLE = new Set([
  "provider_auth_error",
  "provider_forbidden",
  "provider_insufficient_credits",
  "provider_quota_exhausted",
  "provider_rate_limited",
  "provider_model_not_found",
  "provider_model_agreement_required",
  "provider_budget_exhausted",
  "provider_timeout",
  "provider_unavailable",
  "all_keys_exhausted",
  "endpoint_not_configured",
  "provider_key_required",
]);

export function isWalkable(code: string): boolean {
  return WALKABLE.has(code);
}

export interface WalkResult<T> {
  result: T;
  winner: number;
  tried: number;
}

export async function walkChain<T extends { content: unknown; tool_calls?: unknown[] }>(
  alias: string,
  candidates: ChainCandidate[],
  startAt: number,
  send: (candidate: ChainCandidate, index: number) => Promise<T>,
): Promise<WalkResult<T>> {
  if (candidates.length === 0) {
    throw new NanitesError({
      code: "alias_unknown",
      message: `Alias "${alias}" has no candidates.`,
      retryable: false,
      details: { alias },
    });
  }

  const reasons: Array<{ index: number; code: string; message: string }> = [];
  let tried = 0;

  // Start at the sticky winner when it is still a valid index, else zero.
  for (let i = 0; i < candidates.length; i++) {
    const index = (startAt + i) % candidates.length;
    const candidate = candidates[index]!;
    tried++;
    try {
      const result = await send(candidate, index);
      if (isRealAnswer(result)) return { result, winner: index, tried };
      reasons.push({ index, code: "all_output_empty", message: "Model returned an empty answer." });
    } catch (err) {
      const code = (err as { code?: string }).code ?? "unexpected_error";
      reasons.push({ index, code, message: err instanceof Error ? err.message : String(err) });
      // Anything that is NOT "this candidate is unavailable" propagates: a 500
      // or a malformed request will fail identically on every candidate.
      if (!isWalkable(code)) throw err;
    }
  }

  throw new NanitesError({
    code: "chain_exhausted",
    message: `Every candidate in alias "${alias}" failed (${tried} tried).`,
    retryable: true,
    details: { alias, tried, reasons },
  });
}

/* ------------------------------------------------------------- persistence */

interface AliasRow {
  alias: string;
  candidates: string;
  sticky_winner: number | null;
}

function rowToDef(row: AliasRow): AliasDef {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.candidates);
  } catch {
    parsed = [];
  }
  return {
    alias: row.alias,
    candidates: Array.isArray(parsed) ? (parsed as ChainCandidate[]) : [],
    sticky_winner: row.sticky_winner === null ? null : Number(row.sticky_winner),
  };
}

export function getAlias(db: DatabaseSync, alias: string): AliasDef | null {
  const row = db.prepare("SELECT * FROM router_aliases WHERE alias = ?").get(alias) as AliasRow | undefined;
  return row ? rowToDef(row) : null;
}

export function listAliases(db: DatabaseSync): AliasDef[] {
  const rows = db.prepare("SELECT * FROM router_aliases ORDER BY alias").all() as unknown as AliasRow[];
  return rows.map(rowToDef);
}

/**
 * Create or replace an alias.
 *
 * Validates every candidate against the catalog AT WRITE TIME. A dangling
 * reference is a configuration error the user should see now, not a request
 * that mysteriously walks to a missing model later — and validating lazily is
 * the mistake the registry already made once.
 */
export function setAlias(db: DatabaseSync, alias: string, candidates: ChainCandidate[]): AliasDef {
  const clean = alias.trim();
  if (!clean) {
    throw new NanitesError({ code: "alias_unknown", message: "Alias name is required.", retryable: false });
  }
  if (candidates.length === 0) {
    throw new NanitesError({
      code: "alias_unknown",
      message: `Alias "${clean}" needs at least one candidate.`,
      retryable: false,
      details: { alias: clean },
    });
  }

  const store = new ProviderModelStore(db);
  for (const [i, c] of candidates.entries()) {
    const known = store.getModel(ROUTER_PROFILE, c.provider as never, c.model_id);
    if (!known) {
      throw new NanitesError({
        code: "alias_candidate_unknown",
        message: `Candidate ${i} of "${clean}" is not in the catalog: ${c.provider}:${c.model_id}. Run discovery first.`,
        retryable: false,
        details: { alias: clean, index: i, provider: c.provider, model_id: c.model_id },
      });
    }
  }

  const now = nowIso();
  db.prepare(
    `INSERT INTO router_aliases (alias, candidates, sticky_winner, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?)
     ON CONFLICT (alias) DO UPDATE SET
       candidates = excluded.candidates,
       -- A NEW chain invalidates the old winner's index. Leaving it set would
       -- point at whichever candidate now sits at that position, which is a
       -- different model entirely.
       sticky_winner = NULL,
       updated_at = excluded.updated_at`,
  ).run(clean, JSON.stringify(candidates), now, now);

  return { alias: clean, candidates, sticky_winner: null };
}

export function setStickyWinner(db: DatabaseSync, alias: string, index: number): void {
  db.prepare("UPDATE router_aliases SET sticky_winner = ?, updated_at = ? WHERE alias = ?")
    .run(index, nowIso(), alias);
}

export function deleteAlias(db: DatabaseSync, alias: string): boolean {
  const result = db.prepare("DELETE FROM router_aliases WHERE alias = ?").run(alias);
  return Number(result.changes) > 0;
}
