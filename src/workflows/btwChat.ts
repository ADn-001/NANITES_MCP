/**
 * The held `/nanites-btw` chat primitive (btw-spec-v2 §7). The opposite of
 * `runSubAgent`'s load-run-unload: a model is resolved for `context_qa` once,
 * pinned for the chat's lifetime, loaded and held (`instance_id` on the
 * `btw_chat` row), and each dashboard turn calls the LM Studio client `chat()`
 * directly against that instance — never through `run_sub_agent`. Eviction is
 * the ordinary sequential-tier rule (an idle occupant is evictable only between
 * turns — an in-flight chat() call synchronously holds its instance, so nothing
 * can be interrupted mid-turn). Reconnection is silent: a turn whose stored
 * instance has vanished reloads the same `context_qa` selection and continues.
 *
 * This module also hosts the `btw_compact` job BODY (registered by the
 * jobRunner): the job compacts the transcript, then loads + holds the QA model
 * and, when an `initial_question` was given, answers it inline (§4.1).
 */
import { acquireInferenceSlot } from "../helpers/inferenceGate.js";
import { NanitesError } from "../helpers/errors.js";
import type { ToolDeps } from "../tools/deps.js";
import { clientForProfile } from "../tools/deps.js";
import type { LmStudioClient } from "../lmstudio/client.js";
import type { ChatStreamEvent } from "../lmstudio/chatStream.js";
import type { Profile } from "../storage/profileDefaults.js";
import { DEFAULT_OUTPUT_TOKEN_CEILING } from "../storage/profileDefaults.js";
import { cleanReply } from "../helpers/cleaner.js";
import { usageFromStats, usageEstimate } from "../helpers/tokenCounter.js";
import type { ChatOutputItem, MessageOutput } from "../lmstudio/types.js";
import { GENERATION_IDLE_TIMEOUT_MS } from "../helpers/idleTimeout.js";
import { loadTimeoutFor } from "../helpers/performanceScorer.js";
import { findBestModel } from "./roleMatch.js";
import { acquireModel } from "./runSubAgent.js";
import { compactSessionContext, GROUNDED_DIRECTIVE, type CompactResult, type SessionMessage } from "./contextCompactionOrchestrator.js";
import { retrieveRelevantChunks } from "./btwRetrieval.js";
import type { BtwChat } from "../storage/btwChatStore.js";

/** The QA role btw pins per chat (spec §7 — same selection logic as run_sub_agent). */
export const CONTEXT_QA_ROLE = "context_qa";

/** Output cap for a chat turn (answers against a compact profile are bounded). */
export const BTW_ANSWER_OUTPUT_TOKENS = 2048;

export interface BtwChatOpts {
  /** Test seam: overrides the generation idle window (default 30s). */
  idle_timeout_ms?: number;
  /** Test seam: forces the client timeout. */
  clientTimeoutMs?: number;
}

/** Registry selection for `context_qa`, mirroring runSubAgent's default branch.
 * A partial overlap (e.g. a `code_qa`/`reviewer` entry) matches. */
export function resolveQaModel(deps: ToolDeps, profileName: string): string {
  const match = findBestModel(deps.registry.listLocal(profileName), [CONTEXT_QA_ROLE]);
  if (!match) {
    throw new NanitesError({
      code: "no_model_for_role",
      message: `No registry entry matches role "${CONTEXT_QA_ROLE}" — register one before chatting in /nanites-btw`,
      retryable: false,
      details: { role: CONTEXT_QA_ROLE },
    });
  }
  return match.entry.model_id;
}

function costFor(profile: Profile, tokensIn: number, tokensOut: number): number {
  return (
    (tokensIn / 1_000_000) * profile.pricing.input_per_million_usd +
    (tokensOut / 1_000_000) * profile.pricing.output_per_million_usd
  );
}

/**
 * The system prompt for a held-chat turn: compact profile + retrieved chunk
 * summaries with their message ranges + the grounding directive (§11). Chunk
 * citations let the model reference ranges rather than assert flatly.
 */
export function buildBtwChatSystemPrompt(deps: ToolDeps, profileName: string, query: string): string {
  const summary = deps.contextCache.getSummary(profileName);
  const compact = summary?.summary?.trim() ? summary.summary : "No session context has been compacted yet.";
  const chunks = retrieveRelevantChunks(deps, profileName, query);
  const chunkBlock = chunks.length
    ? chunks.map((c) => `[messages ${c.msg_start}-${c.msg_end}] ${c.summary}`).join("\n\n")
    : "No relevant session chunks retrieved.";
  return [
    "You are the working-memory assistant for this session, grounded in a compact profile of prior work.",
    GROUNDED_DIRECTIVE,
    "",
    "COMPACT PROFILE:",
    compact,
    "",
    "RELEVANT CHUNKS:",
    chunkBlock,
    "",
    "Answer the user's question from the profile and chunks; say plainly when the answer is not in them.",
  ].join("\n");
}

function messageText(output: ChatOutputItem[]): string {
  return output
    .filter((o): o is MessageOutput => o.type === "message")
    .map((o) => o.content)
    .join("\n");
}

/** Ensure the chat's pinned model is resident; (re)acquire when it vanished
 * (silent reconnection, §7). Updates the row with the live instance id. */
export async function ensureHeldInstance(
  deps: ToolDeps,
  profile: Profile,
  chat: BtwChat,
  client: LmStudioClient,
): Promise<{ modelId: string; instanceId: string }> {
  const modelId = chat.model_id ?? resolveQaModel(deps, profile.name);
  const loadTimeoutMs = loadTimeoutFor(deps.registry.get(profile.name, modelId)?.avg_load_ms ?? null);
  const acquired = await acquireModel(client, profile, modelId, loadTimeoutMs);
  deps.btwChat.set({
    ...chat,
    status: "ready",
    model_id: modelId,
    instance_id: acquired.instance_id,
    last_activity_at: new Date().toISOString(),
  });
  return { modelId, instanceId: acquired.instance_id };
}

/**
 * One dashboard chat turn: append the user message, answer through the held
 * (or re-acquired) instance, append the assistant reply, log the turn, and
 * stream deltas over the sub-agent-events channel (which `/api/stream` fans to
 * Vox Terminus). Returns the cleaned assistant reply.
 */
async function runBtwChatMessageUngated(
  deps: ToolDeps,
  profileName: string,
  content: string,
  opts: BtwChatOpts = {},
): Promise<{ reply: string; model_id: string; instance_id: string; reacquired: boolean }> {
  const profile = deps.profiles.getProfile(profileName);
  if (!profile) {
    throw new NanitesError({ code: "profile_not_found", message: `No profile named "${profileName}"`, retryable: false });
  }
  const chat = deps.btwChat.get(profileName);
  if (!chat) {
    throw new NanitesError({
      code: "btw_chat_not_found",
      message: "No active /nanites-btw chat for this profile — start one first",
      retryable: false,
    });
  }

  // Append the user turn first so a crash still leaves a faithful transcript.
  deps.btwChatMessages.append(profileName, "user", content);

  const client = clientForProfile(profile, opts.clientTimeoutMs ? { timeoutMs: opts.clientTimeoutMs } : undefined);
  const idleTimeoutMs = opts.idle_timeout_ms ?? GENERATION_IDLE_TIMEOUT_MS;

  // Silent reconnection: ensureHeldInstance reloads when the stored instance
  // vanished (evicted or idle-swept) — no error, the turn just takes longer.
  const before = chat.instance_id;
  const held = await ensureHeldInstance(deps, profile, chat, client);
  const reacquired = before !== held.instanceId;
  const modelId = held.modelId;

  const emit = (phase: string, payload: Record<string, unknown> = {}): void => {
    deps.subAgentEvents.insert({ profile_name: profileName, model_id: modelId, phase, payload });
  };

  const systemPrompt = buildBtwChatSystemPrompt(deps, profileName, content);
  const maxOutputTokens = profile.inference?.output_token_ceiling ?? DEFAULT_OUTPUT_TOKEN_CEILING;

  let pendingContent = "";
  let lastFlush = 0;
  const flush = (force: boolean): void => {
    if (!pendingContent) return;
    if (!force && pendingContent.length < 40 && Date.now() - lastFlush < 250) return;
    emit("chat.content", { text: pendingContent });
    pendingContent = "";
    lastFlush = Date.now();
  };

  emit("chat.start", { role: CONTEXT_QA_ROLE, question: content.slice(0, 120) });
  const started = Date.now();
  const { response } = await client.chat(
    held.instanceId,
    content,
    { system_prompt: systemPrompt, temperature: 0.3, max_output_tokens: maxOutputTokens, stream: true },
    {
      idleTimeoutMs,
      onEvent: (ev: ChatStreamEvent): void => {
        const data = ev.data as { content?: unknown };
        if (ev.type === "message.delta" && typeof data.content === "string") {
          pendingContent += data.content;
          flush(false);
        } else if (ev.type === "chat.end") {
          flush(true);
        }
      },
    },
  );
  flush(true);
  const reply = cleanReply(messageText(response.output), { maxChars: 100_000 }).text;
  emit("chat.end", { tok_s: response.stats.tokens_per_second });
  if (reply) emit("chat.reply", { text: reply });

  deps.btwChatMessages.append(profileName, "assistant", reply);
  deps.btwChat.touch(profileName);

  const usage = response.stats ? usageFromStats(response.stats) : usageEstimate([content], reply);
  deps.callLogs.insert({
    profile_name: profileName,
    model_id: modelId,
    task: content.slice(0, 200),
    role: CONTEXT_QA_ROLE,
    tokens_in: usage.inputTokens,
    tokens_out: usage.outputTokens,
    duration_ms: Date.now() - started,
    cost_usd: costFor(profile, usage.inputTokens, usage.outputTokens),
    ttft_ms: response.stats ? Math.round(response.stats.time_to_first_token_seconds * 1000) : null,
    error_code: null,
    context_window: null,
  });

  return { reply, model_id: modelId, instance_id: held.instanceId, reacquired };
}

/**
 * CP-4: a chat turn and a compaction each hold a model for an inference, so
 * they take the same per-profile gate runSubAgent uses. Without it, a
 * concurrent sub-agent on a sequential profile evicts the instance from under
 * the run in progress.
 */
export async function runBtwChatMessage(
  deps: ToolDeps,
  profileName: string,
  content: string,
  opts: BtwChatOpts = {},
): Promise<{ reply: string; model_id: string; instance_id: string; reacquired: boolean }> {
  const release = await acquireInferenceSlot(profileName);
  try {
    return await runBtwChatMessageUngated(deps, profileName, content, opts);
  } finally {
    release();
  }
}

/** Payload the `btw_compact` job carries. */
export interface StartBtwChatJobPayload {
  /** Host session transcript to compact. */
  messages: SessionMessage[];
  /** Answer this question inline once the held chat is ready (§4.1). */
  initial_question?: string;
  idle_timeout_ms?: number;
  clientTimeoutMs?: number;
}

export interface StartBtwChatJobResult {
  compact: CompactResult;
  answer?: { reply: string; model_id: string };
}

/**
 * The `btw_compact` job body: compact the transcript, pin + hold the
 * `context_qa` model, then answer the initial question inline when given. Runs
 * under the profile's reserved FIFO slot, so it can never stall or eject a
 * running real job (§9). Errors mark the `btw_chat` row `error` before the
 * jobRunner records the failure.
 */
export async function runBtwCompactJob(
  deps: ToolDeps,
  profileName: string,
  payload: Record<string, unknown>,
): Promise<StartBtwChatJobResult> {
  const p = payload as unknown as StartBtwChatJobPayload;
  try {
    const compact = await compactSessionContext(deps, profileName, p.messages ?? [], {
      idle_timeout_ms: p.idle_timeout_ms,
      clientTimeoutMs: p.clientTimeoutMs,
    });

    // The row was seeded (status `compacting`) before the job was enqueued.
    const chat = deps.btwChat.get(profileName);
    if (!chat) {
      throw new NanitesError({ code: "btw_chat_not_found", message: "btw_chat row vanished before compaction finished", retryable: false });
    }
    const profile = deps.profiles.getProfile(profileName)!;
    const client = clientForProfile(profile, p.clientTimeoutMs ? { timeoutMs: p.clientTimeoutMs } : undefined);
    const held = await ensureHeldInstance(deps, profile, chat, client);

    if (!p.initial_question || p.initial_question.trim() === "") {
      return { compact };
    }
    const { reply } = await runBtwChatMessage(deps, profileName, p.initial_question, {
      idle_timeout_ms: p.idle_timeout_ms,
      clientTimeoutMs: p.clientTimeoutMs,
    });
    return { compact, answer: { reply, model_id: held.modelId } };
  } catch (err) {
    const chat = deps.btwChat.get(profileName);
    if (chat) {
      deps.btwChat.set({ ...chat, status: "error", instance_id: chat.instance_id });
    }
    throw err;
  }
}
