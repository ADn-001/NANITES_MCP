import type {
  ChatInput,
  ChatRequestParams,
  ChatResponse,
  ChatTransport,
  DownloadModelRequest,
  DownloadModelResponse,
  DownloadStatusResponse,
  ListModelsResponse,
  LoadModelRequest,
  LoadModelResponse,
  UnloadModelRequest,
  UnloadModelResponse,
} from "./types.js";
import { LmErrorCodes, malformedJsonError, mapFetchError, mapHttpStatus } from "./errors.js";
import {
  openAiChatEvents,
  readSseEvents,
  reassembleChatStream,
  synthesizeOpenAiResponse,
  type ChatStreamEvent,
  type OpenAiUsage,
} from "./chatStream.js";
import { NanitesError } from "../helpers/errors.js";
import { LOAD_HEARTBEAT_IDLE_MS, LOAD_HEARTBEAT_INTERVAL_MS, SOFT_CEILING_MULT } from "../helpers/idleTimeout.js";

const NATIVE_CHAT_PATH = "/api/v1/chat";
const OPENAI_CHAT_PATH = "/v1/chat/completions";
/** ChatRequestParams keys both wire formats understand verbatim (native keeps
 * the same names; the openai translator copies them through unchanged). */
const PASSTHROUGH_PARAM_KEYS = [
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "repeat_penalty",
  "reasoning",
  "reasoning_budget",
  "context_length",
  "response_format",
] as const;

export interface LmStudioClientOptions {
  baseUrl: string;
  /** Optional bearer token; sent as `Authorization: Bearer <token>`. */
  authToken?: string | null;
  /** Per-request timeout in milliseconds. Default 30s. */
  timeoutMs?: number;
}

export interface ChatResult {
  response: ChatResponse;
  /** Present only for streaming calls — the raw event sequence. */
  events?: ChatStreamEvent[];
}

/**
 * Typed client over the LM Studio v1 REST API. Throws NanitesError with a
 * distinguishable code per failure mode (see src/lmstudio/errors.ts).
 */
export class LmStudioClient {
  private readonly baseUrl: string;
  private readonly authToken?: string | null;
  private readonly timeoutMs: number;

  constructor(options: LmStudioClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.authToken = options.authToken;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private headers(contentType?: string): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.authToken) headers["Authorization"] = `Bearer ${this.authToken}`;
    if (contentType) headers["Content-Type"] = contentType;
    return headers;
  }

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: this.headers(body === undefined ? undefined : "application/json"),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
      });
    } catch (err) {
      throw mapFetchError(err);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw mapHttpStatus(res.status, text);
    }

    const text = await res.text().catch(() => "");
    try {
      return JSON.parse(text) as T;
    } catch {
      throw malformedJsonError(text);
    }
  }

  listModels(): Promise<ListModelsResponse> {
    return this.request<ListModelsResponse>("GET", "/api/v1/models");
  }

  /** Models with at least one loaded instance. */
  async getLoadedModel(): Promise<ListModelsResponse["models"]> {
    const { models } = await this.listModels();
    return models.filter((m) => m.loaded_instances.length > 0);
  }

  loadModel(req: LoadModelRequest, timeoutMs?: number): Promise<LoadModelResponse> {
    return this.request<LoadModelResponse>("POST", "/api/v1/models/load", req, timeoutMs);
  }

  /**
   * Idle-based model load (Phase B). LM Studio's `/models/load` is a blocking
   * POST with no progress events, so while it is in flight we heartbeat-poll a
   * cheap reachability signal (`GET /api/v1/models`) and abort the load only
   * when the endpoint goes silent for the idle window — a slow load that keeps
   * answering is never cut off. `timeoutMs` survives as the outer ceiling, not
   * the primary kill. Never yields partial execution: the load either resolves
   * or throws a structured error.
   */
  async loadModelWithHeartbeat(
    req: LoadModelRequest,
    opts: { timeoutMs?: number; heartbeatIntervalMs?: number; heartbeatIdleMs?: number } = {},
  ): Promise<LoadModelResponse> {
    const intervalMs = opts.heartbeatIntervalMs ?? LOAD_HEARTBEAT_INTERVAL_MS;
    const idleMs = opts.heartbeatIdleMs ?? LOAD_HEARTBEAT_IDLE_MS;
    const ceilingMs = opts.timeoutMs ?? this.timeoutMs;

    const ctrl = new AbortController();
    let outcome: "idle" | "ceiling" | null = null;
    let lastGood = Date.now();
    let heartbeatInFlight = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const ceilingTimer = setTimeout(() => {
      if (outcome === null) {
        outcome = "ceiling";
        ctrl.abort();
      }
    }, ceilingMs);
    const stop = (): void => {
      if (timer !== null) clearInterval(timer);
      clearTimeout(ceilingTimer);
    };

    const heartbeat = async (): Promise<void> => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      let ok = true;
      try {
        const hb = await fetch(`${this.baseUrl}/api/v1/models`, {
          headers: this.headers(),
          signal: AbortSignal.timeout(Math.max(intervalMs, 1_000)),
        });
        if (!hb.ok) ok = false;
      } catch {
        ok = false;
      }
      heartbeatInFlight = false;
      if (ok) {
        lastGood = Date.now();
      } else if (outcome === null && Date.now() - lastGood >= idleMs) {
        outcome = "idle";
        ctrl.abort();
      }
    };
    timer = setInterval(() => {
      void heartbeat();
    }, intervalMs);
    void heartbeat();

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/v1/models/load`, {
        method: "POST",
        headers: this.headers("application/json"),
        body: JSON.stringify(req),
        signal: ctrl.signal,
      });
    } catch (err) {
      stop();
      if (outcome === "idle") {
        throw new NanitesError({
          code: LmErrorCodes.LOAD_IDLE_TIMEOUT,
          message: `LM Studio model load stalled: endpoint silent for ${Math.max(1, Math.round(idleMs / 1000))}s`,
          retryable: false,
          details: { heartbeat_idle_ms: idleMs },
        });
      }
      if (outcome === "ceiling") {
        throw new NanitesError({
          code: LmErrorCodes.TIMEOUT,
          message: "LM Studio model load timed out",
          retryable: false,
          details: { ceiling_ms: ceilingMs },
        });
      }
      throw mapFetchError(err);
    }
    stop();
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw mapHttpStatus(res.status, text);
    }
    const text = await res.text().catch(() => "");
    try {
      return JSON.parse(text) as LoadModelResponse;
    } catch {
      throw malformedJsonError(text);
    }
  }

  unloadModel(req: UnloadModelRequest): Promise<UnloadModelResponse> {
    return this.request<UnloadModelResponse>("POST", "/api/v1/models/unload", req);
  }

  downloadModel(req: DownloadModelRequest): Promise<DownloadModelResponse> {
    return this.request<DownloadModelResponse>("POST", "/api/v1/models/download", req);
  }

  getDownloadStatus(jobId: string): Promise<DownloadStatusResponse> {
    return this.request<DownloadStatusResponse>("GET", `/api/v1/models/download/status/${encodeURIComponent(jobId)}`);
  }

  /**
   * Chat. Streaming calls (`params.stream === true`) are reassembled from the
   * SSE event stream into the same shape as a non-streaming response; the raw
   * event sequence is also returned for the runaway detector.
   *
   * Kill semantics: when `idleTimeoutMs` is supplied the stream is killed by
   * IDLE — a timer reset on every SSE event — not by elapsed time. A model
   * that keeps emitting is never cut off. The fixed per-request ceiling
   * (`timeoutMs`) survives only as (a) a "first event never arrived" guard and
   * (b) an overall soft ceiling raised by `SOFT_CEILING_MULT`. Without
   * `idleTimeoutMs`, behaviour is unchanged (a plain fixed wall-clock abort).
   */
  async chat(
    model: string,
    input: ChatInput,
    params: ChatRequestParams = {},
    opts: {
      onEvent?: (event: ChatStreamEvent) => void;
      idleTimeoutMs?: number;
      /** Endpoint class (see ChatTransport in types.ts). Default native. */
      transport?: ChatTransport;
      /** Per-request idle TTL in seconds on the openai transport (native
       * rejects ttl, so it is never sent there). 0/absent = no ttl. */
      ttl_s?: number;
    } = {},
  ): Promise<ChatResult> {
    if (opts.transport === "openai") {
      return this.openAiChat(model, input, params, opts);
    }
    const stream = params.stream ?? false;
    const body = { model, input, ...params };

    if (!stream) {
      const response = await this.request<ChatResponse>("POST", NATIVE_CHAT_PATH, body);
      return { response };
    }
    if (opts.idleTimeoutMs === undefined) {
      return this.streamChatFixedCeiling(NATIVE_CHAT_PATH, body, opts.onEvent);
    }
    return this.streamChatIdle(NATIVE_CHAT_PATH, body, opts.idleTimeoutMs, opts.onEvent);
  }

  /**
   * OpenAI-compat chat over `/v1/chat/completions` with a per-request `ttl`.
   * Translates the native request/response shapes at this seam: native params
   * pass through verbatim, `max_output_tokens` becomes `max_tokens`, a string
   * input becomes a user message (system_prompt as a leading system message),
   * and the response is synthesized back into the native ChatResponse/ChatStats
   * shape (see synthesizeOpenAiResponse). No integrations/tool loop here —
   * transport eligibility is decided upstream to exclude tool-granted calls.
   */
  private async openAiChat(
    model: string,
    input: ChatInput,
    params: ChatRequestParams,
    opts: { onEvent?: (event: ChatStreamEvent) => void; idleTimeoutMs?: number; ttl_s?: number },
  ): Promise<ChatResult> {
    if (typeof input !== "string") {
      throw new NanitesError({
        code: "invalid_arguments",
        message: "The openai transport takes a plain-text input only",
        retryable: false,
      });
    }
    const body = this.openAiBody(model, input, params, opts.ttl_s);
    const stream = params.stream ?? false;

    if (!stream) {
      const startedAt = performance.now();
      const payload = await this.request<{
        choices?: { message?: { content?: string; reasoning_content?: string } }[];
        usage?: OpenAiUsage;
      }>("POST", OPENAI_CHAT_PATH, body);
      const msg = payload.choices?.[0]?.message;
      const content = typeof msg?.content === "string" ? msg.content : "";
      const response = synthesizeOpenAiResponse(model, {
        content,
        usage: payload.usage ?? null,
        sawReasoning: typeof msg?.reasoning_content === "string" && msg.reasoning_content !== "",
        startedAt,
        endedAt: performance.now(),
        firstContentAt: null,
      });
      return { response };
    }
    const eventsOf = (streamBody: ReadableStream<Uint8Array>): AsyncGenerator<ChatStreamEvent> =>
      openAiChatEvents(streamBody, model);
    if (opts.idleTimeoutMs === undefined) {
      return this.streamChatFixedCeiling(OPENAI_CHAT_PATH, body, opts.onEvent, eventsOf);
    }
    return this.streamChatIdle(OPENAI_CHAT_PATH, body, opts.idleTimeoutMs, opts.onEvent, eventsOf);
  }

  private openAiBody(model: string, input: string, params: ChatRequestParams, ttl_s?: number): Record<string, unknown> {
    const messages: Array<{ role: string; content: string }> = [];
    if (params.system_prompt) messages.push({ role: "system", content: params.system_prompt });
    messages.push({ role: "user", content: input });
    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: params.max_output_tokens,
      ...(params.stream !== undefined ? { stream: params.stream } : {}),
    };
    // LM Studio omits the usage chunk from streams unless asked; stats synthesis
    // (input/output/reasoning tokens, tps) feeds off it. Non-stream responses
    // always carry usage, so this applies only when streaming.
    if (params.stream === true) body.stream_options = { include_usage: true };
    for (const key of PASSTHROUGH_PARAM_KEYS) {
      const value = params[key];
      if (value !== undefined) body[key] = value;
    }
    if (ttl_s && ttl_s > 0) body.ttl = ttl_s;
    return body;
  }

  /** Legacy streaming path: one fixed `AbortSignal.timeout` for the whole call. */
  private async streamChatFixedCeiling(
    path: string,
    body: Record<string, unknown>,
    onEvent?: (event: ChatStreamEvent) => void,
    eventsOf: (streamBody: ReadableStream<Uint8Array>) => AsyncGenerator<ChatStreamEvent> = readSseEvents,
  ): Promise<ChatResult> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: this.headers("application/json"),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw mapFetchError(err);
    }
    return this.consumeChatStream(res, onEvent, eventsOf);
  }

  /** Idle-based streaming path: kill on silence, not elapsed time. */
  private async streamChatIdle(
    path: string,
    body: Record<string, unknown>,
    idleTimeoutMs: number,
    onEvent?: (event: ChatStreamEvent) => void,
    eventsOf: (streamBody: ReadableStream<Uint8Array>) => AsyncGenerator<ChatStreamEvent> = readSseEvents,
  ): Promise<ChatResult> {
    const url = `${this.baseUrl}${path}`;
    const ctrl = new AbortController();
    const ceilingMs = SOFT_CEILING_MULT * this.timeoutMs;

    // Which timer fired (if any) — decides the structured error code. Guarded
    // so the first killer wins and later timer callbacks are no-ops.
    type KillKind = "first_event" | "idle" | "ceiling";
    let killed: KillKind | null = null;
    const kill = (kind: KillKind): void => {
      if (killed === null) {
        killed = kind;
        ctrl.abort();
      }
    };

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const clearTimers = (): void => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      clearTimeout(firstTimer);
      clearTimeout(ceilingTimer);
    };
    // Idle from the start: covers a stream that never emits anything.
    const armIdle = (): void => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => kill("idle"), idleTimeoutMs);
    };
    // A response that sends no first event within the fixed budget keeps the
    // old "timed out" semantics (explicit small budgets still fire promptly).
    const firstTimer = setTimeout(() => kill("first_event"), this.timeoutMs);
    // Belt-and-suspenders: an endless-but-flowing stream still hits a ceiling.
    const ceilingTimer = setTimeout(() => kill("ceiling"), ceilingMs);
    armIdle();

    const idleError = (kind: KillKind | null): NanitesError | null => {
      if (kind === "idle") {
        return new NanitesError({
          code: LmErrorCodes.IDLE_TIMEOUT,
          message: `LM Studio generation stalled: no new tokens for ${Math.max(1, Math.round(idleTimeoutMs / 1000))}s`,
          retryable: false,
          details: { idle_timeout_ms: idleTimeoutMs },
        });
      }
      if (kind === "first_event") {
        return new NanitesError({
          code: LmErrorCodes.TIMEOUT,
          message: "LM Studio request timed out",
          retryable: true,
        });
      }
      if (kind === "ceiling") {
        return new NanitesError({
          code: LmErrorCodes.TIMEOUT,
          message: "LM Studio generation exceeded its time ceiling",
          retryable: false,
          details: { ceiling_ms: ceilingMs },
        });
      }
      return null;
    };

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: this.headers("application/json"),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimers();
      throw idleError(killed) ?? mapFetchError(err);
    }
    if (!res.ok) {
      clearTimers();
      const text = await res.text().catch(() => "");
      throw mapHttpStatus(res.status, text);
    }
    if (!res.body) {
      clearTimers();
      throw new NanitesError({ code: "truncated_stream", message: "LM Studio stream had no body", retryable: true });
    }

    // Every SSE event resets the idle timer — any event means the server is
    // alive, so slow-but-progressing generations are never cut off. The first
    // event also retires the pre-first-event budget (clearTimeout is a no-op
    // after it fires, and if it fired we're already aborting).
    const onIdleEvent = (event: ChatStreamEvent): void => {
      clearTimeout(firstTimer);
      armIdle();
      onEvent?.(event);
    };
    try {
      const { response, events } = await reassembleChatStream(eventsOf(res.body), onIdleEvent);
      clearTimers();
      return { response, events };
    } catch (err) {
      clearTimers();
      throw idleError(killed) ?? err;
    }
  }

  private async consumeChatStream(
    res: Response,
    onEvent?: (event: ChatStreamEvent) => void,
    eventsOf: (streamBody: ReadableStream<Uint8Array>) => AsyncGenerator<ChatStreamEvent> = readSseEvents,
  ): Promise<ChatResult> {
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw mapHttpStatus(res.status, text);
    }
    if (!res.body) {
      throw new NanitesError({ code: "truncated_stream", message: "LM Studio stream had no body", retryable: true });
    }
    const { response, events } = await reassembleChatStream(eventsOf(res.body), onEvent);
    return { response, events };
  }

  /** Lower-level streaming access for the Phase 2 runaway detector. */
  async *streamChatEvents(model: string, input: ChatInput, params: ChatRequestParams = {}): AsyncGenerator<ChatStreamEvent> {
    const url = `${this.baseUrl}/api/v1/chat`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: this.headers("application/json"),
        body: JSON.stringify({ model, input, ...params, stream: true }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw mapFetchError(err);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw mapHttpStatus(res.status, text);
    }
    if (!res.body) {
      throw new NanitesError({
        code: "truncated_stream",
        message: "LM Studio stream had no body",
        retryable: true,
      });
    }
    yield* readSseEvents(res.body);
  }
}
