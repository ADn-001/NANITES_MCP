import { aggregateRows, aggregateFromUnitScores } from "./scoreAggregate.js";
export function backfillScores(deps, profileName, roleVocab) {
    const entries = deps.registry.list(profileName);
    if (entries.length === 0)
        return 0;
    const unitById = new Map(deps.testUnits.list(profileName).map((u) => [u.id, u]));
    let rewritten = 0;
    for (const entry of entries) {
        const scores = entry.scores ?? {};
        const scoreKeys = Object.keys(scores);
        const minima = entry.score_minima;
        const hasNonVocabScore = scoreKeys.some((k) => !roleVocab.has(k));
        const hasNonVocabMinima = Object.keys(minima ?? {}).some((k) => !roleVocab.has(k));
        const roleKeys = scoreKeys.filter((k) => roleVocab.has(k));
        if (!hasNonVocabScore && !hasNonVocabMinima && minima !== undefined)
            continue;
        // Rows-first (authoritative — identical to finalize), then unit-keyed map.
        let agg = aggregateRows(deps.testResults.list(profileName, entry.model_id), unitById);
        if (!agg)
            agg = aggregateFromUnitScores(scores, unitById);
        let roles;
        let outScores;
        let outMinima;
        if (agg) {
            roles = agg.roles;
            outScores = agg.scores;
            outMinima = agg.score_minima;
        }
        else {
            // Nothing traceable to a source: keep the already-valid role keys.
            const kept = {};
            for (const role of roleKeys)
                kept[role] = scores[role];
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
