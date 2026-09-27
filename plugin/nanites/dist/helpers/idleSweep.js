import { clientForProfile } from "../tools/deps.js";
/** Default idle window before a held chat instance is swept (20 minutes). */
export const BTW_HOLD_IDLE_MS = 20 * 60_000;
/**
 * Sweep every profile's held chat (or just one when named). `windowMs`/`now`
 * are test seams. Returns after unloads have been issued (each best-effort).
 */
export async function sweepIdleBtwChats(deps, profileName, windowMs = BTW_HOLD_IDLE_MS, now = Date.now()) {
    const names = profileName ? [profileName] : deps.profiles.listProfiles();
    let unloaded = 0;
    let inspected = 0;
    for (const name of names) {
        const chat = deps.btwChat.get(name);
        if (!chat || !chat.instance_id)
            continue;
        inspected++;
        const last = Date.parse(chat.last_activity_at);
        if (!Number.isFinite(last))
            continue;
        if (last + windowMs > now)
            continue;
        const profile = deps.profiles.getProfile(name);
        if (!profile) {
            // The profile was deleted or renamed mid-sweep. Clearing
            // instance_id here would orphan a resident model that no later sweep
            // can reach by id, pinning VRAM — the exact thing this sweep exists to
            // prevent. Leave the row untouched and move on.
            continue;
        }
        if (profile) {
            const client = clientForProfile(profile);
            await client.unloadModel({ instance_id: chat.instance_id }).catch(() => { });
        }
        // The chat and its messages stay; only the instance handle is dropped so
        // the next turn reloads (§7 reconnection).
        deps.btwChat.set({
            ...chat,
            instance_id: null,
            last_activity_at: chat.last_activity_at,
        });
        unloaded++;
    }
    return { unloaded, inspected };
}
