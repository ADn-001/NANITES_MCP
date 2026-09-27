/**
 * Deterministic guardrail filtering for Workflow #4. HF search results arrive
 * from the host's connector as candidate models; this shortlists them against
 * the active profile's tier BEFORE anything is suggested, so a model far
 * outside the tier's recommended range is excluded with an explicit reason —
 * never silently suggested. Filtering is pure: params label in, fit verdict +
 * reason out. No model guessing.
 */
import { tierForVram } from "../guardrails/tiers.js";
/** "20B" -> 20, "270M" -> 0.27, "7B v3" -> 7, garbage -> null. */
export function paramsToBillions(params) {
    if (typeof params !== "string" || params.length === 0)
        return null;
    const m = params.match(/(\d+(?:\.\d+)?)\s*([BbMm])/);
    if (!m)
        return null;
    const n = parseFloat(m[1]);
    return m[2].toLowerCase() === "m" ? n / 1000 : n;
}
export function filterByGuardrail(candidates, vramGb) {
    const tier = tierForVram(vramGb);
    const kept = [];
    const excluded = [];
    for (const candidate of candidates) {
        const paramsB = paramsToBillions(candidate.params);
        if (paramsB === null) {
            kept.push({ ...candidate, fits: true, reason: `${candidate.model}: params unknown, not filterable; presented for review` });
            continue;
        }
        if (paramsB > tier.recommendedMaxParamsB) {
            excluded.push({
                ...candidate,
                fits: false,
                reason: `${candidate.model} (~${paramsB}B params) exceeds the ${tier.label} tier recommended max (~${tier.recommendedMaxParamsB}B)`,
            });
            continue;
        }
        kept.push({
            ...candidate,
            fits: true,
            reason: `${candidate.model} (~${paramsB}B params) fits the ${tier.label} tier (<= ~${tier.recommendedMaxParamsB}B)`,
        });
    }
    return { kept, excluded };
}
