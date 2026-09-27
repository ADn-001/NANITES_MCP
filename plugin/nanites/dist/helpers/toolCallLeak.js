const HARMONY_NAME = /to=functions\.([A-Za-z_][\w.-]*)/g;
const HARMONY_END = /<\|call\|>|<\|start\|>/;
/** Structural marker only — says "a call is in here", not "it parses". */
export function looksLikeLeakedToolCall(text) {
    if (!text)
        return false;
    if (text.includes("<tool_call>"))
        return true;
    return text.includes("to=functions.") && text.includes("<|call|>");
}
/** The dialect a leak is written in, or null when there is no leak. */
export function leakedToolCallDialect(text) {
    if (!text)
        return null;
    if (text.includes("to=functions.") && text.includes("<|call|>"))
        return "harmony";
    if (text.includes("<tool_call>"))
        return "tool_call";
    return null;
}
/**
 * Strict parse of every leaked call in `text`. Returns null when the dialect is
 * recognizable but any part of a call is missing, unbalanced, or not JSON where
 * JSON is required.
 */
export function parseLeakedToolCalls(text) {
    const dialect = leakedToolCallDialect(text ?? "");
    if (dialect === "harmony")
        return parseHarmony(text);
    if (dialect === "tool_call")
        return parseToolCallBlocks(text);
    return null;
}
/** Slice a complete JSON object starting at `from` (which must be "{"); null if unbalanced. */
function scanJsonObject(text, from) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = from; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (ch === "\\")
                escaped = true;
            else if (ch === '"')
                inString = false;
            continue;
        }
        if (ch === '"')
            inString = true;
        else if (ch === "{")
            depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0)
                return text.slice(from, i + 1);
        }
    }
    return null;
}
function parseArgsJson(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
function parseHarmony(text) {
    const calls = [];
    HARMONY_NAME.lastIndex = 0;
    let match;
    while ((match = HARMONY_NAME.exec(text)) !== null) {
        const name = match[1];
        const tail = text.slice(match.index);
        const stop = tail.search(HARMONY_END);
        if (stop === -1)
            return null; // no terminator: not a call we can trust
        const region = tail.slice(0, stop);
        const braceAt = region.indexOf("{");
        if (braceAt === -1)
            return null;
        const json = scanJsonObject(region, braceAt);
        if (!json)
            return null;
        const args = parseArgsJson(json);
        if (!args)
            return null;
        calls.push({ id: `call_leak_${calls.length + 1}`, name, arguments: args });
    }
    return calls.length > 0 ? calls : null;
}
function parseToolCallBlocks(text) {
    const blocks = [...text.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g)].map((m) => m[1]);
    // An unterminated `<tool_call>` is a leak we cannot parse either.
    if (blocks.length === 0)
        return null;
    const calls = [];
    for (const block of blocks) {
        const call = parseToolCallBlock(block);
        if (!call)
            return null;
        calls.push({ ...call, id: `call_leak_${calls.length + 1}` });
    }
    return calls;
}
function parseToolCallBlock(block) {
    // 1. JSON body: {"name":..,"arguments":{..}} (occasionally nested under "function").
    const braceAt = block.indexOf("{");
    if (braceAt !== -1) {
        const json = scanJsonObject(block, braceAt);
        const parsed = json ? parseArgsJson(json) : null;
        if (parsed) {
            const fn = parsed.function && typeof parsed.function === "object" ? parsed.function : null;
            const name = typeof parsed.name === "string" ? parsed.name : typeof fn?.name === "string" ? fn.name : null;
            const rawArgs = parsed.arguments ?? parsed.parameters ?? fn?.arguments;
            const args = typeof rawArgs === "string" ? parseArgsJson(rawArgs) : rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs : null;
            if (name && args)
                return { name, arguments: args };
            // Named but unreadable arguments: a leak we must not execute.
            if (name)
                return null;
            // No name in the JSON — fall through to the tag/bare forms.
        }
    }
    // 2. Tag-attribute body: <function=name> with <parameter=key>value</parameter>
    //    or <arg_key>key</arg_key><arg_value>value</arg_value> children.
    const fnMatch = block.match(/<function=([A-Za-z_][\w.-]*)\s*>/);
    const params = [...block.matchAll(/<parameter=([A-Za-z_][\w.-]*)>([\s\S]*?)<\/parameter>/g)];
    const keys = [...block.matchAll(/<arg_key>([\s\S]*?)<\/arg_key>/g)].map((m) => m[1].trim());
    const values = [...block.matchAll(/<arg_value>([\s\S]*?)<\/arg_value>/g)].map((m) => m[1].trim());
    if (fnMatch) {
        if (params.length > 0) {
            const args = {};
            for (const p of params)
                args[p[1]] = coerceValue(p[2].trim());
            return { name: fnMatch[1], arguments: args };
        }
        // Unbalanced key/value counts are the malformed-sample case: refuse the
        // whole call rather than execute half an argument list.
        if (keys.length !== values.length || keys.length === 0)
            return null;
        const args = {};
        keys.forEach((k, i) => {
            args[k] = coerceValue(values[i]);
        });
        return { name: fnMatch[1], arguments: args };
    }
    // Arg tags with no function name anywhere: nothing to execute, so not a call.
    if (keys.length > 0 || values.length > 0 || params.length > 0)
        return null;
    // 3. Bare call: name({...})
    const bare = block.match(/([A-Za-z_][\w.-]*)\s*\(\s*(\{[\s\S]*\})\s*\)/);
    if (bare) {
        const json = scanJsonObject(bare[2], 0);
        const args = json ? parseArgsJson(json) : null;
        if (args)
            return { name: bare[1], arguments: args };
    }
    return null;
}
/** Template arguments are strings; keep JSON scalars where the model meant one. */
function coerceValue(raw) {
    if (raw === "")
        return "";
    try {
        return JSON.parse(raw);
    }
    catch {
        return raw;
    }
}
