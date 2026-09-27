/**
 * Tool dependency bundle: the storage + LM Studio wiring every tool handler
 * needs. One bundle is built per server; tests may pass their own to isolate
 * under NANITES_HOME.
 */
import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { openNanitesDb } from "../storage/db.js";
import { setTokenizerProvider } from "../helpers/tokenize.js";
import { huggingfaceTokenizerProvider } from "../helpers/tokenizerProvider.js";
import { ProfileManager } from "../storage/profileManager.js";
import { RegistryStore } from "../storage/registryStore.js";
import { CallLogStore } from "../storage/callLogStore.js";
import { ProviderCallLogStore } from "../storage/providerCallLogStore.js";
import { TestResultStore } from "../storage/testResultStore.js";
import { TestUnitRegistry } from "../testunits/registry.js";
import { ParamSearchStore } from "../storage/paramSearchStore.js";
import { SubAgentEventStore } from "../storage/subAgentEventStore.js";
import { JobStore } from "../storage/jobStore.js";
import { BtwChatStore } from "../storage/btwChatStore.js";
import { BtwChatMessagesStore } from "../storage/btwChatMessagesStore.js";
import { ContextCacheStore } from "../storage/contextCacheStore.js";
import { ChunkEmbeddingsStore } from "../storage/chunkEmbeddingsStore.js";
import { LmStudioClient } from "../lmstudio/client.js";
import { NanitesError } from "../helpers/errors.js";
import type { Profile } from "../storage/profileDefaults.js";

export interface ToolDeps {
  home: string;
  db: DatabaseSync;
  profiles: ProfileManager;
  registry: RegistryStore;
  callLogs: CallLogStore;
  /** Cloud (provider) sub-agent calls. Separate table from `callLogs`; the
   * ledger and cost report read BOTH — cloud usage was written but never read
   *. */
  providerCallLogs: ProviderCallLogStore;
  testResults: TestResultStore;
  testUnits: TestUnitRegistry;
  paramSearch: ParamSearchStore;
  subAgentEvents: SubAgentEventStore;
  /** Async-job queue (Phase C) — the shared FIFO behind job-mode sub-agents. */
  jobs: JobStore;
  /** Phase H — the visible `/nanites-btw` chat header (btw-spec-v2 §3). */
  btwChat: BtwChatStore;
  /** Phase H — the throwaway chat transcript. */
  btwChatMessages: BtwChatMessagesStore;
  /** Phase H — the diff/summary compaction caches (survive a chat reset). */
  contextCache: ContextCacheStore;
  /** Phase H — retrieval corpus (plain chunks + guarded vec0 embeddings). */
  chunkEmbeddings: ChunkEmbeddingsStore;
  /**
   * Pin the health report's free-disk reading. `system_health_check` reports
   * `healthy` vs `degraded` partly from free space, so a test asserting the
   * verdict would otherwise depend on how full the host's volume happens to
   * be. Production leaves this undefined and the reading is
   * measured.
   */
  healthDisk?: { availableGb?: number; dir?: string };
  close(): void;
}

export function buildDeps(home?: string, opts: { healthDisk?: ToolDeps["healthDisk"] } = {}): ToolDeps {
  const { db, close } = openNanitesDb(home);
  const profiles = new ProfileManager(home);
  // Accurate token counts (Phase D): resolve tokenizer.json under the home,
  // then a local LM Studio models dir; HF fetch only when the operator opts in
  // via NANITES_HF_FETCH=1. The seam falls back to chars/4 when none resolve.
  setTokenizerProvider(
    huggingfaceTokenizerProvider({
      cacheDir: join(profiles.home, "tokenizers"),
      modelsDir: process.env.NANITES_LMSTUDIO_MODELS_DIR || undefined,
      allowFetch: process.env.NANITES_HF_FETCH === "1",
    }),
  );
  return {
    home: profiles.home,
    db,
    profiles,
    registry: new RegistryStore(db),
    callLogs: new CallLogStore(db),
    providerCallLogs: new ProviderCallLogStore(db),
    testResults: new TestResultStore(db),
    testUnits: new TestUnitRegistry(db),
    paramSearch: new ParamSearchStore(db),
    subAgentEvents: new SubAgentEventStore(db),
    jobs: new JobStore(db),
    btwChat: new BtwChatStore(db),
    btwChatMessages: new BtwChatMessagesStore(db),
    contextCache: new ContextCacheStore(db),
    chunkEmbeddings: new ChunkEmbeddingsStore(db),
    ...(opts.healthDisk ? { healthDisk: opts.healthDisk } : {}),
    close,
  };
}

/**
 * Resolve the effective API token for an endpoint. The per-profile value wins;
 * a NANITES_LMS_API_TOKEN env var fills the gap when the profile has none, so a
 * token-less profile still authenticates against a token-gated LM Studio.
 */
export function resolveAuthToken(endpointToken: string | null, envToken?: string | null): string | null {
  return endpointToken ?? envToken ?? null;
}

export function clientForProfile(profile: Profile, opts?: { timeoutMs?: number }): LmStudioClient {
  return new LmStudioClient({
    baseUrl: profile.endpoint.url,
    authToken: resolveAuthToken(profile.endpoint.auth_token, process.env.NANITES_LMS_API_TOKEN),
    ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
}

export function requireActiveProfile(deps: ToolDeps): Profile {
  const profile = deps.profiles.getActiveProfile();
  if (!profile) {
    throw new NanitesError({
      code: "no_active_profile",
      message: "No active profile set. Create a profile and switch to it before calling model tools.",
      retryable: false,
    });
  }
  return profile;
}
