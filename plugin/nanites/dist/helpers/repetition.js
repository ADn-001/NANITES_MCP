const MIN_UNIT = 8;
const MAX_UNIT = 96;
const MIN_REPEATS = 4;
/** Minimum characters in a run before it is considered at all. */
const MIN_REPEATED_CHARS = 80;
/** The run must cover at least this share of the reply to justify cutting. */
const MIN_TAIL_FRACTION = 0.35;
/** Similarity below this means the repeats are drifting, i.e. degeneration. */
/**
 * True when a unit looks like structured data rather than a stuck loop:
 * a markdown table row, a CSV record, an indented code line, a list item.
 */
function looksStructured(unit) {
    if (unit.includes("|"))
        return true;
    if (/^\s*[A-Za-z0-9_."']+,(?:[^,]*,)+[^,]*\s*$/.test(unit))
        return true;
    // A unit can span a line break, so an indented line ANYWHERE in it is a
    // code block, not a stuck loop. Testing only the start misses the common case
    // where the unit begins with a prose line and continues into indented code.
    if (/^\s{2,}\S/m.test(unit))
        return true;
    // Two or more spaces then a non-space: requiring a trailing \s would demand
    // three or more columns, which a two-space code block never has.
    if (/^\s*[-*+]\s/.test(unit))
        return true;
    return false;
}
/** Cheap character-bigram similarity, in [0, 1]. */
function lineStart(text, index) {
    const nl = text.lastIndexOf(String.fromCharCode(10), index);
    return nl < 0 ? 0 : nl + 1;
}
/**
 * Find the longest repeating tail, or null. See the file header for why the
 * thresholds are what they are.
 */
export function findRepetitionTail(text) {
    if (text.length < MIN_REPEATED_CHARS)
        return null;
    let best = null;
    const maxUnit = Math.min(MAX_UNIT, Math.floor(text.length / 2));
    for (let p = MIN_UNIT; p <= maxUnit; p++) {
        const unit = text.slice(text.length - p);
        if (looksStructured(unit))
            continue;
        let count = 0;
        let pos = text.length - p;
        while (pos >= 0 && text.slice(pos, pos + p) === unit) {
            count++;
            pos -= p;
        }
        if (count < MIN_REPEATS)
            continue;
        const repeatedLen = count * p;
        if (repeatedLen < MIN_REPEATED_CHARS)
            continue;
        // The run must be a real share of the reply. Otherwise cutting it costs
        // more content than the loop costs the caller.
        if (repeatedLen < text.length * MIN_TAIL_FRACTION)
            continue;
        if (!best || repeatedLen > best.repeatCount * best.unit.length) {
            // Never let the line-boundary snap consume the whole reply. On a
            // single-line degeneration lineStart returns 0, which would truncate the
            // answer to an empty string — the exact H2 failure. If the snapped cut
            // would leave less than a fifth of the text, cut at the raw index
            // instead and accept a mid-line boundary.
            const snapped = lineStart(text, pos + p);
            const raw_ = pos + p;
            best = {
                startIndex: snapped > text.length * 0.2 ? snapped : raw_,
                unit,
                repeatCount: count,
            };
        }
    }
    // No drift veto here. Requiring the text before the run to resemble the unit
    // dismissed genuine degenerations that follow any prefix at all ("Result: "),
    // cutting the whole reply to an empty string, which is the very failure this
    // rewrite exists to prevent. The guards that matter are the length minimum, the
    // repeat count, the share-of-reply floor, the structured-content skip, and the
    // line-boundary cut.
    return best;
}
