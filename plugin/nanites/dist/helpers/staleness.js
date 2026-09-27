/**
 * Informational staleness signal for registry entries. An entry whose
 * `last_tested` is older than the threshold gets a human note on the
 * read_registry surface — a flag only, never an automatic re-test. Re-testing
 * stays a user decision.
 */
export const STALE_AFTER_DAYS = 30;
const DAY_MS = 86_400_000;
/** Pure: last_tested in, flag + note out. `now` injectable for tests. */
export function stalenessFor(lastTested, now = Date.now(), staleAfterDays = STALE_AFTER_DAYS) {
    if (!lastTested) {
        return { stale: false, staleness_note: null };
    }
    const testedMs = Date.parse(lastTested);
    if (Number.isNaN(testedMs)) {
        // Unparseable timestamp: don't cry staleness on bad data, just stay silent.
        return { stale: false, staleness_note: null };
    }
    const ageMs = now - testedMs;
    if (ageMs < 0 || ageMs < staleAfterDays * DAY_MS) {
        return { stale: false, staleness_note: null };
    }
    const days = Math.floor(ageMs / DAY_MS);
    return {
        stale: true,
        staleness_note: `last tested ${days} days ago (over the ${staleAfterDays}-day staleness threshold); ` +
            `no automatic re-test — re-testing is a user decision`,
    };
}
