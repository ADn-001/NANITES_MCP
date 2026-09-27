/**
 * Guardrail tier thresholds. Configurable constants per §4 of the project
 * instructions — never hardcoded inline at call sites.
 *
 * Concurrency-hardening model (2026-09-05): each tier carries a concurrency
 * *pair* — process capacity (max_parallel_models: concurrent loaded models /
 * sub-agents) × num_parallel (server-side concurrent-prompt slots per load).
 * LM Studio's native load honors only the `parallel` key (CP-1 probe) and
 * defaults to 4 slots when unset; 4 slots multiply KV-cache memory ×4, so
 * constrained tiers force (1,1) and 4-slot combos stay opt-in. A tier whose
 * `allowedPairs` is empty is forced — a user override is rejected.
 */
export type ConcurrencyPair = {
  /** Concurrent loaded models / sub-agents (process capacity). */
  max_parallel_models: number;
  /** Server-side prompt slots for each load (LM Studio `parallel`). */
  num_parallel: number;
};

export const VRAM_TIERS = [
  {
    minVramGb: 0,
    label: "baseline",
    mode: "sequential" as const,
    maxParamsGuidance: "<= ~8B at Q4",
    recommendedMaxParamsB: 8,
    /** Forced (1,1): one model, one prompt slot. No override allowed. */
    maxParallelModels: 1,
    numParallel: 1,
    allowedPairs: [] as ConcurrencyPair[],
  },
  {
    minVramGb: 6,
    label: "mid",
    mode: "sequential" as const,
    maxParamsGuidance: "up to ~14B",
    recommendedMaxParamsB: 14,
    /** Forced (1,1): one model, one prompt slot. No override allowed. */
    maxParallelModels: 1,
    numParallel: 1,
    allowedPairs: [] as ConcurrencyPair[],
  },
  {
    minVramGb: 12,
    label: "high",
    mode: "parallel" as const,
    maxParamsGuidance: "larger single-model ceiling",
    recommendedMaxParamsB: 34,
    /** Default (2,2). Only (2,2) is allowed on this tier. */
    maxParallelModels: 2,
    numParallel: 2,
    allowedPairs: [
      { max_parallel_models: 2, num_parallel: 2 },
    ] as ConcurrencyPair[],
  },
  {
    minVramGb: 24,
    label: "ultra",
    mode: "parallel" as const,
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
    ] as ConcurrencyPair[],
  },
] as const;

export interface VramTier {
  minVramGb: number;
  label: string;
  mode: "sequential" | "parallel";
  maxParamsGuidance: string;
  /** Hard ceiling for guardrail filtering of candidate models (Phase 9). */
  recommendedMaxParamsB: number;
  /** Default process capacity for this tier (first half of the pair). */
  maxParallelModels: number;
  /** Default num_parallel slots for this tier (second half of the pair). */
  numParallel: number;
  /** Pairs a user override may select; empty = forced (override rejected). */
  allowedPairs: ConcurrencyPair[];
}

export function tierForVram(vramGb: number): VramTier {
  let selected: VramTier = VRAM_TIERS[0] as unknown as VramTier;
  for (const tier of VRAM_TIERS) {
    if (vramGb >= tier.minVramGb) selected = tier as unknown as VramTier;
  }
  return selected;
}

/** The tier's default concurrency pair (what a load sends absent an override). */
export function defaultPairForVram(vramGb: number): ConcurrencyPair {
  const tier = tierForVram(vramGb);
  return { max_parallel_models: tier.maxParallelModels, num_parallel: tier.numParallel };
}

/** Pairs a user may override to on this tier. Empty = forced (1,1), no override. */
export function allowedPairsForVram(vramGb: number): ConcurrencyPair[] {
  return [...tierForVram(vramGb).allowedPairs];
}

export function pairIsSequential(pair: ConcurrencyPair): boolean {
  return pair.max_parallel_models === 1 && pair.num_parallel === 1;
}

export function pairKey(pair: ConcurrencyPair): string {
  return `${pair.max_parallel_models}x${pair.num_parallel}`;
}

export function pairAllowedOnTier(vramGb: number, pair: ConcurrencyPair): boolean {
  return allowedPairsForVram(vramGb).some(
    (p) => p.max_parallel_models === pair.max_parallel_models && p.num_parallel === pair.num_parallel,
  );
}

/**
 * Advisory context-length ceiling per VRAM tier for a single loaded instance.
 * Aligned with VRAM_TIERS: on a baseline 4GB/16GB box LM Studio CPU-offloads
 * ~16K contexts fine, so sub-6GB caps at 16384 rather than clipping the
 * default regimen's 16K judge units; the ceiling only bounds pathological
 * over-recommendations above what the box has been observed to honor.
 */
const VRAM_CONTEXT_CEILINGS: Array<{ minVramGb: number; ceiling: number }> = [
  { minVramGb: 0, ceiling: 16_384 },
  { minVramGb: 6, ceiling: 16_384 },
  { minVramGb: 12, ceiling: 32_768 },
  { minVramGb: 24, ceiling: Number.POSITIVE_INFINITY },
];

export function contextCeilingForVram(vramGb: number): number {
  let ceiling: number = VRAM_CONTEXT_CEILINGS[0]!.ceiling;
  for (const tier of VRAM_CONTEXT_CEILINGS) {
    if (vramGb >= tier.minVramGb) ceiling = tier.ceiling;
  }
  return ceiling;
}
