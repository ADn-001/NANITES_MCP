/**
 * Live free-VRAM sampler.
 *
 * Phase B's live probe established that this LM Studio build surfaces NO live
 * VRAM: listModels carries no VRAM field and /system/vram, /system/memory, and
 * /system/gpu all 404. Until a real source exists this returns null so health
 * tiering falls back to the profile's static machine-spec tier plus a recorded
 * note — never a fabricated VRAM number. A future probe that finds a surface
 * swaps in behind this same seam.
 */
export interface LiveVramSample {
  /** Free VRAM in GB, or null when no surface exposes it. */
  free_vram_gb: number | null;
  /** Which surface produced the sample ("static" when none exists yet). */
  source: "static" | string;
}

export async function sampleLiveFreeVram(): Promise<LiveVramSample> {
  return { free_vram_gb: null, source: "static" };
}
