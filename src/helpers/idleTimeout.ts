/**
 * Idle/rolling timeout defaults (Phase B). Single module so no call site
 * inlines a duration (mirrors the guardrail-constants precedent, CLAUDE.md §4).
 *
 * Semantics (docs/nanites-systemic-fixes-spec.md Phase B): the kill signal is
 * IDLE, not total elapsed time. A generation that keeps emitting tokens is
 * never killed by the planner's fixed budget; that budget survives only as a
 * raised soft ceiling (belt-and-suspenders). The model-load wait is likewise
 * idle-based (heartbeat reachability), not a blind fixed ceiling.
 */
/** Kill a generation only after this long with zero new streamed events. */
export const GENERATION_IDLE_TIMEOUT_MS = 30_000;

/** Poll cheap reachability during a blocking load every this many ms. */
export const LOAD_HEARTBEAT_INTERVAL_MS = 2_000;

/** Kill an in-flight blocking load when the endpoint is silent this long. */
export const LOAD_HEARTBEAT_IDLE_MS = 30_000;

/**
 * The planner's `generation_timeout_ms` (and any explicit client timeout) is
 * kept as an overall ceiling only, raised by this factor so it does not fire
 * on slow-but-alive runs. Idle does the real killing.
 */
export const SOFT_CEILING_MULT = 4;
