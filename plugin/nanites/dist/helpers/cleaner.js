/**
 * Reply validator/cleaner. Strips known local-model artifacts and flags what
 * was removed so the caller knows something changed. Clean input passes
 * through byte-identical with `cleaned: false` and no issues.
 */
import { findRepetitionTail } from "./repetition.js";
// Chat-template tokens that leak from local models despite instruction tuning.
// `<|im_start|>` is usually followed immediately by a role word ("assistant"),
// which must be consumed together or the role label leaks into the output.
// The second group is OpenAI's harmony format (gpt-oss on Cloudflare Workers
// AI); it reached the orchestrator as raw text with `cleaned: false` on a live
// run, against the reply-sanitization rules.
const TEMPLATE_TOKEN_RE = /<\|im_(?:start|end)\|>(?:system|user|assistant)?|<\|(?:endoftext|begin_of_text|end_of_text)\|>|<\|(?:channel|start|call|end|message|constrain)\|>|<\/?(?:s|assistant|system|user)>|###\s*(?:Human|Assistant|System|User):|\[INST\]|\[\/INST\]|\]\s*<\/s>/gi;
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const THINK_BLOCK_RE = /<think>[\s\S]*?<\/think>/gi;
const THINK_MARKER_RE = /<\/?think>/gi;
/**
 * An UNCLOSED <think> matches neither regex above, so the entire reasoning
 * dump survived into the reply, which is exactly the leakage the section 6
 * sanitization rules exist to prevent. Truncation mid-reasoning makes this
 * more likely, not less, and cleanReply is capped at 100k chars upstream
 *.
 */
const THINK_UNCLOSED_RE = /<think[\s\S]*$/i;
const JSON_FENCE_RE = /```(?:json)?\s*([\s\S]*?)\s*```/i;
export function cleanReply(raw, options = {}) {
    const issues = [];
    let text = raw;
    // 1. Reasoning/think-tag leakage.
    const thinkBlocks = text.match(THINK_BLOCK_RE);
    if (thinkBlocks && thinkBlocks.length > 0) {
        text = text.replace(THINK_BLOCK_RE, "");
        issues.push("think_tag_stripped");
    }
    // Order matters. The marker strip removes the opening <think> before the
    // unclosed check runs, so the tag is already gone and there is nothing left
    // to detect. Check for an unclosed block FIRST, then strip the leftovers.
    if (THINK_UNCLOSED_RE.test(text)) {
        text = text.replace(THINK_UNCLOSED_RE, "");
        issues.push("think_unclosed_stripped");
    }
    if (THINK_MARKER_RE.test(text)) {
        text = text.replace(THINK_MARKER_RE, "");
        issues.push("think_marker_stripped");
    }
    // 2. Chat-template artifact leakage.
    if (TEMPLATE_TOKEN_RE.test(text)) {
        // Collapse only runs of spaces and tabs WITHIN a line. The old
        // regex also matched newlines, so any reply that leaked a template token
        // lost every paragraph break, table row separator and code indent, and
        // it ran before the repetition check, so it could also manufacture the
        // whitespace runs that changed what the tail looked like.
        text = text.replace(TEMPLATE_TOKEN_RE, "");
        text = text.replace(/[ \t]{2,}/g, " ").trim();
        issues.push("template_token_stripped");
    }
    // 3. Control characters.
    if (CONTROL_CHAR_RE.test(text)) {
        text = text.replace(CONTROL_CHAR_RE, "");
        issues.push("control_chars_stripped");
    }
    // 4. Repetition loop tail.
    const loop = findRepetitionTail(text);
    if (loop) {
        text = text.slice(0, loop.startIndex).trimEnd();
        issues.push("repetition_loop_truncated");
    }
    // 5. Block-scale repetition (prose degeneration).
    const block = findBlockRepetition(text);
    if (block) {
        text = text.slice(0, block.startIndex).trimEnd();
        issues.push(block.kind);
    }
    // 6. JSON repair-or-flag.
    const json = inspectJson(text);
    if (json.action === "extract") {
        text = json.output;
        issues.push("extraneous_text_stripped");
    }
    else if (json.action === "repaired") {
        text = json.output;
        issues.push("truncated_json_repaired");
    }
    else if (json.action === "flagged") {
        issues.push("malformed_json_flagged");
    }
    // 7. Hard length ceiling.
    if (options.maxChars && text.length > options.maxChars) {
        text = text.slice(0, options.maxChars);
        issues.push("length_truncated");
    }
    return { text, cleaned: issues.length > 0, issues };
}
/**
 * Heuristic JSON handling. Treats output as a JSON attempt when it begins
 * with `{` or `[` after stripping a code fence. Extraction: pull the JSON
 * out when wrapped in prose. Repair: balance braces/brackets when parse fails
 * due to truncation. Flag: leave untouched when unrepairable.
 */
export function inspectJson(text) {
    const trimmed = text.trim();
    const fence = trimmed.match(JSON_FENCE_RE);
    const candidate = fence ? fence[1].trim() : trimmed;
    if (!candidate.startsWith("{") && !candidate.startsWith("[")) {
        return { action: "none" };
    }
    if (tryParse(candidate)) {
        // Valid JSON, possibly wrapped in a fence or prose.
        if (fence || trimmed !== candidate) {
            return { action: "extract", output: candidate };
        }
        return { action: "none" };
    }
    const repaired = repairJson(candidate);
    if (repaired !== null) {
        return { action: "repaired", output: repaired };
    }
    return { action: "flagged" };
}
function tryParse(text) {
    try {
        JSON.parse(text);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Best-effort repair of a truncated JSON blob. Tries in order: balance as-is
 * (keeps complete values like `"age": 3`), then drop a trailing partial
 * token, then also drop a dangling `"key":` pair — returning the first
 * candidate that parses, else null.
 */
export function repairJson(raw) {
    const text = raw.trim();
    if (text.length === 0)
        return null;
    const attempts = [];
    attempts.push(balanceJson(text));
    const noPartial = text.replace(/(?:[\s'"]+)?[\w.-]+$/, "").trimEnd();
    if (noPartial !== text)
        attempts.push(balanceJson(noPartial));
    const noDanglingKey = noPartial.replace(/"[^"]*"\s*:\s*$/, "").trimEnd();
    if (noDanglingKey !== noPartial)
        attempts.push(balanceJson(noDanglingKey));
    for (const candidate of attempts) {
        try {
            JSON.parse(candidate);
            return candidate;
        }
        catch {
            // try next
        }
    }
    return null;
}
/** Lines in one block. Three is the smallest run that reads as prose rather
 * than as a duplicated line, which the token detector already handles. */
const BLOCK_LINES = 3;
/** Occurrences of the same block before it counts as degeneration. Emphasis
 * repeats a block twice; four non-overlapping copies is a stuck model. */
const BLOCK_MIN_REPEATS = 4;
/** Unique-line ratio below which the text is repeating itself. */
const NOVELTY_FLOOR = 0.35;
const MIN_CHARS_FOR_BLOCK = 600;
const MIN_CHARS_FOR_NOVELTY = 4_000;
const MIN_LINES_FOR_BLOCK = BLOCK_LINES * BLOCK_MIN_REPEATS;
const MIN_LINES_FOR_NOVELTY = 24;
/** Non-empty lines (trimmed) with their offsets; blank lines carry no signal
 * and would dilute the novelty ratio. */
function indexedLines(text) {
    const lines = [];
    let start = 0;
    for (let i = 0; i <= text.length; i++) {
        if (i !== text.length && text[i] !== "\n")
            continue;
        const trimmed = text.slice(start, i).trim();
        if (trimmed.length > 0)
            lines.push({ text: trimmed, start });
        start = i + 1;
    }
    return lines;
}
/**
 * Returns where the text begins repeating itself, or null. Checks a repeated
 * 3-line block first (precise, cheap), then the unique-line ratio (catches
 * degeneration that never repeats an exact block). Both cut at the same place:
 * the second occurrence — the first copy is real content, everything after it
 * is the loop.
 */
export function findBlockRepetition(text) {
    const lines = indexedLines(text);
    if (text.length >= MIN_CHARS_FOR_BLOCK && lines.length >= MIN_LINES_FOR_BLOCK) {
        const block = findRepeatedBlock(lines);
        if (block) {
            const cut = cutAtFirstRepeat(lines, block.first);
            return {
                startIndex: lines[cut].start,
                kind: "repeated_block",
                detail: `${BLOCK_LINES}-line block repeated ${block.count}x`,
            };
        }
    }
    if (text.length >= MIN_CHARS_FOR_NOVELTY && lines.length >= MIN_LINES_FOR_NOVELTY) {
        return findNoveltyCollapse(lines);
    }
    return null;
}
/**
 * The line that repeats something already read at or after `from` — where the
 * writing stops adding anything. Falls back to `from` when the repeat sat in
 * the prefix, so the result is never "no cut" for a tripped check.
 */
function cutAtFirstRepeat(lines, from) {
    const seen = new Set(lines.slice(0, from).map((l) => l.text));
    for (let i = from; i < lines.length; i++) {
        const text = lines[i].text;
        if (seen.has(text))
            return i;
        seen.add(text);
    }
    return from;
}
/** First line of the earliest block that repeats enough to count, with its
 * non-overlapping repeat count. */
function findRepeatedBlock(lines) {
    const starts = new Map();
    for (let i = 0; i + BLOCK_LINES <= lines.length; i++) {
        const key = lines
            .slice(i, i + BLOCK_LINES)
            .map((l) => l.text)
            .join("\n");
        const at = starts.get(key);
        if (at)
            at.push(i);
        else
            starts.set(key, [i]);
    }
    let best = null;
    for (const at of starts.values()) {
        // Non-overlapping count: a run of identical lines matches its own block at
        // every offset, which would inflate one block's count past the threshold.
        let count = 0;
        let lastEnd = -1;
        for (const s of at) {
            if (s < lastEnd)
                continue;
            count += 1;
            lastEnd = s + BLOCK_LINES;
        }
        if (count < BLOCK_MIN_REPEATS)
            continue;
        const first = at[0];
        if (!best || first < best.first)
            best = { first, count };
    }
    return best;
}
function findNoveltyCollapse(lines) {
    // Walk back once, counting lines as they enter the suffix: the earliest
    // suffix whose unique-line ratio is under the floor is where novelty dies.
    const counts = new Map();
    let unique = 0;
    let collapse = -1;
    for (let p = lines.length - 1; p >= 0; p--) {
        const key = lines[p].text;
        const seen = counts.get(key) ?? 0;
        counts.set(key, seen + 1);
        if (seen === 0)
            unique += 1;
        const length = lines.length - p;
        if (length >= MIN_LINES_FOR_NOVELTY && unique / length < NOVELTY_FLOOR)
            collapse = p;
    }
    if (collapse < 0)
        return null;
    const window = lines.length - collapse;
    const ratio = (new Set(lines.slice(collapse).map((l) => l.text)).size / window).toFixed(2);
    return {
        startIndex: lines[cutAtFirstRepeat(lines, collapse)].start,
        kind: "low_novelty",
        detail: `unique-line ratio ${ratio} over ${window} lines`,
    };
}
/** Append the closing braces/brackets for any unclosed openers. */
function balanceJson(text) {
    const closeFor = { "{": "}", "[": "]" };
    const openFor = { "}": "{", "]": "[" };
    const stack = [];
    for (const ch of text) {
        if (ch === "{" || ch === "[")
            stack.push(ch);
        else if (ch === "}" || ch === "]") {
            if (stack.length > 0 && stack[stack.length - 1] === openFor[ch])
                stack.pop();
        }
    }
    let out = text;
    while (stack.length > 0)
        out += closeFor[stack.pop()];
    return out;
}
