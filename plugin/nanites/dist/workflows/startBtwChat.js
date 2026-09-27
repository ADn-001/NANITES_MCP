/**
 * `start_btw_chat` orchestration (btw-spec-v2 §4.1/§5/§6). The ONLY Claude-facing
 * tool `/nanites-btw` adds. Replaces the profile's `btw_chat` row (hard-deleting
 * the old visible transcript but NOT the compaction caches — §2/§3), enqueues the
 * compaction as an async `btw_compact` job on the Phase-C FIFO (so it can never
 * stall or eject a running real job — §9), and returns the deep link immediately.
 * When `initial_question` was given AND the job finishes inside the grace window,
 * the answer rides back inline; otherwise the dashboard surfaces it via its own
 * `/api/btw/state` polling once the job completes.
 */
import { NanitesError } from "../helpers/errors.js";
import { clientForProfile } from "../tools/deps.js";
import { configuredUiPort } from "../helpers/uiPort.js";
import { nowIso } from "../storage/db.js";
import { startBtwCompactJob } from "./jobRunner.js";
/** How long the tool waits (after enqueueing) for an inline answer (spec §4.1). */
export const START_BTW_CHAT_GRACE_MS = 5000;
/** Poll cadence while waiting inside the grace window. */
const JOB_POLL_MS = 25;
export function btwDeepLinkUrl(initialQuestion) {
    const port = configuredUiPort();
    const base = `http://127.0.0.1:${port}/#/vox-terminus?mode=btw&maximize=1`;
    const q = (initialQuestion ?? "").trim();
    return q === "" ? base : `${base}&q=${encodeURIComponent(q)}`;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Wait up to `graceMs` for the job to reach a terminal state. Null on timeout. */
async function awaitTerminal(deps, jobId, graceMs, pollMs) {
    const deadline = Date.now() + graceMs;
    for (;;) {
        const job = deps.jobs.get(jobId);
        if (!job) {
            throw new NanitesError({ code: "job_not_found", message: `No job with id ${jobId}`, retryable: false });
        }
        if (job.status === "done" || job.status === "error")
            return job;
        if (Date.now() >= deadline)
            return null;
        await sleep(pollMs);
    }
}
export async function startBtwChat(deps, args) {
    const profileName = args.profile ?? deps.profiles.getActiveProfile()?.name ?? "";
    const profile = profileName !== "" ? deps.profiles.getProfile(profileName) : null;
    if (!profile) {
        throw new NanitesError({
            code: "profile_not_found",
            message: args.profile
                ? `No profile named "${args.profile}"`
                : "No active profile set. Create a profile and switch to it before using /nanites-btw.",
            retryable: false,
        });
    }
    const now = nowIso();
    // Free the old chat's held instance (best-effort — it may already be evicted)
    // BEFORE the row is replaced, so a single-model machine isn't left holding two
    // loads while compaction runs.
    const prior = deps.btwChat.get(profileName);
    if (prior?.instance_id) {
        await clientForProfile(profile).unloadModel({ instance_id: prior.instance_id }).catch(() => { });
    }
    // Replace the visible chat (spec §3): the row is superseded and the throwaway
    // transcript is wiped; the compaction caches are left untouched (§2).
    deps.btwChat.set({
        profile_name: profileName,
        status: "compacting",
        job_id: null,
        model_id: null,
        instance_id: null,
        last_activity_at: now,
        created_at: now,
    });
    deps.btwChatMessages.replace(profileName, []);
    const jobId = startBtwCompactJob(deps, {
        profile: profileName,
        messages: args.messages ?? [],
        idle_timeout_ms: args.idle_timeout_ms,
        clientTimeoutMs: args.clientTimeoutMs,
    });
    deps.btwChat.set({
        ...deps.btwChat.get(profileName),
        job_id: String(jobId),
    });
    const deep_link_url = btwDeepLinkUrl(args.initial_question);
    // No question, or no time budget: return the deep link + job handle now; the
    // dashboard reconciles completion by its own polling (§8).
    const initial = (args.initial_question ?? "").trim();
    const graceMs = args.graceMs ?? START_BTW_CHAT_GRACE_MS;
    if (initial === "" || graceMs <= 0) {
        return { deep_link_url, job_id: jobId, status: "processing" };
    }
    const terminal = await awaitTerminal(deps, jobId, graceMs, args.pollMs ?? JOB_POLL_MS);
    if (terminal === null)
        return { deep_link_url, job_id: jobId, status: "processing" };
    if (terminal.status === "error") {
        const e = terminal.result;
        throw new NanitesError({
            code: e?.code ?? "btw_compact_failed",
            message: e?.message ?? "The /nanites-btw compaction job failed",
            retryable: e?.retryable ?? false,
            ...(e?.details !== undefined ? { details: e.details } : {}),
        });
    }
    const result = terminal.result;
    const cacheStatus = result?.compact?.cache_status;
    const answer = result?.answer?.reply;
    const out = {
        deep_link_url,
        job_id: jobId,
        status: "ready",
        ...(cacheStatus !== undefined ? { cache_status: cacheStatus } : {}),
    };
    if (answer)
        out.answer = answer;
    return out;
}
