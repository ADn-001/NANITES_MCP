/**
 * LM Studio health check: endpoint reachability (with a one-shot `lms server
 * start` autostart recovery + recheck), free disk space for downloads, and
 * stuck-loaded-model detection. All deterministic — the caller is never asked
 * to reason about health.
 */
import { statfsSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { effectiveGuardrailAdvice } from "../guardrails/advisor.js";
export const DISK_LOW_THRESHOLD_GB = 5;
const DEFAULT_RECOVERY_WAIT_MS = 3_000;
/** Ceiling on the `lms server start` spawn, which may not exit. */
const RECOVERY_SPAWN_TIMEOUT_MS = 10_000;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
/** Best-effort `lms server start` — detached, non-blocking, never throws. */
export function defaultRecovery() {
    return {
        run: async () => {
            await new Promise((resolve) => {
                // Bounded: an `lms` that daemonizes without exiting would otherwise
                // block the MCP boot path forever, and there is no outer timeout on
                // runHealthCheck.
                const timer = setTimeout(() => resolve(), RECOVERY_SPAWN_TIMEOUT_MS);
                timer.unref?.();
                try {
                    const child = spawn("lms", ["server", "start"], { stdio: "ignore", detached: true });
                    child.on("error", () => { clearTimeout(timer); resolve(); });
                    child.on("exit", () => { clearTimeout(timer); resolve(); });
                    child.unref?.();
                }
                catch {
                    clearTimeout(timer);
                    resolve();
                }
            });
        },
        waitMs: DEFAULT_RECOVERY_WAIT_MS,
    };
}
/**
 * Where to measure free space. `NANITES_LMSTUDIO_MODELS_DIR` wins so the number
 * is measured on the volume the models actually live on — on Windows the temp
 * dir is routinely a different physical disk from the model drive, so the
 * fallback can report a healthy volume while downloads to the real one fail
 *.
 */
export function defaultDiskDir() {
    const configured = process.env.NANITES_LMSTUDIO_MODELS_DIR?.trim();
    if (configured)
        return configured;
    const models = path.join(os.homedir(), ".lmstudio", "models");
    return existsSync(models) ? models : os.tmpdir();
}
export async function runHealthCheck(opts) {
    const { client } = opts;
    let reachable = false;
    try {
        await client.listModels();
        reachable = true;
    }
    catch {
        // unreachable or slow
    }
    let recovery_attempted = false;
    let recovery_succeeded = null;
    if (!reachable) {
        const recovery = opts.recovery ?? defaultRecovery();
        // Set only once the step has actually been invoked. Assigning it before
        // the call meant a NOOP injection (tests, the UI path) still reported an
        // autostart attempt, and the reason string said "unreachable after
        // autostart attempt" when none was made.
        recovery_attempted = true;
        // Bound the injected step too, not just the default spawn: a recovery that
        // never settles would otherwise hang the caller — and this sits on the MCP
        // boot path.
        await Promise.race([recovery.run().catch(() => { }), delay(RECOVERY_SPAWN_TIMEOUT_MS)]);
        if (recovery.waitMs > 0)
            await new Promise((resolve) => setTimeout(resolve, recovery.waitMs));
        try {
            await client.listModels();
            reachable = true;
            recovery_succeeded = true;
        }
        catch {
            recovery_succeeded = false;
        }
    }
    const threshold = opts.disk?.lowThresholdGb ?? DISK_LOW_THRESHOLD_GB;
    let availableGb;
    let diskSource;
    if (opts.disk?.availableGb !== undefined) {
        availableGb = opts.disk.availableGb;
        diskSource = "injected";
    }
    else {
        try {
            const stats = statfsSync(opts.disk?.dir ?? defaultDiskDir());
            availableGb = (Number(stats.bavail) * Number(stats.bsize)) / 1e9;
            diskSource = "measured";
        }
        catch {
            availableGb = NaN; // unmeasurable -> don't claim low
            diskSource = "unmeasurable";
        }
    }
    // An unmeasurable volume must never read as "low": NaN < threshold is false,
    // but a NaN that later round-trips through the report is worse than saying
    // nothing, so it is coerced to a "plenty" sentinel and flagged as unknown.
    if (diskSource === "unmeasurable")
        availableGb = Number.POSITIVE_INFINITY;
    const diskLow = availableGb < threshold;
    let loaded_models = [];
    let stuck_models = [];
    if (reachable) {
        try {
            const { models } = await client.listModels();
            loaded_models = models.filter((m) => m.loaded_instances.length > 0).map((m) => m.key);
            // "Stuck" heuristic: a loaded instance with no load config (or one
            // missing context_length) — the API reports it loaded but wedged.
            stuck_models = models
                .filter((m) => m.loaded_instances.length > 0 &&
                m.loaded_instances.some((i) => !i.config || typeof i.config.context_length !== "number"))
                .map((m) => m.key);
        }
        catch {
            // reachability already decided above; leave lists empty
        }
    }
    const checks = {
        endpoint: reachable ? "ok" : "unreachable",
        disk: diskLow ? "low" : "ok",
        loaded: stuck_models.length > 0 ? "stuck" : "ok",
    };
    const overall = !reachable ? "down" : diskLow || stuck_models.length > 0 ? "degraded" : "healthy";
    const reasons = [];
    reasons.push(!reachable
        ? recovery_attempted
            ? "endpoint unreachable after autostart attempt"
            : "endpoint unreachable"
        : recovery_succeeded
            ? "endpoint recovered via autostart"
            : "endpoint reachable");
    if (diskLow)
        reasons.push(`free disk below ${threshold}GB threshold`);
    if (stuck_models.length > 0)
        reasons.push(`stuck-loaded models: ${stuck_models.join(", ")}`);
    const report = {
        profile: opts.profile,
        overall,
        reachable,
        recovery_attempted,
        recovery_succeeded,
        disk: {
            available_gb: diskSource === "unmeasurable" ? null : Number(availableGb.toFixed(1)),
            low: diskLow,
            threshold_gb: threshold,
            source: diskSource,
        },
        loaded_models,
        stuck_models,
        checks,
        reason: reasons.join("; "),
    };
    if (opts.hardware) {
        report.guardrail_tier = effectiveGuardrailAdvice({ vram_gb: opts.hardware.vram_gb }, opts.hardware.live_free_vram_gb ?? null);
    }
    return report;
}
