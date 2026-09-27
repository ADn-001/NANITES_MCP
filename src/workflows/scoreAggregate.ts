/**
 * Role-keyed registry aggregation (E1), shared by finalize and the legacy
 * backfill so both trace to the same rule. Approved rows of the latest
 * test_run collapse per unit to its highest-scoring candidate (the winner),
 * then each winner unit contributes its score to every role it maps to via
 * `applicable_roles`: `scores[role]` = mean, `score_minima[role]` = min,
 * `roles` = sorted union. No unit-keyed output — `roleMatch` reads exactly
 * these role keys.
 */
import type { TestResult } from "../storage/testResultStore.js";
import type { TestUnit } from "../testunits/schema.js";

export interface ScoreAggregate {
  roles: string[];
  scores: Record<string, number>;
  score_minima: Record<string, number>;
}

/** Approved rows of the latest test_run, winner-collapsed per unit. */
export function aggregateRows(rows: TestResult[], unitById: ReadonlyMap<string, TestUnit>): ScoreAggregate | null {
  const approved = rows.filter((r) => r.status === "approved" && typeof r.score === "number");
  if (approved.length === 0) return null;

  let latest = 0;
  for (const r of approved) latest = Math.max(latest, r.test_run ?? 0);

  // Per-unit collapse to the highest-scoring candidate of the latest run.
  const bestPerUnit = new Map<string, TestResult>();
  for (const r of approved) {
    if ((r.test_run ?? 0) !== latest) continue;
    const current = bestPerUnit.get(r.unit_id);
    if (current === undefined || (r.score as number) > (current.score as number)) bestPerUnit.set(r.unit_id, r);
  }

  const contributions: Array<{ unit: TestUnit; score: number }> = [];
  for (const row of bestPerUnit.values()) {
    const unit = unitById.get(row.unit_id);
    if (unit) contributions.push({ unit, score: row.score as number });
  }
  return reduce(contributions);
}

/** Legacy unit-keyed scores -> role aggregation (each unit one score). */
export function aggregateFromUnitScores(
  unitScores: Record<string, number>,
  unitById: ReadonlyMap<string, TestUnit>,
): ScoreAggregate | null {
  const contributions: Array<{ unit: TestUnit; score: number }> = [];
  for (const [unitId, score] of Object.entries(unitScores)) {
    const unit = unitById.get(unitId);
    if (unit && typeof score === "number") contributions.push({ unit, score });
  }
  return reduce(contributions);
}

function reduce(contributions: Array<{ unit: TestUnit; score: number }>): ScoreAggregate | null {
  if (contributions.length === 0) return null;
  const roleScores = new Map<string, number[]>();
  for (const { unit, score } of contributions) {
    for (const role of unit.applicable_roles) {
      const list = roleScores.get(role) ?? [];
      list.push(score);
      roleScores.set(role, list);
    }
  }
  if (roleScores.size === 0) return null;

  const scores: Record<string, number> = {};
  const score_minima: Record<string, number> = {};
  for (const [role, list] of roleScores) {
    let sum = 0;
    let min = Infinity;
    for (const s of list) {
      sum += s;
      if (s < min) min = s;
    }
    scores[role] = sum / list.length;
    score_minima[role] = min;
  }
  return { roles: [...roleScores.keys()].sort(), scores, score_minima };
}
