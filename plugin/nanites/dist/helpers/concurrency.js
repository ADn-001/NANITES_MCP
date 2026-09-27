/**
 * Concurrency-hardening gate constants + load-body helpers.
 *
 * CP-1 probe (scripts/live-probe-parallel.mjs, 2026-09-05): the native
 * POST /api/v1/models/load zod-rejects `num_parallel` and nested
 * `load_config.num_parallel` (unrecognized_keys, HTTP 400) but honors the
 * `parallel` key, and the value round-trips into `loaded_instances[].config.parallel`.
 * Unparameterized loads default to 4 slots. So every Nanites-initiated load
 * sends `parallel: <profile.concurrency.num_parallel>` (1 on forced sequential
 * tiers) through this single gate. If a future LM Studio build changes the key
 * (or drops it), edit only this constant — call sites never name the key.
 */
export const LOAD_NUMPARALLEL_KEY = "parallel";
/** The `parallel` body member to attach, or an empty object when the gate is off. */
export function concurrencyLoadExtras(numParallel) {
    return LOAD_NUMPARALLEL_KEY ? { parallel: numParallel } : {};
}
