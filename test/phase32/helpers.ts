/**
 * Phase 32 (Phase H) harness — /nanites-btw end-to-end. Builds on the phase8
 * stateful mock LM Studio (loads/unloads/chats are counted and resident state
 * derives from live calls), then drives the real btw stores, compaction
 * orchestrator, held-chat primitive, job FIFO, and UI HTTP endpoints that the
 * MCP tools wrap. Distinct model ids for the two btw roles keep the summarizer
 * load (map/reduce, unloaded after) separate from the held QA load (resident).
 */
import type { ToolDeps } from "../../src/tools/deps.js";
import type { RegistryEntry } from "../../src/storage/registryStore.js";
import type { JobRecord } from "../../src/storage/jobStore.js";
import type { CacheStatus, SessionMessage } from "../../src/workflows/contextCompactionOrchestrator.js";
import { createSubAgentHarness, type SubAgentHarness } from "../phase8/helpers.js";
import { sleep } from "../phase29/helpers.js";

export const SUM_MODEL = "mock/btw-summarizer-8b";
export const QA_MODEL = "mock/btw-qa-8b";
export const REAL_MODEL = "openai/gpt-oss-20b";

export const SUMMARIZER_ROLE = "context_chunk_summarizer";
export const QA_ROLE = "context_qa";

function entry(modelId: string, roles: string[]): RegistryEntry {
  return {
    model_id: modelId,
    roles,
    scores: Object.fromEntries(roles.map((r) => [r, 70])),
    best_params: {},
    last_tested: null,
    performance_score: 70,
  };
}

export function summarizerEntry(): RegistryEntry {
  return entry(SUM_MODEL, [SUMMARIZER_ROLE]);
}

export function qaEntry(): RegistryEntry {
  return entry(QA_MODEL, [QA_ROLE]);
}

/** Deterministic per-index transcript so prefixes diff stably across calls:
 * `mkMessages(seed, n)` is always a prefix of `mkMessages(seed, n+k)`. Each
 * message is long enough (≈1500 chars/4 tokens) to form its own chunk. */
export function mkMessages(seed: string, n: number): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: i % 2 === 0 ? "user" : "assistant", content: `${seed}#${i} ` + "m".repeat(6000) });
  }
  return out;
}

export interface BtwHarness extends SubAgentHarness {
  /** Seed a ready btw chat row for profile "t" without running a compaction job. */
  seedChatRow(modelId: string): void;
  /** Poll `deps.jobs.get(jobId)` until done/error; returns the terminal record. */
  waitJobDone(jobId: number, desc?: string, timeoutMs?: number): Promise<JobRecord>;
}

export async function createBtwHarness(opts: Parameters<typeof createSubAgentHarness>[0] = {}): Promise<BtwHarness> {
  const h = await createSubAgentHarness(opts);
  const btw = h as BtwHarness;
  btw.seedChatRow = (modelId: string): void => {
    h.deps.btwChat.set({
      profile_name: "t",
      status: "ready",
      job_id: null,
      model_id: modelId,
      instance_id: null,
      last_activity_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });
  };
  btw.waitJobDone = async (jobId: number, desc = `job ${jobId}`, timeoutMs = 20_000): Promise<JobRecord> => {
    const start = Date.now();
    for (;;) {
      const job = h.deps.jobs.get(jobId);
      if (job && (job.status === "done" || job.status === "error")) {
        if (job.status === "error") throw new Error(`${desc} ended with error: ${JSON.stringify(job.result)}`);
        return job;
      }
      if (Date.now() - start >= timeoutMs) throw new Error(`timed out waiting for ${desc}`);
      await sleep(25);
    }
  };
  return btw;
}

export interface CompactOut {
  status: CacheStatus;
  new_message_count: number;
  chunk_count: number;
  chats_run: number;
}

export function compactOut(result: { compact?: Record<string, unknown> } | null | undefined): CompactOut {
  const c = result?.compact ?? {};
  return {
    status: c.cache_status as CacheStatus,
    new_message_count: (c.new_message_count as number) ?? 0,
    chunk_count: (c.chunk_count as number) ?? 0,
    chats_run: (c.chats_run as number) ?? 0,
  };
}

/** Free the held QA instance as if LM Studio had evicted it, then return a
 * client usable for the silent-reacquire path. */
export function stripHeldInstance(deps: ToolDeps): void {
  deps.btwChat.set({ ...deps.btwChat.get("t")!, instance_id: null });
}
