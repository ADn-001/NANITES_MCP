/** t/s that saturates the speed component to 100. */
export const PERFECT_TPS = 40;
/** TTFT (ms) that drives the ttft component to 0. */
export const TTFT_FLOOR_MS = 3000;
/** Context window treated as "full" (no penalty). */
export const MAX_CONTEXT = 32768;
/** Score for a model with no logged runs yet (neutral default). */
export const NEUTRAL_SCORE = 50;
/** Load time (ms) that saturates the load penalty to its full 20 points. */
export const LOAD_FLOOR_MS = 30_000;
/** Dynamic load-timeout bounds + first-load default (no recorded history). */
export const LOAD_TIMEOUT_FLOOR_MS = 30_000;
export const LOAD_TIMEOUT_CEIL_MS = 300_000;
export const FIRST_LOAD_TIMEOUT_MS = 120_000;
/** Fixed buffer added to 3x the rolling average load time. */
export const LOAD_TIMEOUT_BUFFER_MS = 5_000;
function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}
/** Tokens per second for one run, or null when duration is unusable. */
export function tpsOf(run) {
    if (run.duration_ms == null || run.duration_ms <= 0)
        return null;
    return (run.tokens_in + run.tokens_out) / (run.duration_ms / 1000);
}
function avg(vals) {
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}
/** Average wall-clock load time (ms) over the runs that reported one, else null. */
export function avgLoadMs(runs) {
    const vals = runs.map((r) => r.load_ms).filter((v) => v != null);
    return vals.length ? avg(vals) : null;
}
/** Average generation time (ms) = total duration minus load time, else null. */
export function avgResponseMs(runs) {
    const vals = runs
        // Clamp at zero: load_ms is measured from before discovery and model
        // selection, so a slow load followed by a fast chat yields a negative
        // response time, which was then persisted to the registry and displayed
        //.
        .map((r) => (r.duration_ms != null && r.load_ms != null ? Math.max(0, r.duration_ms - r.load_ms) : null))
        .filter((v) => v != null);
    return vals.length ? avg(vals) : null;
}
/**
 * Next load's timeout: a generous default when a model has no recorded load
 * time yet, otherwise 3x the rolling average plus a buffer, clamped to sane
 * bounds so a known-fast model still trips quickly on a hang.
 */
export function loadTimeoutFor(avgLoad) {
    if (avgLoad == null)
        return FIRST_LOAD_TIMEOUT_MS;
    return clamp(avgLoad * 3 + LOAD_TIMEOUT_BUFFER_MS, LOAD_TIMEOUT_FLOOR_MS, LOAD_TIMEOUT_CEIL_MS);
}
export function scoreRuns(runs) {
    if (runs.length === 0)
        return NEUTRAL_SCORE;
    const tpsVals = runs.map(tpsOf).filter((v) => v !== null);
    const speedScore = clamp((avg(tpsVals) / PERFECT_TPS) * 100, 0, 100);
    // Absent TTFT data is treated as the floor (worst case), so an all-error
    // model lands at the 1 floor rather than being credited with a guess.
    const ttftVals = runs.map((r) => r.ttft_ms).filter((v) => v != null);
    const avgTtft = ttftVals.length ? avg(ttftVals) : TTFT_FLOOR_MS;
    const ttftScore = clamp((1 - avgTtft / TTFT_FLOOR_MS) * 100, 0, 100);
    const errorRate = runs.filter((r) => r.error_code != null && r.error_code !== "").length / runs.length;
    const stability = (1 - errorRate) * 100;
    const ctxVals = runs.map((r) => r.context_window).filter((v) => v != null);
    const avgCtx = ctxVals.length ? avg(ctxVals) : MAX_CONTEXT;
    const ctxPenalty = clamp((1 - avgCtx / MAX_CONTEXT) * 20, 0, 20);
    // Load-time penalty: slow-to-load models are penalized (like context width),
    // up to 20 points at LOAD_FLOOR_MS. No load data -> no penalty.
    const avgLoad = avgLoadMs(runs) ?? 0;
    const loadPenalty = clamp((avgLoad / LOAD_FLOOR_MS) * 20, 0, 20);
    const raw = 0.45 * speedScore + 0.25 * ttftScore + 0.3 * stability - ctxPenalty - loadPenalty;
    return Math.round(clamp(raw, 1, 100));
}
