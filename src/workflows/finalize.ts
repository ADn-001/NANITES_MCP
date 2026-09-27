/**
 * Registry finalization for a tested model. Runs after a regimen completes
 * with no pending judged units, and again after every judgment submission.
 * Nothing is written until every orchestrator_judged unit has left `pending`
 * and at least one score is `approved` — a judgment with user_approved: false
 * stays out of the registry.
 *
 * E1: the persisted entry is role-keyed (never unit-id). Approved rows of the
 * latest test_run collapse per unit to the winner, then each winner unit
 * contributes to every role it maps to: `scores[role]` = mean, `score_minima`
 * [role]` = min. `roleMatch` reads `scores[role]` directly, so ranking finally
 * has real data. best_params carries sampling params only (E6).
 */
import type { ToolDeps } from "../tools/deps.js";
import { nowIso } from "../storage/db.js";
import type { RegistryEntry } from "../storage/registryStore.js";
import type { ProviderKind } from "../storage/profileDefaults.js";
import { bestParamsFromAttempts } from "../storage/paramSearchStore.js";
import { aggregateRows } from "./scoreAggregate.js";

export function finalizeIfComplete(
  deps: ToolDeps,
  profileName: string,
  modelId: string,
  provider?: ProviderKind,
): RegistryEntry | null {
  if (deps.testResults.listPending(profileName, modelId).length > 0) return null;

  const unitById = new Map(deps.testUnits.list(profileName).map((u) => [u.id, u]));
  const rows = deps.testResults.list(profileName, modelId);
  const agg = aggregateRows(rows, unitById);
  if (!agg) return null;

  // Registry namespace for the tested model. Cloud regimen runs pass the kind
  // directly; the unchanged submit path carries no provider, so fall back to a
  // provider stamped on the test rows (cloud judged flow) then to any existing
  // registry entry (a retest of a provider-tagged model). Defaults to local.
  const taggedProvider =
    provider ??
    rows.find((r) => r.provider !== null)?.provider ??
    deps.registry.get(profileName, modelId)?.provider ??
    null;

  const entry: RegistryEntry = {
    model_id: modelId,
    ...(taggedProvider !== null ? { provider: taggedProvider } : {}),
    roles: agg.roles,
    scores: agg.scores,
    score_minima: agg.score_minima,
    best_params: bestParamsFromAttempts(deps.paramSearch.list(profileName, modelId)),
    last_tested: nowIso(),
  };
  deps.registry.upsert(profileName, entry);
  return entry;
}
