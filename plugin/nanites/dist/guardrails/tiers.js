export const VRAM_TIERS = [
    {
        minVramGb: 0,
        label: "baseline",
        mode: "sequential",
        maxParamsGuidance: "<= ~8B at Q4",
        recommendedMaxParamsB: 8,
        /** Forced (1,1): one model, one prompt slot. No override allowed. */
        maxParallelModels: 1,
        numParallel: 1,
        allowedPairs: [],
    },
    {
        minVramGb: 6,
        label: "mid",
        mode: "sequential",
        maxParamsGuidance: "up to ~14B",
        recommendedMaxParamsB: 14,
        /** Forced (1,1): one model, one prompt slot. No override allowed. */
        maxParallelModels: 1,
        numParallel: 1,
        allowedPairs: [],
    },
    {
        minVramGb: 12,
        label: "high",
        mode: "parallel",
        maxParamsGuidance: "larger single-model ceiling",
        recommendedMaxParamsB: 34,
        /** Default (2,2). Only (2,2) is allowed on this tier. */
        maxParallelModels: 2,
        numParallel: 2,
        allowedPairs: [
            { max_parallel_models: 2, num_parallel: 2 },
        ],
    },
    {
        minVramGb: 24,
        label: "ultra",
        mode: "parallel",
        maxParamsGuidance: "multi-model orchestration",
        recommendedMaxParamsB: 70,
        /** Default (4,2) — up to 4 sub-agents × 2 slots. 4-slot combos opt-in. */
        maxParallelModels: 4,
        numParallel: 2,
        allowedPairs: [
            { max_parallel_models: 2, num_parallel: 2 },
            { max_parallel_models: 4, num_parallel: 2 },
            { max_parallel_models: 2, num_parallel: 4 },
            { max_parallel_models: 4, num_parallel: 4 },
        ],
    },
];
export function tierForVram(vramGb) {
    let selected = VRAM_TIERS[0];
    for (const tier of VRAM_TIERS) {
        if (vramGb >= tier.minVramGb)
            selected = tier;
    }
    return selected;
}
/** The tier's default concurrency pair (what a load sends absent an override). */
export function defaultPairForVram(vramGb) {
    const tier = tierForVram(vramGb);
    return { max_parallel_models: tier.maxParallelModels, num_parallel: tier.numParallel };
}
/** Pairs a user may override to on this tier. Empty = forced (1,1), no override. */
export function allowedPairsForVram(vramGb) {
    return [...tierForVram(vramGb).allowedPairs];
}
export function pairIsSequential(pair) {
    return pair.max_parallel_models === 1 && pair.num_parallel === 1;
}
export function pairKey(pair) {
    return `${pair.max_parallel_models}x${pair.num_parallel}`;
}
export function pairAllowedOnTier(vramGb, pair) {
    return allowedPairsForVram(vramGb).some((p) => p.max_parallel_models === pair.max_parallel_models && p.num_parallel === pair.num_parallel);
}
/**
 * Advisory context-length ceiling per VRAM tier for a single loaded instance.
 * Aligned with VRAM_TIERS: on a baseline 4GB/16GB box LM Studio CPU-offloads
 * ~16K contexts fine, so sub-6GB caps at 16384 rather than clipping the
 * default regimen's 16K judge units; the ceiling only bounds pathological
 * over-recommendations above what the box has been observed to honor.
 */
const VRAM_CONTEXT_CEILINGS = [
    { minVramGb: 0, ceiling: 16_384 },
    { minVramGb: 6, ceiling: 16_384 },
    { minVramGb: 12, ceiling: 32_768 },
    { minVramGb: 24, ceiling: Number.POSITIVE_INFINITY },
];
export function contextCeilingForVram(vramGb) {
    let ceiling = VRAM_CONTEXT_CEILINGS[0].ceiling;
    for (const tier of VRAM_CONTEXT_CEILINGS) {
        if (vramGb >= tier.minVramGb)
            ceiling = tier.ceiling;
    }
    return ceiling;
}
