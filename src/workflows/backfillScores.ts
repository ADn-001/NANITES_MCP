/**
 * E5 — legacy registry backfill (pure transform, zero LM Studio calls). Legacy
 * entries carry unit-keyed `scores` (old finalize), lack `score_minima`, or
 * hold hand-inserted junk keys; each is healed to the canonical role-keyed
 * shape so `roleMatch` and the E3 floor read real data. Triggered lazily by
 * read_registry when a malformed entry is seen; idempotent (rewrites only
 * entries that need it). Recompute source priority:
 *   1. approved test_results rows (same E1 aggregation as finalize),
 *   2. else known unit-keyed scores mapped through the unit's applicable_roles,
 *   3. else keep any already-valid role keys (single-sample floor).
 */
import type { ToolDeps } from "../tools/deps.js";
import { aggregateRows, aggregateFromUnitScores } from "./scoreAggregate.js";

export function backfillScores(
  deps: ToolDeps,
  profileName: string,
  roleVocab: ReadonlySet<string>,
): number {
  const entries = deps.registry.list(profileName);
  if (entries.length === 0) return 0;

  const unitById = new Map(deps.testUnits.list(profileName).map((u) => [u.id, u]));
  let rewritten = 0;

  for (const entry of entries) {
    const scores = entry.scores ?? {};
    const scoreKeys = Object.keys(scores);
    const minima = entry.score_minima;

    const hasNonVocabScore = scoreKeys.some((k) => !roleVocab.has(k));
    const hasNonVocabMinima = Object.keys(minima ?? {}).some((k) => !roleVocab.has(k));
    const roleKeys = scoreKeys.filter((k) => roleVocab.has(k));
    if (!hasNonVocabScore && !hasNonVocabMinima && minima !== undefined) continue;

    // Rows-first (authoritative — identical to finalize), then unit-keyed map.
    let agg = aggregateRows(deps.testResults.list(profileName, entry.model_id), unitById);
    if (!agg) agg = aggregateFromUnitScores(scores, unitById);

    let roles: string[];
    let outScores: Record<string, number>;
    let outMinima: Record<string, number>;
    if (agg) {
      roles = agg.roles;
      outScores = agg.scores;
      outMinima = agg.score_minima;
    } else {
      // Nothing traceable to a source: keep the already-valid role keys.
      const kept: Record<string, number> = {};
      for (const role of roleKeys) kept[role] = scores[role] as number;
      roles = roleKeys.sort();
      outScores = kept;
      // Single-sample floor: a hand/role entry has one number per role.
      outMinima = { ...kept };
    }

    deps.registry.upsert(profileName, {
      ...entry,
      roles,
      scores: outScores,
      score_minima: outMinima,
    });
    rewritten++;
  }

  return rewritten;
}
