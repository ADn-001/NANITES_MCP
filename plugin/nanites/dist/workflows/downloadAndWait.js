/**
 * Workflow #4 download half: ask LM Studio to download a model, then poll
 * get_download_status with exponential backoff (never a tight loop) until the
 * job reaches a terminal state. Backoff timings are recorded so tests can
 * assert they increase, and the actual sleep is injectable so gates don't wait
 * real seconds. A job that never terminates gives up after a configurable poll
 * ceiling rather than polling forever.
 */
import { NanitesError } from "../helpers/errors.js";
import { clientForProfile } from "../tools/deps.js";
import { ensureHealthy } from "./guard.js";
export async function downloadAndWait(deps, profileName, source, opts = {}) {
    await ensureHealthy(profileName, deps, opts);
    const profile = deps.profiles.getProfile(profileName);
    if (!profile) {
        throw new NanitesError({ code: "profile_not_found", message: `No profile named "${profileName}"`, retryable: false });
    }
    const client = clientForProfile(profile, opts.clientTimeoutMs ? { timeoutMs: opts.clientTimeoutMs } : undefined);
    const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const baseBackoffMs = opts.baseBackoffMs ?? 1000;
    const multiplier = opts.backoffMultiplier ?? 2;
    const maxPolls = opts.maxPolls ?? 30;
    const start = await client.downloadModel({ model: source, ...(opts.quantization ? { quantization: opts.quantization } : {}) });
    // Already downloaded -> nothing to wait on.
    if (start.status === "already_downloaded") {
        return { source, quantization: opts.quantization ?? null, status: "completed", job_id: null, polls: 0, backoffs: [] };
    }
    const jobId = start.job_id;
    if (!jobId) {
        // No job id to poll; report the immediate status (or gave_up for a
        // non-terminal one we can't track).
        return {
            source,
            quantization: opts.quantization ?? null,
            status: start.status === "downloading" ? "gave_up" : start.status,
            job_id: null,
            polls: 0,
            backoffs: [],
        };
    }
    const backoffs = [];
    for (let poll = 1; poll <= maxPolls; poll++) {
        const status = await client.getDownloadStatus(jobId);
        backoffs.push(poll === 1 ? 0 : Math.round(baseBackoffMs * multiplier ** (poll - 2)));
        if (status.status === "completed" || status.status === "failed" || status.status === "paused") {
            return {
                source,
                quantization: opts.quantization ?? null,
                status: status.status,
                job_id: jobId,
                polls: poll,
                backoffs,
                downloaded_bytes: status.downloaded_bytes,
                total_size_bytes: status.total_size_bytes,
            };
        }
        await sleep(backoffs[backoffs.length - 1]);
    }
    return { source, quantization: opts.quantization ?? null, status: "gave_up", job_id: jobId, polls: maxPolls, backoffs };
}
