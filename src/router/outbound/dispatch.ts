/**
 * IR -> provider -> IR.
 *
 * A thin adapter by design. It does NOT re-implement retry, budget retry,
 * empty-reply detection, cost computation, or error classification — all of
 * that is inherited by calling the existing `chatWithBudgetRetry`, which is
 * also where the namespaced-id strip happens. Rewriting any of it here would
 * mean two implementations to keep in sync, and the existing one is the one
 * with the measured Cloudflare edge cases in it.
 */
import type { DatabaseSync } from "node:sqlite";
import { createProviderClient } from "../../providers/client.js";
import { chatWithBudgetRetry, planCloudInference } from "../../providers/cloudPlanner.js";
import { ProviderKeyStore } from "../../storage/providerKeyStore.js";
import { ProviderModelStore } from "../../storage/providerModelStore.js";
import type { ProviderKind } from "../../storage/profileDefaults.js";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ProviderToolDef,
} from "../../providers/types.js";
import { NanitesError } from "../../helpers/errors.js";
import { ROUTER_PROFILE } from "../constants.js";
import { readConfig } from "../auth.js";
import { RouterKeyStore } from "../keys/store.js";
import type { KeyStrategy } from "../keys/selector.js";
import { contentToParts, type IRContentPart, type IRRequest, type IRResponse, type IRStopReason } from "../ir/types.js";
import type { ResolvedTarget } from "./resolve.js";

export interface DispatchInput {
  db: DatabaseSync;
  target: ResolvedTarget;
  request: IRRequest;
  /** The single key to use. Strategy lands in R3. */
  key_id?: string;
}

export function irMessagesToChat(request: IRRequest): ChatMessage[] {
  const out: ChatMessage[] = [];
  // The system prompt is hoisted out of the message list, because every
  // provider client takes it as its own argument.
  if (request.system !== undefined && request.system.length > 0) {
    out.push({ role: "system", content: request.system });
  }
  for (const m of request.messages) {
    const chat: ChatMessage = {
      role: m.role,
      content: toWireContent(m.content),
    };
    if (m.tool_call_id !== undefined) chat.tool_call_id = m.tool_call_id;
    if (m.name !== undefined) chat.name = m.name;
    if (m.tool_calls && m.tool_calls.length) {
      chat.tool_calls = m.tool_calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }));
    }
    out.push(chat);
  }
  return out;
}

/**
 * IR content -> the provider wire shape.
 *
 * R1 is text-only end to end, so a non-text part is rendered as a bracketed
 * marker rather than silently dropped: a caller that sent an image and got a
 * text-only answer deserves to see WHY. R5a replaces this with real modality
 * routing, where an image part is either sent natively or routed to a
 * captioning model.
 */
function toWireContent(content: string | IRContentPart[]): string {
  if (typeof content === "string") return content;
  const parts = contentToParts(content);
  return parts
    .map((p) => {
      if (p.type === "text") return p.text;
      if (p.type === "image_url") return `[image: ${p.url}]`;
      if (p.type === "input_audio") return `[audio: ${p.mime}]`;
      return `[video: ${p.url}]`;
    })
    .join("");
}

export function irToolsToProviderTools(tools: IRRequest["tools"]): ProviderToolDef[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

function stopReasonFor(response: ChatResponse, hadToolCalls: boolean): IRStopReason {
  if (hadToolCalls) return "tool_use";
  switch (response.finish_reason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "stop":
      return "end_turn";
    default:
      return "end_turn";
  }
}

/**
 * Choose the key for this request using the configured strategy.
 *
 * R1 hardcoded "the first available key". R3 runs the user's strategy
 * (random / round-robin / usage-failover / sticky) and persists the cursor.
 * An explicit `keyId` still wins, so a caller can pin one for a single call.
 */
/**
 * Try every key on the NAMED provider until one succeeds.
 *
 * Scoped to the provider ON PURPOSE (design decision D5). A different provider
 * means a different model, a different price, and a different quality, and
 * silently substituting one is a decision the user did not make. When every
 * key here is exhausted, that is a clear error naming the provider — not a
 * quiet answer from somewhere else.
 *
 * `all_keys_exhausted` is a NanitesError, and the error that escapes IS the
 * structured one, so a caller can distinguish "your provider is out of keys"
 * from "the provider is broken".
 */
export async function dispatchWithFailover(input: DispatchInput): Promise<IRResponse> {
  const { db, target, request } = input;

  // The sticky key is tried first, then the strategy's choice, then every
  // remaining key. Pinning the requested key disables failover entirely.
  const attempted = new Set<string>();
  const reasons: Array<{ key_id: string; code: string; message: string }> = [];
  const maxAttempts = input.key_id ? 1 : 8;

  // A 429 is TRANSIENT. Retiring the key on the first one would rotate every
  // account out of service the moment a provider nudges its rate limit, which
  // is the opposite of what the caller asked for. So the same key is retried
  // with backoff first, and only moves on if it is still limited after that.
  const SAME_KEY_RETRIES = 2;
  const backoffMs = (attempt: number): number =>
    Math.min(1000 * 2 ** attempt, 8000) + Math.random() * 500;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const key = input.key_id
      ? selectKey(db, target, input.key_id)
      : nextKey(db, target, attempted);
    if (!key) break;
    attempted.add(key.key_id);

    let sameKeyTries = 0;
    let failure: unknown;
    let failureCode = "unexpected_error";
    // A 429 is transient, so the SAME key is retried with backoff before the
    // pool is advanced. Retiring a key on the first rate limit would rotate
    // every account out of service the moment a provider nudges its limit.
    for (;;) {
      try {
        return await dispatch({ ...input, key_id: key.key_id });
      } catch (err) {
        failure = err;
        failureCode = (err as { code?: string }).code ?? "unexpected_error";
        if (failureCode === "provider_rate_limited" && sameKeyTries < SAME_KEY_RETRIES) {
          sameKeyTries++;
          await new Promise((r) => setTimeout(r, backoffMs(sameKeyTries)));
          continue;
        }
        break;
      }
    }

    // A missing endpoint is a CONFIGURATION error, not an account failure.
    // Retrying it against other keys is meaningless (no key serves it), and
    // converting it to all_keys_exhausted hides the real cause.
    if (failureCode === "endpoint_not_configured") throw failure;

    reasons.push({
      key_id: key.key_id,
      code: failureCode,
      message: failure instanceof Error ? failure.message : String(failure),
    });

    // Only key-scoped failures are worth another key. A 500 or a bad request
    // fails identically on every account, and retrying it just burns latency
    // before returning the same error.
    if (!isKeyScopedCode(failureCode)) throw failure;
    retireKey(db, target.provider, key.key_id, failureCode);
  }

  const err = new NanitesError({
    code: "all_keys_exhausted",
    message: `Every key on provider "${target.provider}" failed. Tried ${reasons.length}.`,
    retryable: true,
    details: {
      provider: target.provider,
      attempted: attempted.size,
      reasons,
    },
  });
  throw err;
}

/** Key-scoped error codes, mirroring providers/errors.ts KEY_SCOPED_CODES. */
const KEY_SCOPED = new Set([
  "provider_auth_error",
  "provider_insufficient_credits",
  "provider_forbidden",
  "provider_quota_exhausted",
  "provider_rate_limited",
]);

function isKeyScopedCode(code: string): boolean {
  return KEY_SCOPED.has(code);
}

/** Retire a key using the existing store's semantics, then re-pick. */
function retireKey(db: DatabaseSync, provider: ProviderKind, keyId: string, code: string): void {
  const keyStore = new ProviderKeyStore(db);
  // The MCP router's measured rules: quota exhaustion lasts until the next UTC
  // midnight, other key-scoped failures for 24h.
  const until = code === "provider_quota_exhausted"
    ? new Date(Date.UTC(
        new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1,
        0, 0, 0, 0,
      ))
    : new Date(Date.now() + 24 * 60 * 60 * 1000);
  keyStore.exhaustKey(ROUTER_PROFILE, provider, keyId, until);
}

/**
 * The next un-attempted key, or null when the provider has none left.
 *
 * A CONFIGURATION error (a named endpoint with no key) is re-thrown rather
 * than swallowed: swallowing it and returning null made the caller see
 * `all_keys_exhausted` with "Tried 0", which points an operator at the wrong
 * problem entirely. Only "no eligible key remains" becomes null.
 */
function nextKey(db: DatabaseSync, target: ResolvedTarget, attempted: Set<string>) {
  for (let i = 0; i < 12; i++) {
    let key;
    try {
      key = selectKey(db, target);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "endpoint_not_configured") throw err;
      return null;
    }
    if (!attempted.has(key.key_id)) return key;
  }
  return null;
}

/**
 * Cost of a completed call, or undefined when the model's rate is unknown.
 *
 * Mirrors the existing `computeCost` in providers/router.ts: the catalog only
 * knows a rate when discovery or a manifest published one, and guessing a rate
 * is worse than reporting nothing. Undefined becomes a NULL metric, never 0.
 */
function computeCostFor(
  db: DatabaseSync,
  target: ResolvedTarget,
  usage: ChatResponse["usage"],
): number | undefined {
  if (!usage) return undefined;
  const store = new ProviderModelStore(db);
  const model = store.getModel(ROUTER_PROFILE, target.provider, target.model_id);
  const prompt = model?.pricing_prompt;
  const completion = model?.pricing_completion;
  if (prompt === null || prompt === undefined) return undefined;
  if (completion === null || completion === undefined) return undefined;
  return (usage.prompt_tokens / 1e6) * prompt + (usage.completion_tokens / 1e6) * completion;
}

export function selectKey(db: DatabaseSync, target: ResolvedTarget, keyId?: string) {
  if (keyId) {
    const available = new ProviderKeyStore(db).availableKeys(ROUTER_PROFILE, target.provider);
    const found = available.find((k) => k.key_id === keyId);
    if (found) return found;
    throw new NanitesError({
      code: "all_keys_exhausted",
      message: `Key ${keyId} is not available on provider "${target.provider}".`,
      retryable: false,
      details: { provider: target.provider, key_id: keyId },
    });
  }

  const config = readConfig(db);
  const store = new RouterKeyStore(db);
  try {
    const picked = store.pickKey({
      provider: target.provider,
      modelId: target.stored_id,
      strategy: (config?.default_strategy as KeyStrategy) ?? "round_robin",
      budgetThreshold: config?.budget_threshold ?? 0.9,
      stickyTtlTurns: config?.sticky_ttl_turns ?? 5,
      fallback: "round_robin",
      random: Math.random,
      endpoint: target.endpoint ?? null,
    });
    // Persist the advanced cursor so round-robin continues across processes.
    new ProviderKeyStore(db).saveKeyState(ROUTER_PROFILE, target.provider, picked.cursor - 1, {});
    return picked.key;
  } catch (err) {
    const code = (err as { code?: string }).code ?? "all_keys_exhausted";
    throw new NanitesError({
      code,
      message: (err as Error).message,
      retryable: false,
      details: (err as { details?: Record<string, unknown> }).details ?? {},
    });
  }
}

export async function dispatch(input: DispatchInput): Promise<IRResponse> {
  const { db, target, request } = input;
  const key = selectKey(db, target, input.key_id);

  const client = createProviderClient(target.provider, key.gateway_url ?? undefined);
  const plan = planCloudInference("medium", "");
  // Honour the caller's ceiling. The planner's value is a default for the MCP
  // server's effort ladder; a gateway caller states it explicitly.
  const effectivePlan = { ...plan, max_output_tokens: request.max_output_tokens };

  const messages = irMessagesToChat(request);
  const tools = irToolsToProviderTools(request.tools);

  const send = (req: ChatRequest): Promise<ChatResponse> =>
    client.chat(req, key.api_key, key.account_id ?? undefined, key.gateway_url ?? undefined);

  const started = Date.now();
  const keyStore = new ProviderKeyStore(db);
  const routerKeys = new RouterKeyStore(db);

  let response: ChatResponse;
  try {
    response = await chatWithBudgetRetry(
      send,
      effectivePlan,
      target.provider,
      target.stored_id,
      messages,
      undefined,
      tools,
      undefined,
      // The gateway's caller is a third-party harness with its own correlation
      // ids. Shipping Nanites' internal call_uid to the provider leaks our
      // bookkeeping and burns tokens on every request.
      false,
    );
  } catch (err) {
    // A failure is recorded BEFORE rethrow, and the sticky pointer is dropped:
    // a pointer to a key that just failed is exactly what stickiness must not
    // do. The key-scoped codes also retire the key via the existing store.
    routerKeys.recordFailure(target.provider, key.key_id);
    routerKeys.clearSticky(target.stored_id);
    keyStore.recordFailure(ROUTER_PROFILE, target.provider, key.key_id);
    throw err;
  }
  const latency = Date.now() - started;

  // Success clears the key's consecutive-failure count, records metrics, and
  // makes this the sticky key for the model.
  keyStore.clearExhaustion(ROUTER_PROFILE, target.provider, key.key_id);
  routerKeys.recordSuccess({
    provider: target.provider,
    keyId: key.key_id,
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
    // undefined -> null. A key with unknown pricing reports null, never 0.
    spentUsd: computeCostFor(db, target, response.usage) ?? null,
    latencyMs: latency,
  });
  const stickyTtl = readConfig(db)?.sticky_ttl_turns ?? 5;
  routerKeys.setSticky(target.stored_id, target.provider, key.key_id, stickyTtl);

  const hadToolCalls = Boolean(response.tool_calls && response.tool_calls.length > 0);
  const content: IRContentPart[] = response.content
    ? [{ type: "text", text: response.content }]
    : [];

  return {
    model: request.model,
    content,
    thinking: response.reasoning || response.reasoning_content
      ? [{ type: "thinking", thinking: response.reasoning ?? response.reasoning_content ?? "" }]
      : [],
    tool_calls: response.tool_calls ?? [],
    stop_reason: stopReasonFor(response, hadToolCalls),
    usage: {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: response.usage?.completion_tokens ?? 0,
    },
    latency_ms: latency,
    served_by: {
      provider: target.provider,
      model_id: target.model_id,
      key_id: key.key_id,
    },
  };
}
