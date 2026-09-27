/** Approved rows of the latest test_run, winner-collapsed per unit. */
export function aggregateRows(rows, unitById) {
    const approved = rows.filter((r) => r.status === "approved" && typeof r.score === "number");
    if (approved.length === 0)
        return null;
    let latest = 0;
    for (const r of approved)
        latest = Math.max(latest, r.test_run ?? 0);
    // Per-unit collapse to the highest-scoring candidate of the latest run.
    const bestPerUnit = new Map();
    for (const r of approved) {
        if ((r.test_run ?? 0) !== latest)
            continue;
        const current = bestPerUnit.get(r.unit_id);
        if (current === undefined || r.score > current.score)
            bestPerUnit.set(r.unit_id, r);
    }
    const contributions = [];
    for (const row of bestPerUnit.values()) {
        const unit = unitById.get(row.unit_id);
        if (unit)
            contributions.push({ unit, score: row.score });
    }
    return reduce(contributions);
}
/** Legacy unit-keyed scores -> role aggregation (each unit one score). */
export function aggregateFromUnitScores(unitScores, unitById) {
    const contributions = [];
    for (const [unitId, score] of Object.entries(unitScores)) {
        const unit = unitById.get(unitId);
        if (unit && typeof score === "number")
            contributions.push({ unit, score });
    }
    return reduce(contributions);
}
function reduce(contributions) {
    if (contributions.length === 0)
        return null;
    const roleScores = new Map();
    for (const { unit, score } of contributions) {
        for (const role of unit.applicable_roles) {
            const list = roleScores.get(role) ?? [];
            list.push(score);
            roleScores.set(role, list);
        }
    }
    if (roleScores.size === 0)
        return null;
    const scores = {};
    const score_minima = {};
    for (const [role, list] of roleScores) {
        let sum = 0;
        let min = Infinity;
        for (const s of list) {
            sum += s;
            if (s < min)
                min = s;
        }
        scores[role] = sum / list.length;
        score_minima[role] = min;
    }
    return { roles: [...roleScores.keys()].sort(), scores, score_minima };
}
