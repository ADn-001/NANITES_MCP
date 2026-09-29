/**
 * Streaming dispatch.
 *
 * Separate from `dispatch.ts` rather than in it: the non-streaming path and
 * the streaming path share the IR translation and key selection but differ in
 * how they talk to the provider, and merging them made the file hard to follow.
 */
import type { DatabaseSync } from "node:sqlite";
import { createProviderClient, readErrorBody, readSseLines, serializeChatRequest } from "../../providers/client.js";
import { buildCloudChatRequest, planCloudInference } from "../../providers/cloudPlanner.js";
import { wireModelId } from "../../storage/providerModelId.js";
import { mapFetchError, mapHttpStatus } from "../../providers/errors.js";
import { NanitesError } from "../../helpers/errors.js";
import type { ProviderKind } from "../../storage/profileDefaults.js";
import type { IRServedBy } from "../ir/types.js";
import { foldChunk, finalizeAssembly, newAssembly, type Assembled, type UpstreamEvent } from "../stream/upstream.js";
import { selectKey, irMessagesToChat, irToolsToProviderTools, type DispatchInput } from "./dispatch.js";

export interface StreamDispatchInput extends DispatchInput {
  /** Called for every upstream delta. Must not throw. */
  onEvent: (event: UpstreamEvent) => Promise<void>;
  /** Aborted when the client hangs up, so the provider call stops. */
  signal?: AbortSignal;
}

export interface StreamDispatchResult {
  assembled: Assembled;
  latency_ms: number;
  served_by: IRServedBy;
}

/**
 * Chat-completions URL for a provider, mirroring the four clients in
 * client.ts. Duplicated rather than reached through ProviderClient because
 * `streamChat` there discards tool-call deltas and stream usage — both of
 * which the router must not lose. The parsing itself is shared: this uses the
 * same `readSseLines` and `serializeChatRequest` the clients use.
 */
function chatUrl(provider: ProviderKind, base: string, accountId: string | null): string {
  if (provider === "cloudflare") {
    if (!accountId) {
      throw new NanitesError({
        code: "provider_auth_error",
        message: "Cloudflare requires an account id on the key.",
        retryable: false,
      });
    }
    return `${base}/accounts/${accountId}/ai/v1/chat/completions`;
  }
  return `${base}/chat/completions`;
}

function authHeaders(provider: ProviderKind, key: string): Record<string, string> {
  // Generic gateways may be keyless, so the header is conditional there — the
  // same rule GenericClient applies.
  if (provider === "generic" && !key) return { "Content-Type": "application/json" };
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

export interface OpenedUpstream {
  /** Lazily-started, never-blocking iteration of upstream events. */
  events(): AsyncGenerator<UpstreamEvent>;
  /** Resolves once the stream is drained, with the assembled reply. */
  result: Promise<Assembled>;
  /** Cancel the upstream fetch, unwinding the reader. Used on client hang-up. */
  cancel(): void;
}

/**
 * Open the provider stream WITHOUT waiting for it to finish.
 *
 * Split from `dispatchStream` so the caller can decide whether to commit HTTP
 * headers before or after the upstream accepts the request. The router commits
 * only after this resolves, which is what lets a pre-delta failure return a
 * proper JSON error instead of a 200 followed by silence.
 */
export async function openUpstreamStream(input: Omit<StreamDispatchInput, "onEvent">): Promise<OpenedUpstream> {
  const { db, target, request, signal } = input;
  // The streaming path uses the same strategy-based selection as the
  // non-streaming one. Failover is NOT applied here: a stream that has already
  // emitted content blocks cannot be restarted on another key without
  // producing a duplicated, interleaved transcript. A pre-first-delta failure
  // surfaces as a normal error, which is the honest outcome.
  const key = selectKey(db, target, input.key_id);
  const client = createProviderClient(target.provider, key.gateway_url ?? undefined);
  const base = key.gateway_url ?? client.baseUrl;

  const plan = planCloudInference("medium", "");
  const effectivePlan = { ...plan, max_output_tokens: request.max_output_tokens };

  const req = buildCloudChatRequest(
    effectivePlan,
    target.provider,
    wireModelId(target.stored_id),
    irMessagesToChat(request),
    undefined,
    irToolsToProviderTools(request.tools),
    undefined,
    false,
  );
  req.stream = true;

  // Own the abort controller so teardown can cancel the fetch without
  // touching a stream the reader has already locked.
  const controller = new AbortController();
  const onCallerAbort = (): void => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timeout = AbortSignal.timeout(240_000);
  const composite = AbortSignal.any([controller.signal, timeout]);

  let res: Response;
  try {
    res = await fetch(chatUrl(target.provider, base, key.account_id), {
      method: "POST",
      headers: authHeaders(target.provider, key.api_key),
      body: JSON.stringify(serializeChatRequest(req)),
      signal: composite,
    });
  } catch (err) {
    signal?.removeEventListener("abort", onCallerAbort);
    throw mapFetchError(err);
  }

  if (!res.ok) {
    signal?.removeEventListener("abort", onCallerAbort);
    throw mapHttpStatus(res.status, await readErrorBody(res), target.provider);
  }
  if (!res.body) {
    signal?.removeEventListener("abort", onCallerAbort);
    throw new NanitesError({
      code: "truncated_stream",
      message: "The provider returned a stream with no body.",
      retryable: true,
    });
  }

  const state = newAssembly();
  const queue: UpstreamEvent[] = [];
  let done = false;
  let failure: unknown = null;
  // A single waker object rather than a `let wake: (() => void) | null`.
  // TypeScript narrows a let-captured closure variable to `never` inside the
  // async body, which is unsound here because the consumer reassigns it.
  const waker: { fn: (() => void) | null } = { fn: null };

  const result: Promise<Assembled> = (async (): Promise<Assembled> => {
    try {
      for await (const line of readSseLines(res.body!)) {
        for (const event of foldChunk(state, line)) {
          queue.push(event);
          const w = waker.fn;
          waker.fn = null;
          w?.();
        }
        if (controller.signal.aborted) break;
      }
    } catch (err) {
      // An abort is an expected teardown, not a failure to report upward.
      if (!controller.signal.aborted) failure = err;
    } finally {
      signal?.removeEventListener("abort", onCallerAbort);
      done = true;
      const w = waker.fn;
      waker.fn = null;
      w?.();
    }
    if (failure) throw failure;
    return finalizeAssembly(state);
  })();
  // Nothing awaits `result` until the events are drained; swallow the
  // rejection here so it cannot become an unhandled rejection in between.
  result.catch(() => undefined);

  async function* iterate(): AsyncGenerator<UpstreamEvent> {
    while (true) {
      while (queue.length) yield queue.shift()!;
      if (done) break;
      await new Promise<void>((resolve) => {
        waker.fn = resolve;
      });
    }
    while (queue.length) yield queue.shift()!;
  }

  return {
    events: iterate,
    result: result.then((a) => a),
    // The reader owns the stream once readSseLines has started, so
    // `body.cancel()` throws "Invalid state: ReadableStream is locked" — an
    // unhandled rejection on every streamed request. Aborting the controller
    // is the correct teardown; the reader unwinds from it.
    cancel: () => controller.abort(),
  };
}

export async function dispatchStream(input: StreamDispatchInput): Promise<StreamDispatchResult> {
  const { db, target, request, onEvent, signal } = input;
  const key = selectKey(db, target, input.key_id);
  const client = createProviderClient(target.provider, key.gateway_url ?? undefined);
  const base = key.gateway_url ?? client.baseUrl;

  const plan = planCloudInference("medium", "");
  const effectivePlan = { ...plan, max_output_tokens: request.max_output_tokens };

  const messages = irMessagesToChat(request);
  const tools = irToolsToProviderTools(request.tools);

  const req = buildCloudChatRequest(
    effectivePlan,
    target.provider,
    // The strip belongs HERE, not in chatWithBudgetRetry. The non-streaming
    // path goes through that function and gets it for free; this path does
    // not, and was sending `cloudflare:@cf/meta/...` straight to the provider,
    // which answers "No such model". Caught only by the E2E — every stubbed
    // test used a bare id, so the namespaced form was never exercised.
    wireModelId(target.stored_id),
    messages,
    undefined,
    tools,
    undefined,
    false,
  );
  req.stream = true;

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(chatUrl(target.provider, base, key.account_id), {
      method: "POST",
      headers: authHeaders(target.provider, key.api_key),
      body: JSON.stringify(serializeChatRequest(req)),
      // Bound to the caller's disconnect so a hung-up harness stops billing.
      signal: signal ?? AbortSignal.timeout(240_000),
    });
  } catch (err) {
    throw mapFetchError(err);
  }

  if (!res.ok) {
    throw mapHttpStatus(res.status, await readErrorBody(res), target.provider);
  }
  if (!res.body) {
    throw new NanitesError({
      code: "truncated_stream",
      message: "The provider returned a stream with no body.",
      retryable: true,
    });
  }

  const state = newAssembly();
  for await (const line of readSseLines(res.body)) {
    for (const event of foldChunk(state, line)) {
      await onEvent(event);
    }
    if (signal?.aborted) break;
  }

  return {
    assembled: finalizeAssembly(state),
    latency_ms: Date.now() - started,
    served_by: { provider: target.provider, model_id: target.model_id, key_id: key.key_id },
  };
}
