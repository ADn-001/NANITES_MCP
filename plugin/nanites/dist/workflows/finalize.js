import { nowIso } from "../storage/db.js";
import { bestParamsFromAttempts } from "../storage/paramSearchStore.js";
import { aggregateRows } from "./scoreAggregate.js";
export function finalizeIfComplete(deps, profileName, modelId, provider) {
    if (deps.testResults.listPending(profileName, modelId).length > 0)
        return null;
    const unitById = new Map(deps.testUnits.list(profileName).map((u) => [u.id, u]));
    const rows = deps.testResults.list(profileName, modelId);
    const agg = aggregateRows(rows, unitById);
    if (!agg)
        return null;
    // Registry namespace for the tested model. Cloud regimen runs pass the kind
    // directly; the unchanged submit path carries no provider, so fall back to a
    // provider stamped on the test rows (cloud judged flow) then to any existing
    // registry entry (a retest of a provider-tagged model). Defaults to local.
    const taggedProvider = provider ??
        rows.find((r) => r.provider !== null)?.provider ??
        deps.registry.get(profileName, modelId)?.provider ??
        null;
    const entry = {
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
