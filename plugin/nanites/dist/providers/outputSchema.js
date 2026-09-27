/** The single mapping from Nanites' intent to a provider's wire field. */
export function responseFormatFor(_provider, format, name = "nanites_output") {
    if (format.type === "json_object")
        return { type: "json_object" };
    return { type: "json_schema", json_schema: { name: format.name ?? name, schema: format.schema } };
}
/**
 * Strip a ```json fence, and — when the whole text is not JSON — fall back to
 * the span between the first `{` and the last `}`. Models leak prose around a
 * perfectly good JSON object; refusing that answer would throw away real work.
 */
export function extractJson(text) {
    const trimmed = text.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
    const body = (fenced ? fenced[1] : trimmed).trim();
    if (body.startsWith("{") || body.startsWith("["))
        return body;
    const first = body.indexOf("{");
    const last = body.lastIndexOf("}");
    if (first !== -1 && last > first)
        return body.slice(first, last + 1);
    return body;
}
function describeValue(value) {
    if (value === null)
        return "null";
    if (Array.isArray(value))
        return "an array";
    return `a ${typeof value}`;
}
/** Shallow conformance check: top-level type + required keys of an object. */
function checkShape(value, schema) {
    const problems = [];
    const type = schema.type;
    if (type === "object") {
        const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
        if (!isObject) {
            problems.push(`top-level value is ${describeValue(value)}, schema wants an object`);
            return problems;
        }
        const required = Array.isArray(schema.required) ? schema.required : [];
        for (const key of required) {
            if (typeof key === "string" && !(key in value)) {
                problems.push(`missing required key "${key}"`);
            }
        }
        return problems;
    }
    if (type === "array" && !Array.isArray(value)) {
        problems.push(`top-level value is ${describeValue(value)}, schema wants an array`);
    }
    return problems;
}
/** Parse a reply against a schema. Never throws — a non-conforming answer is a
 * result, not an exception. */
export function parseStructured(text, schema) {
    const body = extractJson(text);
    if (!body)
        return { ok: false, problems: ["reply was empty"] };
    let value;
    try {
        value = JSON.parse(body);
    }
    catch (err) {
        return { ok: false, problems: [`not valid JSON: ${err.message}`] };
    }
    const problems = checkShape(value, schema);
    return problems.length === 0 ? { ok: true, value, problems: [] } : { ok: false, value, problems };
}
