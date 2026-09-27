/** Whether two role names count as a partial overlap. */
function roleOverlaps(a, b) {
    const na = a.toLowerCase();
    const nb = b.toLowerCase();
    if (na === nb)
        return true;
    if (na.includes(nb) || nb.includes(na))
        return true;
    const wa = na.split(/[^a-z0-9]+/).filter(Boolean);
    const wb = nb.split(/[^a-z0-9]+/).filter(Boolean);
    return wa.some((w) => wb.includes(w));
}
/** A role whose approved-test minima is below this floor (or has no approved
 * backing at all) is surfaced as `low_confidence` by runSubAgent (E3). Floor
 * configurability is deliberately deferred — flag, don't wire a profile field. */
export const FITNESS_FLOOR = 50;
/** Best-of-requested is intentional (spec E2): when a model matches several of
 * the requested roles, `Math.max` over the matched roles surfaces its strongest
 * matched role rather than an average. Do not "fix" this to a mean without
 * revisiting the multi-role selection policy. */
function rank(entry, matchedRoles, tier) {
    const scores = matchedRoles
        .map((r) => entry.scores[r])
        .filter((s) => typeof s === "number");
    return {
        tierWeight: tier === "exact" ? 2 : 1,
        bestScore: scores.length > 0 ? Math.max(...scores) : 0,
        id: entry.model_id,
    };
}
/** Best entry for the requested roles, or null when nothing matches. */
export function findBestModel(entries, requestedRoles) {
    const wanted = requestedRoles.map((r) => r.trim()).filter(Boolean);
    if (wanted.length === 0 || entries.length === 0)
        return null;
    let best = null;
    let bestRank = null;
    for (const entry of entries) {
        const roles = entry.roles ?? [];
        const exact = roles.filter((r) => wanted.includes(r));
        const partial = roles.filter((r) => !exact.includes(r) && wanted.some((q) => roleOverlaps(r, q)));
        if (exact.length === 0 && partial.length === 0)
            continue;
        const tier = exact.length > 0 ? "exact" : "partial";
        const matched = tier === "exact" ? exact : partial;
        const candidateRank = rank(entry, matched, tier);
        if (best === null ||
            candidateRank.tierWeight > bestRank.tierWeight ||
            (candidateRank.tierWeight === bestRank.tierWeight && candidateRank.bestScore > bestRank.bestScore) ||
            (candidateRank.tierWeight === bestRank.tierWeight && candidateRank.bestScore === bestRank.bestScore && candidateRank.id < bestRank.id)) {
            best = { entry, tier, matched_roles: matched };
            bestRank = candidateRank;
        }
    }
    return best;
}
/** Keyword vocabulary for turning a free-text brief into role candidates. */
const ROLE_KEYWORDS = {
    classifier: ["classif", "label", "triage", "categorize", "route"],
    reviewer: ["review", "bug", "bugs", "audit", "spot"],
    extractor: ["extract", "parse", "field", "json out"],
    code_qa: ["what does", "explain this", "summarize the code", "understand"],
    summarizer: ["summarize", "summary", "condense"],
    test_writer: ["test", "unit test", "vitest", "jest"],
    doc_writer: ["jsdoc", "document", "readme", "docstring", "comment"],
    refactorer: ["refactor", "rename", "convert", "transform", "migrate"],
    commit_writer: ["commit", "conventional"],
    code_writer: ["write", "generate", "scaffold", "boilerplate", "implement"],
    vision: [
        "image",
        "vision",
        "diagram",
        "screenshot",
        "ocr",
        "visual",
        "photo",
        "icon",
        "figure",
        "ui mockup",
        "caption",
        "in this picture",
        "describe this image",
    ],
};
export function rolesFromBrief(brief) {
    const lower = brief.toLowerCase();
    const found = [];
    for (const [role, keywords] of Object.entries(ROLE_KEYWORDS)) {
        if (keywords.some((k) => lower.includes(k)))
            found.push(role);
    }
    return found;
}
/** The built-in role names (canonical spellings), one keyword entry each —
 * grew to eleven with `vision`. Registry `scores` and `roles`
 * validate against these plus any role seen on a profile's registered custom
 * test units — never hard-close to just these (E5-side). */
export const BUILT_IN_ROLES = Object.freeze(Object.keys(ROLE_KEYWORDS).sort());
