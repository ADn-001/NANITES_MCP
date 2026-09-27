/**
 * Machine-spec guardrail advisor. Pure function: specs in, tier + mode +
 * recommendation + reason out. The reason string is non-empty and explains
 * *why* a suggestion is steered, since Claude is expected to surface it.
 */
import { tierForVram, pairKey } from "./tiers.js";
/** KV-slot warning appended whenever a pair uses num_parallel=4. */
function kvSlotWarning(pair) {
    return pair.num_parallel >= 4
        ? ` note num_parallel=${pair.num_parallel} multiplies KV-cache memory ~4x per load.`
        : "";
}
function buildConcurrencyReason(vramGb, tier, defaultPair, allowedPairs) {
    const head = `vram_gb=${vramGb} falls in the ${tier.label} tier (>= ${tier.minVramGb}GB VRAM) -> ${tier.mode} mode; concurrency pair is ${pairKey(defaultPair)} (${defaultPair.max_parallel_models} process(es) x ${defaultPair.num_parallel} prompt slot(s))`;
    if (allowedPairs.length === 0)
        return head + ", fully serialized, not user-overridable.";
    const listed = allowedPairs.map((p) => pairKey(p)).join(", ");
    return head + `; allowed override pairs: ${listed}` + kvSlotWarning(allowedPairs.find((p) => p.num_parallel >= 4) ?? defaultPair) + ".";
}
export function adviseGuardrails(specs) {
    const tier = tierForVram(specs.vram_gb);
    const defaultPair = { max_parallel_models: tier.maxParallelModels, num_parallel: tier.numParallel };
    const allowedPairs = [...tier.allowedPairs];
    const reason = buildConcurrencyReason(specs.vram_gb, tier, defaultPair, allowedPairs);
    const recommendation = tier.mode === "sequential"
        ? `Single model (${tier.maxParamsGuidance}), one model loaded at a time, one sub-agent at a time.`
        : `Parallel-capable: up to ${tier.maxParallelModels} sub-agents concurrently, ${tier.numParallel} prompt slot(s) per load (${tier.maxParamsGuidance}).`;
    return {
        tier: tier.label,
        mode: tier.mode,
        max_parallel_models: tier.maxParallelModels,
        num_parallel: tier.numParallel,
        allowed_pairs: allowedPairs,
        recommendation,
        reason,
    };
}
/**
 * Live-VRAM-aware guardrail advice. Advisory only: when a
 * live free-VRAM sample is below the profile's machine-spec VRAM, the effective
 * tier is temporarily lowered (never raised), and the reason explains the
 * downgrade. `liveFreeVramGb === null` (no VRAM surface — see src/helpers/
 * liveVram.ts) reduces to the static machine-spec tier with a recorded note;
 * no VRAM source is fabricated.
 */
export function effectiveGuardrailAdvice(specs, liveFreeVramGb) {
    const spec = adviseGuardrails(specs);
    if (liveFreeVramGb === null) {
        return {
            spec_tier: spec.tier,
            effective_tier: spec.tier,
            mode: spec.mode,
            max_parallel_models: spec.max_parallel_models,
            num_parallel: spec.num_parallel,
            allowed_pairs: spec.allowed_pairs,
            downgraded: false,
            vram_source: "static",
            reason: `no live VRAM surface on this LM Studio build — effective tier is the profile machine-spec tier ` +
                `(${spec.tier}, pair ${pairKey({ max_parallel_models: spec.max_parallel_models, num_parallel: spec.num_parallel })}); ` +
                `live-VRAM downgrades will apply once a source is available`,
        };
    }
    const effectiveVram = Math.min(specs.vram_gb, liveFreeVramGb);
    const live = adviseGuardrails({ vram_gb: Math.max(effectiveVram, 0.1) });
    const downgraded = live.tier !== spec.tier;
    const livePair = { max_parallel_models: live.max_parallel_models, num_parallel: live.num_parallel };
    const reason = downgraded
        ? `live free VRAM is ${liveFreeVramGb}GB — below the ${spec.tier} tier's available capacity ` +
            `(${specs.vram_gb}GB spec) -> effective tier temporarily lowered from ${spec.tier} to ${live.tier} ` +
            `(pair ${pairKey(livePair)}) (advisory)`
        : `live free VRAM is ${liveFreeVramGb}GB (>= the ${specs.vram_gb}GB machine-spec VRAM) -> no downgrade from ${spec.tier}`;
    return {
        spec_tier: spec.tier,
        effective_tier: live.tier,
        mode: live.mode,
        max_parallel_models: live.max_parallel_models,
        num_parallel: live.num_parallel,
        allowed_pairs: live.allowed_pairs,
        downgraded,
        vram_source: "live_free",
        reason,
    };
}
