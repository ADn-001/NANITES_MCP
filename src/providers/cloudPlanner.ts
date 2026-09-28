/**
 * Cloud inference planner. Simpler than the local planner since cloud models:
 * - Have massive context windows (no context_length planning needed)
 * - Are not loaded/unloaded by Nanites (no load_ms tracking)
 * - Use fixed temperature 0.3 (high-quality cloud models)
 *
 * Generates a call_uid for parallel tracking and derives token/reasoning
 * params from the effort level.
 */
import { randomUUID } from "node:crypto";
import { wireModelId } from "../storage/providerModelId.js";
import type { ChatMessage, ChatRequest, ChatResponse, ProviderToolDef, ResponseFormat } from "./types.js";
import type { Effort } from "../helpers/inferencePlanner.js";
import type { ProviderKind } from "../storage/profileDefaults.js";
import { NanitesError } from "../helpers/errors.js";
import { PROVIDER_ERROR_CODES } from "./errors.js";
import { responseFormatFor } from "./outputSchema.js";

export interface CloudInferencePlan {
  max_output_tokens: number;
  reasoning: "on" | "off" | undefined;
  reasoning_budget?: number;
  /** The effort that produced `reasoning`; needed to emit the provider-native
   * reasoning field (OpenRouter effort object / OpenAI reasoning_effort). */
  reasoning_effort?: Effort;
  temperature: number;
  call_uid: string;
}

/**
 * Cloud output ceiling. This is a *cap*, not a spend — models stop when they
 * are done, and only emitted tokens bill — but it must be large enough to hold
 * the thinking tokens AND the answer. Reasoning models on Cloudflare spend
 * their entire budget on the reasoning field before emitting any content, so a
 * 4096 cap yields an empty `content` with `finish_reason: "length"` (measured
 * live: qwen3-30b returned 0 content chars and a 17,465-char reasoning field at
 * 4096, on a model that ignores `reasoning_effort`; gpt-oss-120b truncated at
 * the same cap and needed ~3.4k completion tokens from a 16384 budget).
 *
 * The floor is therefore 12288, not 4096: an unused cap costs nothing, whereas
 * an exhausted one is a silent empty reply. At an 8192 cap the same qwen3 brief
 * returned content but consumed 7,601 of the 8,192 tokens — too little headroom
 * to survive a longer brief, so the floor sits above the observed worst case.
 */
const CLOUD_OUTPUT_CEILING = 32_768;

/** Effort maps to a fraction of the cloud ceiling (12288 / 16384 / 32768). */
const EFFORT_FRACTION: Record<Effort, number> = {
  low: 3 / 8,
  medium: 1 / 2,
  high: 1,
};

/** Cloud models are high-quality; fixed temperature. */
const CLOUD_TEMPERATURE = 0.3;

const REASONING_BUDGET_MULT: Record<Effort, number> = {
  low: 1,
  medium: 1.25,
  high: 1.5,
};

const DIFFICULT_ROLES = new Set([
  "code_writer",
  "refactorer",
  "code_qa",
  "test_writer",
  "reviewer",
]);

export function planCloudInference(
  effort: Effort,
  role: string,
  reasoningBudgetOverride?: number,
  /** Caller-supplied ceiling for a call whose output is known to be small (the
   * finalize round: one JSON object, no reasoning needed). The
   * effort fraction is sized for a report plus its thinking tokens, which is
   * the wrong shape for a formatting round. */
  maxOutputTokensOverride?: number,
): CloudInferencePlan {
  const call_uid = randomUUID();
  const max_output_tokens = maxOutputTokensOverride
    ? Math.max(1, Math.round(maxOutputTokensOverride))
    : Math.max(1, Math.round(CLOUD_OUTPUT_CEILING * EFFORT_FRACTION[effort]));

  let reasoning: "on" | "off" | undefined;
  if (effort === "low") {
    reasoning = "off";
  } else {
    const wantsReasoning = effort === "high" || DIFFICULT_ROLES.has(role);
    if (wantsReasoning) reasoning = "on";
  }

  let reasoning_budget: number | undefined;
  if (reasoning === "on") {
    reasoning_budget = reasoningBudgetOverride ?? Math.round(max_output_tokens * REASONING_BUDGET_MULT[effort]);
  }

  return {
    max_output_tokens,
    reasoning,
    ...(reasoning_budget !== undefined ? { reasoning_budget } : {}),
    ...(reasoning === "on" ? { reasoning_effort: effort } : {}),
    temperature: CLOUD_TEMPERATURE,
    call_uid,
  };
}

/**
 * Emit the provider-native reasoning field for a request. Providers disagree:
 * OpenRouter validates `reasoning` as an object `{ effort }`; OpenAI-compatible
 * endpoints take `reasoning_effort` as a string; Cloudflare Workers AI's
 * non-reasoning models (all currently registered ones) reject/ignore nothing —
 * we omit the field. Sending the raw Nanites string (`reasoning:"on"`) is what
 * a strict OpenAI-compat validator (e.g. OpenRouter) rejects with a 400.
 */
function setProviderReasoning(
  req: ChatRequest,
  provider: ProviderKind,
  plan: CloudInferencePlan,
): void {
  const effort = plan.reasoning_effort ?? "medium";
  if (provider === "openrouter") {
    if (plan.reasoning !== "on") return;
    req.reasoning = { effort };
    return;
  }
  if (provider === "generic" || provider === "omniroute") {
    if (plan.reasoning !== "on") return;
    req.reasoning_effort = effort;
    return;
  }
  // cloudflare: always send reasoning_effort. When we did not ask for reasoning
  // we send "low", which measurably suppresses the default-on thinking of
  // gpt-oss models (reasoning field 7989 chars -> 90 chars on the same brief).
  // Models that do not honour the field (qwen3) simply ignore it, which is
  // harmless. Do NOT use chat_template_kwargs to disable thinking: measured
  // unreliable — ignored by gpt-oss, and on qwen3 it produced an empty
  // `content` with `finish_reason: "stop"`.
  req.reasoning_effort = plan.reasoning === "on" ? effort : "low";
}

/** Build a ChatRequest from a cloud inference plan. */
export function buildCloudChatRequest(
  plan: CloudInferencePlan,
  provider: ProviderKind,
  model: string,
  messages: ChatMessage[],
  systemPrompt?: string,
  tools?: ProviderToolDef[],
  responseFormat?: ResponseFormat,
): ChatRequest {
  const msgs: ChatMessage[] = [];
  if (systemPrompt) {
    msgs.push({ role: "system", content: systemPrompt });
  }
  // Inject call_uid for parallel tracking
  msgs.push({ role: "system", content: `[INTERNAL_CALL_UID: ${plan.call_uid}]` });
  msgs.push(...messages);

  // Cloudflare deprecates `max_tokens` in favour of `max_completion_tokens`
  // (measured identical behaviour on the current endpoint, so the switch is
  // future-proofing). The other providers keep `max_tokens`.
  const req: ChatRequest =
    provider === "cloudflare"
      ? { model, messages: msgs, max_completion_tokens: plan.max_output_tokens, temperature: plan.temperature }
      : { model, messages: msgs, max_tokens: plan.max_output_tokens, temperature: plan.temperature };
  setProviderReasoning(req, provider, plan);
  if (tools && tools.length > 0) {
    req.tools = tools;
    // Stated rather than inherited: the loop handles N calls per turn, and a
    // provider default flip would silently serialise them.
    req.parallel_tool_calls = true;
  }
  // Structured output belongs on the answer round only. A request
  // carrying both tools and a schema is the combination CF's own docs call
  // fragile across models, so tools win and the schema is dropped rather than
  // risking a 400 mid-loop.
  if (responseFormat && !(tools && tools.length > 0)) {
    req.response_format = responseFormatFor(provider, responseFormat);
  }
  return req;
}

/** Same plan, twice the output budget. Used for the one-shot empty-reply retry. */
export function doubleCloudBudget(plan: CloudInferencePlan): CloudInferencePlan {
  return { ...plan, max_output_tokens: plan.max_output_tokens * 2 };
}

/**
 * A reply carrying neither text nor tool calls is a failure, whatever the
 * provider claims. `finish_reason` cannot be trusted as the signal: measured
 * live, an empty reply can arrive with `"stop"` as well as `"length"`.
 * A tool-calls-only turn is legitimate — the loop executes them — so calls
 * count as content here.
 */
export function isEmptyCloudReply(resp: { content?: string; tool_calls?: unknown[] }): boolean {
  const hasText = typeof resp.content === "string" && resp.content.trim().length > 0;
  const hasCalls = Array.isArray(resp.tool_calls) && resp.tool_calls.length > 0;
  return !hasText && !hasCalls;
}

/**
 * Call a cloud model, refusing to pass an empty reply up the stack.
 *
 * An empty reply is the failure mode this whole phase exists to kill: the
 * request succeeds, the provider bills it, and the caller receives `""` that
 * looks like a legitimate answer. We retry once at double the budget — the
 * measured cause is a reasoning model exhausting the budget on its thinking
 * field — and if that is empty too we raise `provider_budget_exhausted` rather
 * than return nothing.
 *
 * `send` is injected so the retry can be exercised without a live provider.
 */
export async function chatWithBudgetRetry(
  send: (req: ChatRequest) => Promise<ChatResponse>,
  plan: CloudInferencePlan,
  provider: ProviderKind,
  model: string,
  messages: ChatMessage[],
  systemPrompt?: string,
  tools?: ProviderToolDef[],
  responseFormat?: ResponseFormat,
): Promise<ChatResponse> {
  // A generic model id may carry its endpoint namespace
  // (`generic:<endpoint>:<model>`) so the router can pin the call to one
  // gateway. The gateway only knows its own model name, so the prefix is
  // stripped here — the single place every request body is built, including
  // the doubled-budget retry below, which is why the router cannot strip it at
  // its own call site and expect the retry to inherit the fix.
  const wireModel = wireModelId(model);
  const resp = await send(buildCloudChatRequest(plan, provider, wireModel, messages, systemPrompt, tools, responseFormat));
  if (!isEmptyCloudReply(resp)) return resp;

  const doubled = doubleCloudBudget(plan);
  const retryResp = await send(buildCloudChatRequest(doubled, provider, wireModel, messages, systemPrompt, tools, responseFormat));
  if (!isEmptyCloudReply(retryResp)) return retryResp;

  throw new NanitesError({
    code: PROVIDER_ERROR_CODES.BUDGET_EXHAUSTED,
    message:
      `Model ${model} returned an empty reply at ${plan.max_output_tokens} and again at ` +
      `${doubled.max_output_tokens} max_completion_tokens (finish_reason: ${retryResp.finish_reason ?? "none"}).`,
    retryable: false,
    details: {
      model_id: model,
      provider,
      finish_reason: retryResp.finish_reason ?? null,
      attempted_budget: doubled.max_output_tokens,
    },
  });
}
