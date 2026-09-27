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
export function buildDeps(home, opts = {}) {
    const { db, close } = openNanitesDb(home);
    const profiles = new ProfileManager(home);
    // Accurate token counts (Phase D): resolve tokenizer.json under the home,
    // then a local LM Studio models dir; HF fetch only when the operator opts in
    // via NANITES_HF_FETCH=1. The seam falls back to chars/4 when none resolve.
    setTokenizerProvider(huggingfaceTokenizerProvider({
        cacheDir: join(profiles.home, "tokenizers"),
        modelsDir: process.env.NANITES_LMSTUDIO_MODELS_DIR || undefined,
        allowFetch: process.env.NANITES_HF_FETCH === "1",
    }));
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
export function resolveAuthToken(endpointToken, envToken) {
    return endpointToken ?? envToken ?? null;
}
export function clientForProfile(profile, opts) {
    return new LmStudioClient({
        baseUrl: profile.endpoint.url,
        authToken: resolveAuthToken(profile.endpoint.auth_token, process.env.NANITES_LMS_API_TOKEN),
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
}
export function requireActiveProfile(deps) {
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
