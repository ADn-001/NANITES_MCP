/** Owner heartbeat cadence. Must stay well under HEARTBEAT_STALE_MS. */
export const HEARTBEAT_INTERVAL_MS = 15_000;
/**
 * A run whose heartbeat stopped this long ago is considered dead. Generous
 * relative to the interval so a busy event loop (a synchronous tool call, a GC
 * pause) cannot make a live owner look dead.
 */
export const HEARTBEAT_STALE_MS = 60_000;
/** Queued jobs older than this are stale work from a previous session. */
export const QUEUE_TTL_MS = 6 * 60 * 60 * 1000;
/**
 * Boot-time queue sweep. `ownerId` is the sweeping process's identity; an
 * empty string means "this process owns nothing yet", which is the case at
 * boot — nothing has been claimed, so any stale `running` row is an orphan.
 */
export function sweepOrphanedJobs(deps, opts) {
    const now = opts?.now ?? new Date();
    const staleBefore = new Date(now.getTime() - HEARTBEAT_STALE_MS).toISOString();
    const queueCutoff = new Date(now.getTime() - QUEUE_TTL_MS).toISOString();
    const ownerId = opts?.ownerId ?? "";
    const orphaned = deps.jobs.reclaimStaleRunning(staleBefore, ownerId);
    const expired = deps.jobs.expireStaleQueued(queueCutoff);
    return { orphaned, expired };
}
