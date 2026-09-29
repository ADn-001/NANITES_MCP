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
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  ChatToolCall,
  ListModelsResponse,
  ProviderCapabilities,
  RawProviderModel,
} from "./types.js";
import type { ProviderKind } from "../storage/profileDefaults.js";

// ---- interface ----

export interface ProviderClient {
  readonly provider: ProviderKind;
  readonly baseUrl: string;
  listModels(key: string, accountId?: string): Promise<ListModelsResponse>;
  chat(req: ChatRequest, key: string, accountId?: string, gatewayUrl?: string): Promise<ChatResponse>;
  streamChat(
    req: ChatRequest,
    key: string,
    accountId?: string,
    gatewayUrl?: string,
    onEvent?: (event: ChatStreamEvent) => void,
  ): Promise<ChatResponse>;
  mapError(err: unknown, httpStatus?: number): NanitesError;
}

// ---- helpers ----

function extractXRequestId(headers: Headers): string | undefined {
  return (
    headers.get("x-request-id") ||
    headers.get("x-req-id") ||
    headers.get("cf-ray-id") ||
    undefined
  );
}

// Providers return errors both as JSON (OpenRouter `{error:{...}}`, Cloudflare
// `{success:false,errors:[...]}`) and as plain text. Parse to an object when
// possible so mapHttpStatus's provider-specific branches actually engage —
// passing a raw text blob made every structured message surface as JSON noise.
export async function readErrorBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function parseModalities(raw?: RawProviderModel["capabilities"]): ProviderCapabilities {
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
function normalizeReasoning(
  v: unknown,
): string | undefined {
  if (Array.isArray(v)) {
    const joined = (v as Array<{ content?: string }>)
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
function parseToolCalls(raw: unknown): ChatToolCall[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const calls: ChatToolCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const fn = o.function;
    const fnObj = fn && typeof fn === "object" ? (fn as Record<string, unknown>) : {};
    const name = typeof fnObj.name === "string" ? fnObj.name : "";
    const id = typeof o.id === "string" ? o.id : "";
    if (!name || !id) continue;
    let args: Record<string, unknown> = {};
    if (typeof fnObj.arguments === "string") {
      try {
        const parsed = JSON.parse(fnObj.arguments) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
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
function parseCloudflarePricing(
  properties: unknown,
): { pricing_prompt: number | null; pricing_completion: number | null } {
  let pricing_prompt: number | null = null;
  let pricing_completion: number | null = null;
  for (const entry of Array.isArray(properties) ? properties : []) {
    const property = entry as { property_id?: unknown; value?: unknown };
    if (property?.property_id !== "price") continue;
    for (const unit of Array.isArray(property.value) ? property.value : []) {
      const priced = unit as { unit?: unknown; price?: unknown };
      const price = Number(priced?.price);
      if (!Number.isFinite(price)) continue;
      if (/input/i.test(String(priced?.unit))) pricing_prompt = price;
      if (/output/i.test(String(priced?.unit))) pricing_completion = price;
    }
  }
  return { pricing_prompt, pricing_completion };
}

function parseOpenAiModels(payload: unknown): RawProviderModel[] {
  if (!payload || typeof payload !== "object") return [];
  const o = payload as Record<string, unknown>;
  if (Array.isArray(o.data)) {
    return (o.data as unknown[]).map((m) => m as RawProviderModel);
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
function toWireMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    const base: Record<string, unknown> = { role: m.role, content: m.content ?? "" };
    if (m.tool_call_id) base.tool_call_id = m.tool_call_id;
    // Strict OpenAI-compat servers expect the tool name alongside the id on the
    // answering turn; Cloudflare's validator warns without it.
    if (m.role === "tool" && m.name) base.name = m.name;
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
export function serializeChatRequest(req: ChatRequest): Record<string, unknown> {
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
export function parseChatResponse(raw: unknown): ChatResponse {
  const json = (raw ?? {}) as {
    id?: string;
    choices?: Array<{
      message?: { content?: string; reasoning_content?: string; reasoning?: string; tool_calls?: unknown };
      finish_reason?: string;
    }>;
    usage?: ChatResponse["usage"];
  };
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

export async function* readSseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) yield line.slice(6);
        else if (line.trim() === "") continue;
        else yield line;
      }
    }
    if (buffer.trim()) yield buffer.trim();
  } finally {
    reader.releaseLock();
  }
}

async function reassembleStream(
  events: AsyncGenerator<string>,
  onEvent?: (event: ChatStreamEvent) => void,
): Promise<ChatResponse> {
  let content = "";
  let reasoningContent: string | undefined;
  let finishReason: string | undefined;
  let providerRequestId: string | undefined;
  let usage: ChatResponse["usage"] | undefined;

  for await (const raw of events) {
    if (raw === "[DONE]" || raw === "") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw);
    } catch {
      continue;
    }
    const choices = event.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0] as Record<string, unknown> | undefined;
    const delta = choice?.delta as Record<string, unknown> | undefined;

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
      usage = event.usage as ChatResponse["usage"];
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

// ---- NVIDIA NIM ----

/**
 * NVIDIA's hosted inference API. OpenAI-shaped in every respect that matters —
 * `/models`, `/chat/completions`, Bearer auth — so this mirrors OpenRouterClient
 * rather than inventing a dialect.
 *
 * Two deliberate differences from the other clients:
 *  - NIM takes PLAIN OpenAI params, so unlike Cloudflare there is no
 *    `reasoning_effort` special-casing to do.
 *  - `account_id` is accepted and ignored, so a config that carries one does
 *    not fail validation. It is not a NIM concept; Cloudflare is the only
 *    provider that uses it, and it goes in a URL path there.
 */
export class NvidiaClient implements ProviderClient {
  readonly provider: ProviderKind = "nvidia";
  readonly baseUrl: string;

  constructor(baseUrl = "https://integrate.api.nvidia.com/v1") {
    this.baseUrl = baseUrl;
  }

  async listModels(key: string, _accountId?: string): Promise<ListModelsResponse> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw mapFetchError(err);
    }
    if (!res.ok) {
      throw mapHttpStatus(res.status, await readErrorBody(res), "generic");
    }
    return { models: parseOpenAiModels(await res.json()) as RawProviderModel[] };
  }

  async chat(req: ChatRequest, key: string, _accountId?: string, gatewayUrl?: string): Promise<ChatResponse> {
    const base = gatewayUrl ?? this.baseUrl;
    let res: Response;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(serializeChatRequest(req)),
        signal: AbortSignal.timeout(240_000),
      });
    } catch (err) {
      throw mapFetchError(err);
    }
    if (!res.ok) {
      throw mapHttpStatus(res.status, await readErrorBody(res), "generic");
    }
    const json = await res.json() as {
      id?: string;
      choices?: Array<{ message?: { content?: string; reasoning_content?: string; reasoning?: unknown }; finish_reason?: string }>;
      usage?: ChatResponse["usage"];
    };
    const choice = json.choices?.[0]?.message;
    const reasoning = normalizeReasoning(choice?.reasoning);
    const toolCalls = parseToolCalls((choice as { tool_calls?: unknown })?.tool_calls);
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

  async streamChat(
    req: ChatRequest,
    key: string,
    _accountId?: string,
    gatewayUrl?: string,
    onEvent?: (event: ChatStreamEvent) => void,
  ): Promise<ChatResponse> {
    const base = gatewayUrl ?? this.baseUrl;
    let res: Response;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(serializeChatRequest({ ...req, stream: true })),
        signal: AbortSignal.timeout(240_000),
      });
    } catch (err) {
      throw mapFetchError(err);
    }
    if (!res.ok) {
      throw mapHttpStatus(res.status, await readErrorBody(res), "generic");
    }
    if (!res.body) throw new NanitesError({ code: "truncated_stream", message: "stream had no body", retryable: true });

    let content = "";
    let reasoningContent: string | undefined;
    let finishReason: string | undefined;
    const lines = readSseLines(res.body);
    for await (const raw of lines) {
      if (raw === "[DONE]") continue;
      let event: Record<string, unknown>;
      try { event = JSON.parse(raw); } catch { continue; }
      const choice = (event.choices as Array<Record<string, unknown>> | undefined)?.[0];
      const delta = choice?.delta as Record<string, unknown> | undefined;
      if (delta) {
        if (typeof delta.content === "string" && delta.content) {
          content += delta.content;
          onEvent?.({ type: "content", delta: delta.content });
        }
        const r = normalizeReasoning(delta.reasoning)
          ?? (typeof delta.reasoning_content === "string" ? delta.reasoning_content : undefined);
        if (r) {
          reasoningContent = (reasoningContent ?? "") + r;
          onEvent?.({ type: "content", delta: r, reasoning_delta: r });
        }
      }
      if (choice?.finish_reason) finishReason = String(choice.finish_reason);
      onEvent?.({ type: "done", finish_reason: finishReason });
    }
    return { content, reasoning_content: reasoningContent, finish_reason: finishReason, provider_request_id: extractXRequestId(res.headers) };
  }

  mapError(err: unknown, httpStatus?: number): NanitesError {
    if (err instanceof NanitesError) return err;
    if (httpStatus) return mapHttpStatus(httpStatus, err, "generic");
    return mapFetchError(err);
  }
}

// ---- Cloudflare ----

export class CloudflareClient implements ProviderClient {
  readonly provider: ProviderKind = "cloudflare";
  readonly baseUrl: string;

  constructor(baseUrl = "https://api.cloudflare.com/client/v4") {
    this.baseUrl = baseUrl;
  }

  async listModels(key: string, accountId: string): Promise<ListModelsResponse> {
    // Workers AI catalog lives at /ai/models/search, not /ai/models. Search items
    // carry the runnable model id ("@cf/...") in `name` and a uuid in `id`.
    const url = `${this.baseUrl}/accounts/${accountId}/ai/models/search?per_page=100`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw mapFetchError(err);
    }
    if (!res.ok) {
      const body = await readErrorBody(res);
      throw mapHttpStatus(res.status, body, "cloudflare");
    }
    const json = await res.json() as { success: boolean; result: { id: string; name?: string; description?: string; context_length?: number; capabilities?: RawProviderModel["capabilities"]; properties?: unknown }[] };
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

  async chat(req: ChatRequest, key: string, accountId: string, gatewayUrl?: string): Promise<ChatResponse> {
    const base = gatewayUrl ?? this.baseUrl;
    const url = `${base}/accounts/${accountId}/ai/v1/chat/completions`;
    let res: Response;
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
    } catch (err) {
      throw mapFetchError(err);
    }
    if (!res.ok) {
      const body = await readErrorBody(res);
      throw mapHttpStatus(res.status, body, "cloudflare");
    }
    const json = await res.json();
    return parseChatResponse(json);
  }

  async streamChat(
    req: ChatRequest,
    key: string,
    accountId: string,
    gatewayUrl?: string,
    onEvent?: (event: ChatStreamEvent) => void,
  ): Promise<ChatResponse> {
    const base = gatewayUrl ?? this.baseUrl;
    const url = `${base}/accounts/${accountId}/ai/v1/chat/completions`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...serializeChatRequest(req), stream: true }),
        signal: AbortSignal.timeout(240_000),
      });
    } catch (err) {
      throw mapFetchError(err);
    }
    if (!res.ok) {
      const body = await readErrorBody(res);
      throw mapHttpStatus(res.status, body, "cloudflare");
    }
    if (!res.body) throw new NanitesError({ code: "truncated_stream", message: "stream had no body", retryable: true });

    let content = "";
    let reasoningContent: string | undefined;
    let finishReason: string | undefined;
    const lines = readSseLines(res.body);

    for await (const raw of lines) {
      if (raw === "[DONE]") continue;
      let event: Record<string, unknown>;
      try { event = JSON.parse(raw); } catch { continue; }
      const choices = event.choices as Array<Record<string, unknown>> | undefined;
      const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
      if (delta) {
        if (typeof delta.content === "string" && delta.content) {
          content += delta.content;
          onEvent?.({ type: "content", delta: delta.content });
        }
        // `reasoning_content` (DeepSeek-style) or `reasoning` (gpt-oss-style):
        // the field name varies by model family on Cloudflare.
        const reasoningDelta =
          typeof delta.reasoning_content === "string" && delta.reasoning_content
            ? delta.reasoning_content
            : typeof delta.reasoning === "string" && delta.reasoning
              ? delta.reasoning
              : "";
        if (reasoningDelta) {
          reasoningContent = (reasoningContent ?? "") + reasoningDelta;
          onEvent?.({ type: "content", delta: reasoningDelta, reasoning_delta: reasoningDelta });
        }
      }
      if (choices?.[0]?.finish_reason) finishReason = String(choices[0].finish_reason);
      onEvent?.({ type: "done", finish_reason: finishReason });
    }

    return { content, reasoning_content: reasoningContent, finish_reason: finishReason };
  }

  mapError(err: unknown, httpStatus?: number): NanitesError {
    if (err instanceof NanitesError) return err;
    if (httpStatus) return mapHttpStatus(httpStatus, err, "cloudflare");
    return mapFetchError(err);
  }
}

// ---- OpenRouter ----

export class OpenRouterClient implements ProviderClient {
  readonly provider: ProviderKind = "openrouter";
  readonly baseUrl: string;

  constructor(baseUrl = "https://openrouter.ai/api/v1") {
    this.baseUrl = baseUrl;
  }

  async listModels(key: string): Promise<ListModelsResponse> {
    // OpenRouter uses /models not /v1/models
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw mapFetchError(err);
    }
    if (!res.ok) {
      const body = await readErrorBody(res);
      throw mapHttpStatus(res.status, body, "openrouter");
    }
    const json = await res.json();
    return { models: parseOpenAiModels(json) as RawProviderModel[] };
  }

  async chat(req: ChatRequest, key: string, _accountId?: string, gatewayUrl?: string): Promise<ChatResponse> {
    const base = gatewayUrl ?? this.baseUrl;
    let res: Response;
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
    } catch (err) {
      throw mapFetchError(err);
    }
    if (!res.ok) {
      const body = await readErrorBody(res);
      throw mapHttpStatus(res.status, body, "openrouter");
    }
    const json = await res.json() as {
      id?: string;
      choices?: Array<{ message?: { content?: string; reasoning_content?: string; reasoning?: unknown }; finish_reason?: string }>;
      usage?: ChatResponse["usage"];
    };
    const choice = json.choices?.[0]?.message;
    const reasoning = normalizeReasoning(choice?.reasoning);
    const toolCalls = parseToolCalls((choice as { tool_calls?: unknown }).tool_calls);
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

  async streamChat(
    req: ChatRequest,
    key: string,
    _accountId?: string,
    gatewayUrl?: string,
    onEvent?: (event: ChatStreamEvent) => void,
  ): Promise<ChatResponse> {
    const base = gatewayUrl ?? this.baseUrl;
    let res: Response;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...serializeChatRequest(req), stream: true }),
        signal: AbortSignal.timeout(240_000),
      });
    } catch (err) {
      throw mapFetchError(err);
    }
    if (!res.ok) {
      const body = await readErrorBody(res);
      throw mapHttpStatus(res.status, body, "openrouter");
    }
    if (!res.body) throw new NanitesError({ code: "truncated_stream", message: "stream had no body", retryable: true });

    let content = "";
    let reasoningContent: string | undefined;
    let finishReason: string | undefined;
    const reqId = extractXRequestId(res.headers);
    const lines = readSseLines(res.body);

    for await (const raw of lines) {
      if (raw === "[DONE]") continue;
      let event: Record<string, unknown>;
      try { event = JSON.parse(raw); } catch { continue; }
      const choices = event.choices as Array<Record<string, unknown>> | undefined;
      const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
      if (delta) {
        if (typeof delta.content === "string" && delta.content) {
          content += delta.content;
          onEvent?.({ type: "content", delta: delta.content });
        }
        // OpenRouter streams reasoning under `delta.reasoning`; OpenAI-style
        // providers use `reasoning_content`. Accept both.
        const dReasoning =
          normalizeReasoning(delta.reasoning) ??
          (typeof delta.reasoning_content === "string" ? delta.reasoning_content : undefined);
        if (dReasoning) {
          reasoningContent = (reasoningContent ?? "") + dReasoning;
          onEvent?.({ type: "content", delta: dReasoning, reasoning_delta: dReasoning });
        }
      }
      if (choices?.[0]?.finish_reason) finishReason = String(choices[0].finish_reason);
      onEvent?.({ type: "done", finish_reason: finishReason });
    }

    return { content, reasoning_content: reasoningContent, finish_reason: finishReason, provider_request_id: reqId };
  }

  mapError(err: unknown, httpStatus?: number): NanitesError {
    if (err instanceof NanitesError) return err;
    if (httpStatus) return mapHttpStatus(httpStatus, err, "openrouter");
    return mapFetchError(err);
  }
}

// ---- OmniRoute ----

export class OmniRouteClient implements ProviderClient {
  readonly provider: ProviderKind = "omniroute";
  readonly baseUrl: string;

  constructor(baseUrl = "http://localhost:20128/v1") {
    this.baseUrl = baseUrl;
  }

  async listModels(key: string): Promise<ListModelsResponse> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw mapFetchError(err);
    }
    if (!res.ok) {
      const body = await readErrorBody(res);
      throw mapHttpStatus(res.status, body, "omniroute");
    }
    const json = await res.json();
    return { models: parseOpenAiModels(json) as RawProviderModel[] };
  }

  async chat(req: ChatRequest, key: string, _accountId?: string, gatewayUrl?: string): Promise<ChatResponse> {
    const base = gatewayUrl ?? this.baseUrl;
    let res: Response;
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
    } catch (err) {
      throw mapFetchError(err);
    }
    if (!res.ok) {
      const body = await readErrorBody(res);
      throw mapHttpStatus(res.status, body, "omniroute");
    }
    const json = await res.json() as {
      id?: string;
      choices?: Array<{ message?: { content?: string; reasoning_content?: string; reasoning?: unknown }; finish_reason?: string }>;
      usage?: ChatResponse["usage"];
      "x-cost-usd"?: string;
    };
    const choice = json.choices?.[0]?.message;
    const reasoning = normalizeReasoning(choice?.reasoning);
    const toolCalls = parseToolCalls((choice as { tool_calls?: unknown }).tool_calls);
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

  async streamChat(
    req: ChatRequest,
    key: string,
    _accountId?: string,
    gatewayUrl?: string,
    onEvent?: (event: ChatStreamEvent) => void,
  ): Promise<ChatResponse> {
    const base = gatewayUrl ?? this.baseUrl;
    let res: Response;
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
    } catch (err) {
      throw mapFetchError(err);
    }
    if (!res.ok) {
      const body = await readErrorBody(res);
      throw mapHttpStatus(res.status, body, "omniroute");
    }
    if (!res.body) throw new NanitesError({ code: "truncated_stream", message: "stream had no body", retryable: true });

    let content = "";
    let reasoningContent: string | undefined;
    let finishReason: string | undefined;
    const reqId = extractXRequestId(res.headers);
    const lines = readSseLines(res.body);

    for await (const raw of lines) {
      if (raw === "[DONE]") continue;
      let event: Record<string, unknown>;
      try { event = JSON.parse(raw); } catch { continue; }
      const choices = event.choices as Array<Record<string, unknown>> | undefined;
      const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
      if (delta) {
        if (typeof delta.content === "string" && delta.content) {
          content += delta.content;
          onEvent?.({ type: "content", delta: delta.content });
        }
        // OmniRoute reasoning arrives as delta.reasoning on some backends,
        // reasoning_content on others.
        const dReasoning =
          normalizeReasoning(delta.reasoning) ??
          (typeof delta.reasoning_content === "string" ? delta.reasoning_content : undefined);
        if (dReasoning) {
          reasoningContent = (reasoningContent ?? "") + dReasoning;
          onEvent?.({ type: "content", delta: dReasoning, reasoning_delta: dReasoning });
        }
      }
      if (choices?.[0]?.finish_reason) finishReason = String(choices[0].finish_reason);
      onEvent?.({ type: "done", finish_reason: finishReason });
    }

    return { content, reasoning_content: reasoningContent, finish_reason: finishReason, provider_request_id: reqId };
  }

  mapError(err: unknown, httpStatus?: number): NanitesError {
    if (err instanceof NanitesError) return err;
    if (httpStatus) return mapHttpStatus(httpStatus, err, "omniroute");
    return mapFetchError(err);
  }
}

// ---- Generic OpenAI-Compatible ----

export class GenericClient implements ProviderClient {
  readonly provider: ProviderKind = "generic";
  readonly baseUrl: string;

  constructor(baseUrl = "http://localhost:8080/v1") {
    this.baseUrl = baseUrl;
  }

  async listModels(key: string, _accountId?: string, gatewayUrl?: string): Promise<ListModelsResponse> {
    const base = gatewayUrl ?? this.baseUrl;
    let res: Response;
    try {
      res = await fetch(`${base}/models`, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw mapFetchError(err);
    }
    if (!res.ok) {
      const body = await readErrorBody(res);
      throw mapHttpStatus(res.status, body, "generic");
    }
    const json = await res.json();
    return { models: parseOpenAiModels(json) as RawProviderModel[] };
  }

  async chat(req: ChatRequest, key: string, _accountId?: string, gatewayUrl?: string): Promise<ChatResponse> {
    const base = gatewayUrl ?? this.baseUrl;
    let res: Response;
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
    } catch (err) {
      throw mapFetchError(err);
    }
    if (!res.ok) {
      const body = await readErrorBody(res);
      throw mapHttpStatus(res.status, body, "generic");
    }
    const json = await res.json() as {
      id?: string;
      choices?: Array<{ message?: { content?: string; reasoning_content?: string; reasoning?: unknown }; finish_reason?: string }>;
      usage?: ChatResponse["usage"];
    };
    const choice = json.choices?.[0]?.message;
    const reasoning = normalizeReasoning(choice?.reasoning);
    const toolCalls = parseToolCalls((choice as { tool_calls?: unknown }).tool_calls);
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

  async streamChat(
    req: ChatRequest,
    key: string,
    _accountId?: string,
    gatewayUrl?: string,
    onEvent?: (event: ChatStreamEvent) => void,
  ): Promise<ChatResponse> {
    const base = gatewayUrl ?? this.baseUrl;
    let res: Response;
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
    } catch (err) {
      throw mapFetchError(err);
    }
    if (!res.ok) {
      const body = await readErrorBody(res);
      throw mapHttpStatus(res.status, body, "generic");
    }
    if (!res.body) throw new NanitesError({ code: "truncated_stream", message: "stream had no body", retryable: true });

    let content = "";
    let reasoningContent: string | undefined;
    let finishReason: string | undefined;
    const reqId = extractXRequestId(res.headers);
    const lines = readSseLines(res.body);

    for await (const raw of lines) {
      if (raw === "[DONE]") continue;
      let event: Record<string, unknown>;
      try { event = JSON.parse(raw); } catch { continue; }
      const choices = event.choices as Array<Record<string, unknown>> | undefined;
      const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
      if (delta) {
        if (typeof delta.content === "string" && delta.content) {
          content += delta.content;
          onEvent?.({ type: "content", delta: delta.content });
        }
        // Generic endpoints vary: LM Studio streams delta.reasoning_content,
        // some OpenAI-compat gateways send delta.reasoning.
        const dReasoning =
          normalizeReasoning(delta.reasoning) ??
          (typeof delta.reasoning_content === "string" ? delta.reasoning_content : undefined);
        if (dReasoning) {
          reasoningContent = (reasoningContent ?? "") + dReasoning;
          onEvent?.({ type: "content", delta: dReasoning, reasoning_delta: dReasoning });
        }
      }
      if (choices?.[0]?.finish_reason) finishReason = String(choices[0].finish_reason);
      onEvent?.({ type: "done", finish_reason: finishReason });
    }

    return { content, reasoning_content: reasoningContent, finish_reason: finishReason, provider_request_id: reqId };
  }

  mapError(err: unknown, httpStatus?: number): NanitesError {
    if (err instanceof NanitesError) return err;
    if (httpStatus) return mapHttpStatus(httpStatus, err, "generic");
    return mapFetchError(err);
  }
}

// ---- factory ----

export function createProviderClient(provider: ProviderKind, baseUrl?: string): ProviderClient {
  switch (provider) {
    case "cloudflare": return new CloudflareClient(baseUrl);
    case "openrouter": return new OpenRouterClient(baseUrl);
    case "nvidia": return new NvidiaClient(baseUrl);
    case "omniroute": return new OmniRouteClient(baseUrl as string);
    case "generic": return new GenericClient(baseUrl as string);
    case "local": throw new Error("use LmStudioClient for local provider");
  }
}
