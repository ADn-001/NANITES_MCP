/**
 * ProviderClient — unified HTTP client over cloud AI provider APIs.
 *
 * Interface:
 *   listModels()  → cached model list for registration
 *   chat(req)    → non-streaming ChatResponse
 *   mapError(err) → NanitesError with provider-specific parsing
 *
 * Implementations:
 *   CloudflareClient  — Account ID in URL path; Bearer auth; {success,result} wrapper
 *   OpenRouterClient  — Bearer auth; /models (no /v1/); credit-based billing
 *   OmniRouteClient   — Bearer auth; session affinity headers; cost tracking headers
 *   GenericClient     — Bearer or none; /v1/models auto-discovery attempt
 */
import { NanitesError } from "../helpers/errors.js";
import { mapFetchError, mapHttpStatus } from "./errors.js";
// ---- helpers ----
function extractXRequestId(headers) {
    return (headers.get("x-request-id") ||
        headers.get("x-req-id") ||
        headers.get("cf-ray-id") ||
        undefined);
}
// Providers return errors both as JSON (OpenRouter `{error:{...}}`, Cloudflare
// `{success:false,errors:[...]}`) and as plain text. Parse to an object when
// possible so mapHttpStatus's provider-specific branches actually engage —
// passing a raw text blob made every structured message surface as JSON noise.
async function readErrorBody(res) {
    const text = await res.text().catch(() => "");
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
function parseModalities(raw) {
    return {
        vision: raw?.vision ?? false,
        audio: raw?.audio ?? false,
        video: raw?.video ?? false,
        function_calling: raw?.function_calling ?? false,
    };
}
// Reasoning arrives as `reasoning` (string — OpenRouter non-streaming) or as
// an array of `{content, signature}` blocks (some providers) or as
// `reasoning_content` (OpenAI-style). Normalize to a single string.
function normalizeReasoning(v) {
    if (Array.isArray(v)) {
        const joined = v
            .map((r) => (typeof r.content === "string" ? r.content : ""))
            .filter(Boolean)
            .join("\n");
        return joined || undefined;
    }
    return typeof v === "string" && v ? v : undefined;
}
/**
 * Parse `message.tool_calls` (OpenAI shape: array of
 * `{id, type:"function", function:{name, arguments: string}}`) into the
 * typed ChatToolCall[] used by the cloud tool loop. `arguments` is a JSON
 * string on the wire — parse it, degrade to {} on malformed input rather than
 * killing the round.
 */
function parseToolCalls(raw) {
    if (!Array.isArray(raw) || raw.length === 0)
        return undefined;
    const calls = [];
    for (const item of raw) {
        if (!item || typeof item !== "object")
            continue;
        const o = item;
        const fn = o.function;
        const fnObj = fn && typeof fn === "object" ? fn : {};
        const name = typeof fnObj.name === "string" ? fnObj.name : "";
        const id = typeof o.id === "string" ? o.id : "";
        if (!name || !id)
            continue;
        let args = {};
        if (typeof fnObj.arguments === "string") {
            try {
                const parsed = JSON.parse(fnObj.arguments);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    args = parsed;
                }
            }
            catch {
                // malformed arguments JSON — keep {} so the call still reaches the loop
            }
        }
        calls.push({ id, name, arguments: args });
    }
    return calls.length > 0 ? calls : undefined;
}
/**
 * Cloudflare catalog pricing. `/ai/models/search` carries a `price` property
 * whose value is a list of units — "per M input tokens" / "per M output
 * tokens" — already in USD per million, which is the unit the seed manifest and
 * the ledger both use, so the numbers are copied, not converted.
 *
 * Most catalog rows carry no `price` at all. That stays null rather than
 * defaulting to a number: a guessed rate would be a fabricated `cost_usd` in
 * every report that reads it, and the manifest stays the authority for models
 * it seeds.
 */
function parseCloudflarePricing(properties) {
    let pricing_prompt = null;
    let pricing_completion = null;
    for (const entry of Array.isArray(properties) ? properties : []) {
        const property = entry;
        if (property?.property_id !== "price")
            continue;
        for (const unit of Array.isArray(property.value) ? property.value : []) {
            const priced = unit;
            const price = Number(priced?.price);
            if (!Number.isFinite(price))
                continue;
            if (/input/i.test(String(priced?.unit)))
                pricing_prompt = price;
            if (/output/i.test(String(priced?.unit)))
                pricing_completion = price;
        }
    }
    return { pricing_prompt, pricing_completion };
}
function parseOpenAiModels(payload) {
    if (!payload || typeof payload !== "object")
        return [];
    const o = payload;
    if (Array.isArray(o.data)) {
        return o.data.map((m) => m);
    }
    return [];
}
/**
 * OpenAI wire shape for outgoing messages. The tool loop keeps history in the
 * internal `ChatToolCall` form ({id, name, arguments: object}) so executors can
 * run calls; providers validate the assistant `tool_calls` echo in OpenAI form
 * ({id, type:"function", function:{name, arguments: string}}). Without this
 * mapping Cloudflare's strict OpenAI-compat validator rejects the replayed
 * assistant turn (pydantic: missing `function`, missing `type`).
 */
function toWireMessages(messages) {
    return messages.map((m) => {
        const base = { role: m.role, content: m.content ?? "" };
        if (m.tool_call_id)
            base.tool_call_id = m.tool_call_id;
        // Strict OpenAI-compat servers expect the tool name alongside the id on the
        // answering turn; Cloudflare's validator warns without it.
        if (m.role === "tool" && m.name)
            base.name = m.name;
        if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
            base.tool_calls = m.tool_calls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: {
                    name: tc.name,
                    arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
                },
            }));
        }
        return base;
    });
}
/** Body-safe request: messages mapped to the OpenAI wire format. */
export function serializeChatRequest(req) {
    return { ...req, messages: toWireMessages(req.messages) };
}
/**
 * Normalise an OpenAI-compat chat body into a ChatResponse.
 *
 * Two provider quirks are absorbed here. The reasoning field name varies by
 * model family on Cloudflare — `reasoning_content` (DeepSeek-style) or
 * `reasoning` (gpt-oss-style) — so both are read. And `finish_reason` is
 * carried through verbatim because the router needs it to classify an empty
 * reply; it cannot be inferred from the response otherwise.
 */
export function parseChatResponse(raw) {
    const json = (raw ?? {});
    const choice = json.choices?.[0]?.message;
    const toolCalls = parseToolCalls(choice?.tool_calls);
    const reasoning = choice?.reasoning_content ?? choice?.reasoning;
    return {
        content: choice?.content ?? "",
        ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}),
        ...(choice?.reasoning !== undefined ? { reasoning: choice.reasoning } : {}),
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
        finish_reason: json.choices?.[0]?.finish_reason,
        provider_request_id: json.id,
        usage: json.usage,
    };
}
async function* readSseLines(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
                if (line.startsWith("data: "))
                    yield line.slice(6);
                else if (line.trim() === "")
                    continue;
                else
                    yield line;
            }
        }
        if (buffer.trim())
            yield buffer.trim();
    }
    finally {
        reader.releaseLock();
    }
}
async function reassembleStream(events, onEvent) {
    let content = "";
    let reasoningContent;
    let finishReason;
    let providerRequestId;
    let usage;
    for await (const raw of events) {
        if (raw === "[DONE]" || raw === "")
            continue;
        let event;
        try {
            event = JSON.parse(raw);
        }
        catch {
            continue;
        }
        const choices = event.choices;
        const choice = choices?.[0];
        const delta = choice?.delta;
        if (delta) {
            if (typeof delta.content === "string" && delta.content) {
                content += delta.content;
                onEvent?.({ type: "content", delta: delta.content });
            }
            if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
                reasoningContent = (reasoningContent ?? "") + delta.reasoning_content;
                onEvent?.({ type: "content", delta: delta.reasoning_content, reasoning_delta: delta.reasoning_content });
            }
        }
        if (choice?.finish_reason) {
            finishReason = String(choice.finish_reason);
        }
        if (event.x_request_id) {
            providerRequestId = String(event.x_request_id);
        }
        if (event.usage) {
            usage = event.usage;
        }
        onEvent?.({ type: "done", finish_reason: finishReason });
    }
    return {
        content,
        reasoning_content: reasoningContent,
        finish_reason: finishReason,
        provider_request_id: providerRequestId,
        usage,
    };
}
// ---- Cloudflare ----
export class CloudflareClient {
    provider = "cloudflare";
    baseUrl;
    constructor(baseUrl = "https://api.cloudflare.com/client/v4") {
        this.baseUrl = baseUrl;
    }
    async listModels(key, accountId) {
        // Workers AI catalog lives at /ai/models/search, not /ai/models. Search items
        // carry the runnable model id ("@cf/...") in `name` and a uuid in `id`.
        const url = `${this.baseUrl}/accounts/${accountId}/ai/models/search?per_page=100`;
        let res;
        try {
            res = await fetch(url, {
                headers: { Authorization: `Bearer ${key}` },
                signal: AbortSignal.timeout(15_000),
            });
        }
        catch (err) {
            throw mapFetchError(err);
        }
        if (!res.ok) {
            const body = await readErrorBody(res);
            throw mapHttpStatus(res.status, body, "cloudflare");
        }
        const json = await res.json();
        return {
            models: (json.result ?? []).map((m) => {
                const runnable = m.name?.trim().startsWith("@") ? m.name.trim() : (m.id || m.name || "");
                return {
                    id: runnable,
                    name: m.name ?? runnable,
                    owned_by: "cloudflare",
                    context_length: m.context_length ?? null,
                    capabilities: m.capabilities,
                    ...parseCloudflarePricing(m.properties),
                };
            }),
        };
    }
    async chat(req, key, accountId, gatewayUrl) {
        const base = gatewayUrl ?? this.baseUrl;
        const url = `${base}/accounts/${accountId}/ai/v1/chat/completions`;
        let res;
        try {
            res = await fetch(url, {
                method: "POST",
                headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
                body: JSON.stringify(serializeChatRequest(req)),
                // Reasoning models spend minutes on a hard brief before answering
                // (measured 40-82s for a single Cloudflare call at a 16k budget), so
                // the old 120s ceiling aborted healthy runs.
                signal: AbortSignal.timeout(240_000),
            });
        }
        catch (err) {
            throw mapFetchError(err);
        }
        if (!res.ok) {
            const body = await readErrorBody(res);
            throw mapHttpStatus(res.status, body, "cloudflare");
        }
        const json = await res.json();
        return parseChatResponse(json);
    }
    async streamChat(req, key, accountId, gatewayUrl, onEvent) {
        const base = gatewayUrl ?? this.baseUrl;
        const url = `${base}/accounts/${accountId}/ai/v1/chat/completions`;
        let res;
        try {
            res = await fetch(url, {
                method: "POST",
                headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
                body: JSON.stringify({ ...serializeChatRequest(req), stream: true }),
                signal: AbortSignal.timeout(240_000),
            });
        }
        catch (err) {
            throw mapFetchError(err);
        }
        if (!res.ok) {
            const body = await readErrorBody(res);
            throw mapHttpStatus(res.status, body, "cloudflare");
        }
        if (!res.body)
            throw new NanitesError({ code: "truncated_stream", message: "stream had no body", retryable: true });
        let content = "";
        let reasoningContent;
        let finishReason;
        const lines = readSseLines(res.body);
        for await (const raw of lines) {
            if (raw === "[DONE]")
                continue;
            let event;
            try {
                event = JSON.parse(raw);
            }
            catch {
                continue;
            }
            const choices = event.choices;
            const delta = choices?.[0]?.delta;
            if (delta) {
                if (typeof delta.content === "string" && delta.content) {
                    content += delta.content;
                    onEvent?.({ type: "content", delta: delta.content });
                }
                // `reasoning_content` (DeepSeek-style) or `reasoning` (gpt-oss-style):
                // the field name varies by model family on Cloudflare.
                const reasoningDelta = typeof delta.reasoning_content === "string" && delta.reasoning_content
                    ? delta.reasoning_content
                    : typeof delta.reasoning === "string" && delta.reasoning
                        ? delta.reasoning
                        : "";
                if (reasoningDelta) {
                    reasoningContent = (reasoningContent ?? "") + reasoningDelta;
                    onEvent?.({ type: "content", delta: reasoningDelta, reasoning_delta: reasoningDelta });
                }
            }
            if (choices?.[0]?.finish_reason)
                finishReason = String(choices[0].finish_reason);
            onEvent?.({ type: "done", finish_reason: finishReason });
        }
        return { content, reasoning_content: reasoningContent, finish_reason: finishReason };
    }
    mapError(err, httpStatus) {
        if (err instanceof NanitesError)
            return err;
        if (httpStatus)
            return mapHttpStatus(httpStatus, err, "cloudflare");
        return mapFetchError(err);
    }
}
// ---- OpenRouter ----
export class OpenRouterClient {
    provider = "openrouter";
    baseUrl;
    constructor(baseUrl = "https://openrouter.ai/api/v1") {
        this.baseUrl = baseUrl;
    }
    async listModels(key) {
        // OpenRouter uses /models not /v1/models
        let res;
        try {
            res = await fetch(`${this.baseUrl}/models`, {
                headers: { Authorization: `Bearer ${key}` },
                signal: AbortSignal.timeout(15_000),
            });
        }
        catch (err) {
            throw mapFetchError(err);
        }
        if (!res.ok) {
            const body = await readErrorBody(res);
            throw mapHttpStatus(res.status, body, "openrouter");
        }
        const json = await res.json();
        return { models: parseOpenAiModels(json) };
    }
    async chat(req, key, _accountId, gatewayUrl) {
        const base = gatewayUrl ?? this.baseUrl;
        let res;
        try {
            res = await fetch(`${base}/chat/completions`, {
                method: "POST",
                headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
                body: JSON.stringify(serializeChatRequest(req)),
                // Reasoning models spend minutes on a hard brief before answering
                // (measured 40-82s for a single Cloudflare call at a 16k budget), so
                // the old 120s ceiling aborted healthy runs.
                signal: AbortSignal.timeout(240_000),
            });
        }
        catch (err) {
            throw mapFetchError(err);
        }
        if (!res.ok) {
            const body = await readErrorBody(res);
            throw mapHttpStatus(res.status, body, "openrouter");
        }
        const json = await res.json();
        const choice = json.choices?.[0]?.message;
        const reasoning = normalizeReasoning(choice?.reasoning);
        const toolCalls = parseToolCalls(choice.tool_calls);
        return {
            content: choice?.content ?? "",
            reasoning,
            reasoning_content: choice?.reasoning_content ?? reasoning,
            ...(toolCalls ? { tool_calls: toolCalls } : {}),
            finish_reason: json.choices?.[0]?.finish_reason,
            provider_request_id: extractXRequestId(res.headers) ?? json.id,
            usage: json.usage,
        };
    }
    async streamChat(req, key, _accountId, gatewayUrl, onEvent) {
        const base = gatewayUrl ?? this.baseUrl;
        let res;
        try {
            res = await fetch(`${base}/chat/completions`, {
                method: "POST",
                headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
                body: JSON.stringify({ ...serializeChatRequest(req), stream: true }),
                signal: AbortSignal.timeout(240_000),
            });
        }
        catch (err) {
            throw mapFetchError(err);
        }
        if (!res.ok) {
            const body = await readErrorBody(res);
            throw mapHttpStatus(res.status, body, "openrouter");
        }
        if (!res.body)
            throw new NanitesError({ code: "truncated_stream", message: "stream had no body", retryable: true });
        let content = "";
        let reasoningContent;
        let finishReason;
        const reqId = extractXRequestId(res.headers);
        const lines = readSseLines(res.body);
        for await (const raw of lines) {
            if (raw === "[DONE]")
                continue;
            let event;
            try {
                event = JSON.parse(raw);
            }
            catch {
                continue;
            }
            const choices = event.choices;
            const delta = choices?.[0]?.delta;
            if (delta) {
                if (typeof delta.content === "string" && delta.content) {
                    content += delta.content;
                    onEvent?.({ type: "content", delta: delta.content });
                }
                // OpenRouter streams reasoning under `delta.reasoning`; OpenAI-style
                // providers use `reasoning_content`. Accept both.
                const dReasoning = normalizeReasoning(delta.reasoning) ??
                    (typeof delta.reasoning_content === "string" ? delta.reasoning_content : undefined);
                if (dReasoning) {
                    reasoningContent = (reasoningContent ?? "") + dReasoning;
                    onEvent?.({ type: "content", delta: dReasoning, reasoning_delta: dReasoning });
                }
            }
            if (choices?.[0]?.finish_reason)
                finishReason = String(choices[0].finish_reason);
            onEvent?.({ type: "done", finish_reason: finishReason });
        }
        return { content, reasoning_content: reasoningContent, finish_reason: finishReason, provider_request_id: reqId };
    }
    mapError(err, httpStatus) {
        if (err instanceof NanitesError)
            return err;
        if (httpStatus)
            return mapHttpStatus(httpStatus, err, "openrouter");
        return mapFetchError(err);
    }
}
// ---- OmniRoute ----
export class OmniRouteClient {
    provider = "omniroute";
    baseUrl;
    constructor(baseUrl = "http://localhost:20128/v1") {
        this.baseUrl = baseUrl;
    }
    async listModels(key) {
        let res;
        try {
            res = await fetch(`${this.baseUrl}/models`, {
                headers: { Authorization: `Bearer ${key}` },
                signal: AbortSignal.timeout(15_000),
            });
        }
        catch (err) {
            throw mapFetchError(err);
        }
        if (!res.ok) {
            const body = await readErrorBody(res);
            throw mapHttpStatus(res.status, body, "omniroute");
        }
        const json = await res.json();
        return { models: parseOpenAiModels(json) };
    }
    async chat(req, key, _accountId, gatewayUrl) {
        const base = gatewayUrl ?? this.baseUrl;
        let res;
        try {
            res = await fetch(`${base}/chat/completions`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${key}`,
                    "Content-Type": "application/json",
                    // OmniRoute session affinity
                    "X-Session-Id": `nanites-${Date.now()}`,
                },
                body: JSON.stringify(serializeChatRequest(req)),
                // Reasoning models spend minutes on a hard brief before answering
                // (measured 40-82s for a single Cloudflare call at a 16k budget), so
                // the old 120s ceiling aborted healthy runs.
                signal: AbortSignal.timeout(240_000),
            });
        }
        catch (err) {
            throw mapFetchError(err);
        }
        if (!res.ok) {
            const body = await readErrorBody(res);
            throw mapHttpStatus(res.status, body, "omniroute");
        }
        const json = await res.json();
        const choice = json.choices?.[0]?.message;
        const reasoning = normalizeReasoning(choice?.reasoning);
        const toolCalls = parseToolCalls(choice.tool_calls);
        return {
            content: choice?.content ?? "",
            reasoning,
            reasoning_content: choice?.reasoning_content ?? reasoning,
            ...(toolCalls ? { tool_calls: toolCalls } : {}),
            finish_reason: json.choices?.[0]?.finish_reason,
            provider_request_id: extractXRequestId(res.headers) ?? json.id,
            usage: json.usage,
        };
    }
    async streamChat(req, key, _accountId, gatewayUrl, onEvent) {
        const base = gatewayUrl ?? this.baseUrl;
        let res;
        try {
            res = await fetch(`${base}/chat/completions`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${key}`,
                    "Content-Type": "application/json",
                    "X-Session-Id": `nanites-${Date.now()}`,
                },
                body: JSON.stringify({ ...serializeChatRequest(req), stream: true }),
                signal: AbortSignal.timeout(240_000),
            });
        }
        catch (err) {
            throw mapFetchError(err);
        }
        if (!res.ok) {
            const body = await readErrorBody(res);
            throw mapHttpStatus(res.status, body, "omniroute");
        }
        if (!res.body)
            throw new NanitesError({ code: "truncated_stream", message: "stream had no body", retryable: true });
        let content = "";
        let reasoningContent;
        let finishReason;
        const reqId = extractXRequestId(res.headers);
        const lines = readSseLines(res.body);
        for await (const raw of lines) {
            if (raw === "[DONE]")
                continue;
            let event;
            try {
                event = JSON.parse(raw);
            }
            catch {
                continue;
            }
            const choices = event.choices;
            const delta = choices?.[0]?.delta;
            if (delta) {
                if (typeof delta.content === "string" && delta.content) {
                    content += delta.content;
                    onEvent?.({ type: "content", delta: delta.content });
                }
                // OmniRoute reasoning arrives as delta.reasoning on some backends,
                // reasoning_content on others.
                const dReasoning = normalizeReasoning(delta.reasoning) ??
                    (typeof delta.reasoning_content === "string" ? delta.reasoning_content : undefined);
                if (dReasoning) {
                    reasoningContent = (reasoningContent ?? "") + dReasoning;
                    onEvent?.({ type: "content", delta: dReasoning, reasoning_delta: dReasoning });
                }
            }
            if (choices?.[0]?.finish_reason)
                finishReason = String(choices[0].finish_reason);
            onEvent?.({ type: "done", finish_reason: finishReason });
        }
        return { content, reasoning_content: reasoningContent, finish_reason: finishReason, provider_request_id: reqId };
    }
    mapError(err, httpStatus) {
        if (err instanceof NanitesError)
            return err;
        if (httpStatus)
            return mapHttpStatus(httpStatus, err, "omniroute");
        return mapFetchError(err);
    }
}
// ---- Generic OpenAI-Compatible ----
export class GenericClient {
    provider = "generic";
    baseUrl;
    constructor(baseUrl = "http://localhost:8080/v1") {
        this.baseUrl = baseUrl;
    }
    async listModels(key, _accountId, gatewayUrl) {
        const base = gatewayUrl ?? this.baseUrl;
        let res;
        try {
            res = await fetch(`${base}/models`, {
                headers: key ? { Authorization: `Bearer ${key}` } : {},
                signal: AbortSignal.timeout(15_000),
            });
        }
        catch (err) {
            throw mapFetchError(err);
        }
        if (!res.ok) {
            const body = await readErrorBody(res);
            throw mapHttpStatus(res.status, body, "generic");
        }
        const json = await res.json();
        return { models: parseOpenAiModels(json) };
    }
    async chat(req, key, _accountId, gatewayUrl) {
        const base = gatewayUrl ?? this.baseUrl;
        let res;
        try {
            res = await fetch(`${base}/chat/completions`, {
                method: "POST",
                headers: {
                    ...(key ? { Authorization: `Bearer ${key}` } : {}),
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(serializeChatRequest(req)),
                // Reasoning models spend minutes on a hard brief before answering
                // (measured 40-82s for a single Cloudflare call at a 16k budget), so
                // the old 120s ceiling aborted healthy runs.
                signal: AbortSignal.timeout(240_000),
            });
        }
        catch (err) {
            throw mapFetchError(err);
        }
        if (!res.ok) {
            const body = await readErrorBody(res);
            throw mapHttpStatus(res.status, body, "generic");
        }
        const json = await res.json();
        const choice = json.choices?.[0]?.message;
        const reasoning = normalizeReasoning(choice?.reasoning);
        const toolCalls = parseToolCalls(choice.tool_calls);
        return {
            content: choice?.content ?? "",
            reasoning,
            reasoning_content: choice?.reasoning_content ?? reasoning,
            ...(toolCalls ? { tool_calls: toolCalls } : {}),
            finish_reason: json.choices?.[0]?.finish_reason,
            provider_request_id: extractXRequestId(res.headers) ?? json.id,
            usage: json.usage,
        };
    }
    async streamChat(req, key, _accountId, gatewayUrl, onEvent) {
        const base = gatewayUrl ?? this.baseUrl;
        let res;
        try {
            res = await fetch(`${base}/chat/completions`, {
                method: "POST",
                headers: {
                    ...(key ? { Authorization: `Bearer ${key}` } : {}),
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ ...serializeChatRequest(req), stream: true }),
                signal: AbortSignal.timeout(240_000),
            });
        }
        catch (err) {
            throw mapFetchError(err);
        }
        if (!res.ok) {
            const body = await readErrorBody(res);
            throw mapHttpStatus(res.status, body, "generic");
        }
        if (!res.body)
            throw new NanitesError({ code: "truncated_stream", message: "stream had no body", retryable: true });
        let content = "";
        let reasoningContent;
        let finishReason;
        const reqId = extractXRequestId(res.headers);
        const lines = readSseLines(res.body);
        for await (const raw of lines) {
            if (raw === "[DONE]")
                continue;
            let event;
            try {
                event = JSON.parse(raw);
            }
            catch {
                continue;
            }
            const choices = event.choices;
            const delta = choices?.[0]?.delta;
            if (delta) {
                if (typeof delta.content === "string" && delta.content) {
                    content += delta.content;
                    onEvent?.({ type: "content", delta: delta.content });
                }
                // Generic endpoints vary: LM Studio streams delta.reasoning_content,
                // some OpenAI-compat gateways send delta.reasoning.
                const dReasoning = normalizeReasoning(delta.reasoning) ??
                    (typeof delta.reasoning_content === "string" ? delta.reasoning_content : undefined);
                if (dReasoning) {
                    reasoningContent = (reasoningContent ?? "") + dReasoning;
                    onEvent?.({ type: "content", delta: dReasoning, reasoning_delta: dReasoning });
                }
            }
            if (choices?.[0]?.finish_reason)
                finishReason = String(choices[0].finish_reason);
            onEvent?.({ type: "done", finish_reason: finishReason });
        }
        return { content, reasoning_content: reasoningContent, finish_reason: finishReason, provider_request_id: reqId };
    }
    mapError(err, httpStatus) {
        if (err instanceof NanitesError)
            return err;
        if (httpStatus)
            return mapHttpStatus(httpStatus, err, "generic");
        return mapFetchError(err);
    }
}
// ---- factory ----
export function createProviderClient(provider, baseUrl) {
    switch (provider) {
        case "cloudflare": return new CloudflareClient(baseUrl);
        case "openrouter": return new OpenRouterClient(baseUrl);
        case "omniroute": return new OmniRouteClient(baseUrl);
        case "generic": return new GenericClient(baseUrl);
        case "local": throw new Error("use LmStudioClient for local provider");
    }
}
