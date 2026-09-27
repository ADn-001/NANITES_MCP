import { sendNtfy } from "./ntfy.js";
export function buildPush(kind, data) {
    switch (kind) {
        case "health_down":
            return {
                message: `Nanites ${data.profile}: health check failed — ${data.reason ?? data.message ?? "down"} (${data.code})`,
                tags: ["nanites", "down", "warning"],
            };
        case "regimen.start":
            return {
                message: `Nanites ${data.profile}: testing ${data.model_id}${data.provider ? ` via ${data.provider}` : ""} (${data.unit_count} units)...`,
                tags: ["nanites", "regimen", "start"],
            };
        case "regimen.end":
            return {
                message: `Nanites ${data.profile}: ${data.model_id} regimen done — ` +
                    `${data.deterministic_scored} deterministic scored, ${data.pending} pending judgment` +
                    `${(data.empty_failed ?? 0) > 0 ? `, ${data.empty_failed} empty-failed` : ""}` +
                    `${data.registered ? ", registry entry written" : ""}`,
                tags: ["nanites", "regimen", "end"],
            };
        case "regimen.error":
            return {
                message: `Nanites ${data.profile}: ${data.model_id} regimen FAILED (${data.code}): ${data.message}` +
                    `${data.detail ? ` — ${data.detail}` : ""}`,
                tags: ["nanites", "regimen", "error", "warning"],
            };
        case "sprint.start":
            return {
                message: `Nanites ${data.profile}: untested sweep starting — ${data.untested_count} model` +
                    `${data.untested_count === 1 ? "" : "s"}: ${(data.models ?? []).join(", ")}`,
                tags: ["nanites", "sweep", "start"],
            };
        case "sprint.end":
            return {
                message: `Nanites ${data.profile}: untested sweep done — ${data.tested} tested` +
                    `${(data.failures ?? 0) > 0 ? `, ${data.failures} failed` : ""}`,
                tags: ["nanites", "sweep", "end"],
            };
        case "sprint.abort":
            return {
                message: `Nanites ${data.profile}: untested sweep ABORTED (${data.code}): ${data.message}`,
                tags: ["nanites", "sweep", "error", "warning"],
            };
    }
}
export async function fireProfilePush(profile, kind, data, push = sendNtfy) {
    if (!profile.ntfy.topic)
        return;
    try {
        await push(profile.ntfy, buildPush(kind, data).message, buildPush(kind, data).tags);
    }
    catch {
        // Fire-and-forget contract: never let a failed push fail the operation.
    }
}
