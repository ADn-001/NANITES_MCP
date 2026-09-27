/**
 * Job runner — Phase C. The SQLite `jobs` table is the queue; this dispatcher
 * is the drain. It claims queued jobs FIFO and runs each kind's registered
 * handler (the existing blocking workflow call), respecting the owning
 * profile's concurrency tier via one shared in-process SubAgentPool per
 * profile: a job whose profile is at capacity stays queued instead of erroring
 * `concurrency_limit`. Blocking callers keep the hard-refuse semantics — this
 * enqueue path is job-mode only. One runner per ToolDeps (cached in a
 * WeakMap), so background completions release slots to the same pool the
 * enqueuer reserved.
 */
import { randomUUID } from "node:crypto";
import { runSubAgent } from "./runSubAgent.js";
import { runBtwCompactJob } from "./btwChat.js";
import { SubAgentPool } from "./subAgentPool.js";
import { HEARTBEAT_INTERVAL_MS } from "./jobRecovery.js";
/** Hard ceiling on one job. A model chat has its own timeout; this is the
 * backstop for a handler that never returns at all. */
const JOB_TIMEOUT_MS = 15 * 60_000;
import { NanitesError } from "../helpers/errors.js";
async function runSubAgentJob(deps, profileName, payload) {
    const p = payload;
    return runSubAgent(deps, profileName, p.brief, {
        roles: p.roles,
        model_id: p.model_id,
        provider: p.provider,
        task: p.task,
        effort: p.effort,
        outputSchema: p.output_schema,
        outputSchemaName: p.output_schema_name,
    });
}
export class JobRunner {
    deps;
    handlers = new Map();
    pools = new Map();
    pending = false;
    /** Identity of this process in the jobs table; see jobRecovery.ts. */
    ownerId = randomUUID();
    heartbeat = null;
    constructor(deps) {
        this.deps = deps;
        this.register("sub_agent", runSubAgentJob);
        // Phase H: `/nanites-btw` compaction runs on the same FIFO so it never
        // preempts a running real job (§9) — it waits for a free slot like any
        // other job-mode kind.
        this.register("btw_compact", runBtwCompactJob);
        // Construction deliberately does NOT drain. A previous process's queue is
        // recovered by sweepOrphanedJobs at boot, which can tell a job worth
        // resuming from a stale one; blindly draining here re-ran yesterday's
        // briefs. enqueue() schedules for this process's own work.
        this.heartbeat = setInterval(() => {
            try {
                this.store.touchRunning(this.ownerId);
            }
            catch {
                // A failed heartbeat must never crash the run it is reporting on; the
                // job's own completion or the next boot sweep settles the row.
            }
        }, HEARTBEAT_INTERVAL_MS);
        this.heartbeat.unref?.();
    }
    register(kind, handler) {
        this.handlers.set(kind, handler);
    }
    get store() {
        return this.deps.jobs;
    }
    /** Insert a queued job and kick the drain. Returns the job's FIFO id. */
    enqueue(input) {
        const id = this.store.create(input);
        this.schedule();
        return id;
    }
    /** One scheduled drain per tick; a freed slot re-schedules via run()'s finally. */
    schedule() {
        if (this.pending)
            return;
        this.pending = true;
        queueMicrotask(() => {
            this.pending = false;
            try {
                this.drain();
            }
            catch (err) {
                // A store throw here would otherwise be an unhandled rejection (fatal
                // in Node >=15) and would strand every later job in this batch, since
                // nothing re-schedules once the microtask has run.
                console.error("nanites: job drain failed", err);
            }
        });
    }
    /**
     * Synchronous sweep over the oldest queued jobs: start every one whose kind
     * is registered and whose profile still has a free slot. A job whose profile
     * is at capacity is left queued (FIFO preserved) and picked up when a slot
     * frees. Node's single thread makes the whole sweep atomic.
     */
    drain() {
        const queued = this.store.listQueued();
        for (const job of queued) {
            if (job.status !== "queued")
                continue;
            const handler = this.handlers.get(job.kind);
            if (!handler) {
                this.store.markError(job.id, {
                    code: "unknown_job_kind",
                    message: `No runner registered for job kind "${job.kind}"`,
                    retryable: false,
                });
                continue;
            }
            const pool = this.poolFor(job.profile_name);
            if (!pool.tryAcquire())
                continue; // profile at capacity -> stays queued
            if (!this.store.markRunning(job.id, this.ownerId)) {
                pool.release(); // claimed elsewhere (another process) — not ours to run
                continue;
            }
            void this.run(job, handler, pool);
        }
    }
    poolFor(profileName) {
        const existing = this.pools.get(profileName);
        if (existing) {
            // Capacity changes when the profile is edited, so a pool sized at first
            // use would keep the OLD limit for the life of the process.
            const profile = this.deps.profiles.getProfile(profileName);
            const wanted = profile?.concurrency?.max_parallel_models ?? 1;
            if (existing.maxCapacity !== wanted) {
                const resized = new SubAgentPool(wanted);
                this.pools.set(profileName, resized);
                return resized;
            }
            return existing;
        }
        const profile = this.deps.profiles.getProfile(profileName);
        const capacity = profile?.concurrency?.max_parallel_models ?? 1;
        const pool = new SubAgentPool(capacity);
        this.pools.set(profileName, pool);
        return pool;
    }
    async run(job, handler, pool) {
        try {
            // A hung handler holds its pool slot and its running row forever, and
            // the heartbeat keeps that row looking alive, so the boot-time sweep
            // never reclaims it — only a restart would. Race the
            // handler against a ceiling; the loser marks the job errored and
            // releases the slot.
            const watchdog = new Promise((_, reject) => {
                const t = setTimeout(() => reject(new NanitesError({
                    code: "job_timeout",
                    message: `Job ${job.kind} exceeded ${Math.round(JOB_TIMEOUT_MS / 1000)}s`,
                    retryable: false,
                })), JOB_TIMEOUT_MS);
                t.unref?.();
            });
            const result = await Promise.race([handler(this.deps, job.profile_name, job.payload), watchdog]);
            this.store.markDone(job.id, result);
        }
        catch (err) {
            const shape = err instanceof NanitesError
                ? err.toShape()
                : { code: "job_failed", message: err instanceof Error ? err.message : String(err), retryable: false };
            this.store.markError(job.id, shape);
        }
        finally {
            pool.release();
            this.schedule(); // a slot freed — try to start the next queued job
        }
    }
}
const runners = new WeakMap();
/** One runner per dependency bundle (i.e. per server process / per test harness). */
export function getRunner(deps) {
    let runner = runners.get(deps);
    if (!runner) {
        runner = new JobRunner(deps);
        runners.set(deps, runner);
    }
    return runner;
}
/** Queue a sub-agent job. Returns its id immediately; execution is async. */
export function startSubAgentJob(deps, args) {
    const profile = deps.profiles.getProfile(args.profile);
    if (!profile) {
        throw new NanitesError({ code: "profile_not_found", message: `No profile named "${args.profile}"`, retryable: false });
    }
    return getRunner(deps).enqueue({
        kind: "sub_agent",
        profile_name: args.profile,
        payload: {
            brief: args.brief,
            roles: args.roles,
            model_id: args.model_id,
            provider: args.provider,
            task: args.task,
            effort: args.effort,
            output_schema: args.output_schema,
            output_schema_name: args.output_schema_name,
        },
    });
}
/** Queue a `/nanites-btw` compaction job. Returns its id immediately. */
export function startBtwCompactJob(deps, args) {
    const profile = deps.profiles.getProfile(args.profile);
    if (!profile) {
        throw new NanitesError({ code: "profile_not_found", message: `No profile named "${args.profile}"`, retryable: false });
    }
    return getRunner(deps).enqueue({
        kind: "btw_compact",
        profile_name: args.profile,
        payload: { messages: args.messages, idle_timeout_ms: args.idle_timeout_ms, clientTimeoutMs: args.clientTimeoutMs },
    });
}
export function getSubAgentJobStatus(deps, jobId) {
    const job = deps.jobs.get(jobId);
    if (!job) {
        throw new NanitesError({ code: "job_not_found", message: `No job with id ${jobId}`, retryable: false });
    }
    return { job_id: job.id, status: job.status, ...(job.result !== null ? { result: job.result } : {}) };
}
