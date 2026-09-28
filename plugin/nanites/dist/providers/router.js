import { createProviderClient } from "./client.js";
import { parseModelId } from "../storage/providerModelId.js";
import { buildCloudChatRequest, chatWithBudgetRetry, planCloudInference } from "./cloudPlanner.js";
import { ProviderKeyStore } from "../storage/providerKeyStore.js";
import { ProviderModelStore } from "../storage/providerModelStore.js";
import { ProviderStickyStore } from "../storage/providerStickyStore.js";
import { ProviderCallLogStore } from "../storage/providerCallLogStore.js";
import { ProviderErrorStore } from "../storage/providerErrorStore.js";
import { NanitesError } from "../helpers/errors.js";
import { isKeyScoped, isModelScoped, PROVIDER_ERROR_CODES } from "./errors.js";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1_000;
/** Providers with a tight requests-per-minute budget need a longer first wait
 * or the first retry lands inside the same rate-limit window. */
const LOW_RPM_BASE_DELAY_MS = 3_000;
const LOW_RPM_PROVIDERS = new Set(["cloudflare"]);
const MAX_TOTAL_DELAY_MS = 30_000;
const JITTER = () => Math.random() * 500;
function baseDelayFor(provider) {
    return LOW_RPM_PROVIDERS.has(provider) ? LOW_RPM_BASE_DELAY_MS : BASE_DELAY_MS;
}
/** Daily metered allowances reset at 00:00 UTC; retiring a key until then is
 * closer to the truth than the generic 5-minute strike window. */
function nextUtcMidnight() {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
}
/** Resolve the first enabled provider from the preference order. */
export function resolveProvider(preferenceOrder, profile) {
    for (const p of preferenceOrder) {
        if (p === "local")
            continue; // handled separately in runSubAgent
        const cfg = profile.providers?.[p];
        if (cfg && !cfg.enabled)
            continue;
        return p;
    }
    return null;
}
function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
async function sleepWithJitter(baseMs) {
    await delay(baseMs + JITTER());
}
/**
 * Does this key belong to the named generic endpoint?
 *
 * A generic endpoint IS a key row: its name is the key's nickname, and its base
 * URL is the key's gateway_url. That is what makes "many endpoints on one
 * provider" work today with no extra table. So the namespace in the model id
 * resolves to whichever key the user named, and a key with no nickname can never
 * match — an unnamed endpoint is not addressable, which is the honest answer
 * rather than guessing one.
 */
function keyMatchesEndpoint(key, endpoint) {
    return typeof key.nickname === "string" && key.nickname.length > 0 && key.nickname === endpoint;
}
/** Route a cloud call with retry and key rotation. */
export async function routeCloudWithRetry(opts, provider, modelId) {
    const { profile, db, effort, role, brief, messages, systemPrompt, tools, responseFormat, maxOutputTokens } = opts;
    const keyStore = new ProviderKeyStore(db);
    const modelStore = new ProviderModelStore(db);
    const stickyStore = new ProviderStickyStore(db);
    const callLogStore = new ProviderCallLogStore(db);
    const errorStore = new ProviderErrorStore(db);
    const plan = planCloudInference(effort, role, undefined, maxOutputTokens);
    const callUid = plan.call_uid;
    // Determine target model(s)
    let targetModels;
    if (modelId) {
        targetModels = [modelId];
    }
    else {
        const sticky = stickyStore.getSticky(profile.name, provider);
        const registered = modelStore.listModels(profile.name, provider, true);
        if (sticky && registered.some((m) => m.model_id === sticky)) {
            targetModels = [sticky, ...registered.map((m) => m.model_id).filter((id) => id !== sticky)];
        }
        else {
            targetModels = registered.map((m) => m.model_id);
        }
    }
    if (targetModels.length === 0) {
        throw new NanitesError({
            code: "provider_unavailable",
            message: `No registered models for provider ${provider}. Use /nanites-registerModel first.`,
            retryable: false,
        });
    }
    // Round-robin key selection
    const availableKeys = keyStore.availableKeys(profile.name, provider);
    if (availableKeys.length === 0) {
        throw new NanitesError({
            code: "all_keys_exhausted",
            message: `No available API keys for provider ${provider}. Add a key or wait for exhaustion to clear.`,
            retryable: false,
        });
    }
    // Build request — use first key's gateway_url for client construction
    const client = createProviderClient(provider, availableKeys[0]?.gateway_url ?? undefined);
    let lastError = null;
    // Round-robin cursor, persisted across processes. `getKeyState` reports the
    // last index USED (-1 on a fresh profile), so the first step below selects
    // keys[0]. The cursor advances on failures too — leaving it untouched meant
    // every retry of a rate-limited key hit the very same key.
    const startingIndex = keyStore.getKeyState(profile.name, provider).lastKeyIndex;
    let cursor = startingIndex;
    const exhaustedKeys = keyStore.getKeyState(profile.name, provider).exhaustedKeys;
    for (const model of targetModels) {
        const req = buildCloudChatRequest(plan, provider, model, messages, systemPrompt, tools);
        let modelError = null;
        // Keys already spent on THIS model. Tracking ids rather than an index means
        // retiring a key mid-run cannot make the cursor skip its neighbour: the
        // pool shrinks underneath an index, but a set of tried ids is stable.
        const tried = new Set();
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            const keys = keyStore.availableKeys(profile.name, provider);
            if (keys.length === 0) {
                // Every key is retired. Nothing left to try for any model.
                throw lastError ?? modelError ?? new NanitesError({
                    code: "all_keys_exhausted",
                    message: `No available API keys for provider ${provider}.`,
                    retryable: false,
                });
            }
            // A generic model id that names its endpoint
            // (`generic:<endpoint>:<model>`) belongs to exactly one gateway, so the
            // pool is that endpoint's key alone. Rotating across every generic key
            // would send the call to a gateway that may not serve the model at all,
            // which is the exact failure the namespace exists to prevent. A
            // gateway whose key is missing or disabled is an honest failure, not a
            // reason to try a different endpoint.
            const endpoint = parseModelId(model).endpoint;
            const scoped = endpoint ? keys.filter((k) => keyMatchesEndpoint(k, endpoint)) : keys;
            if (endpoint && scoped.length === 0) {
                throw new NanitesError({
                    code: "endpoint_not_configured",
                    message: `Generic endpoint "${endpoint}" has no enabled API key. Add one, or re-register the model without an endpoint prefix.`,
                    retryable: false,
                    details: { endpoint, model_id: model },
                });
            }
            const pool0 = scoped.length > 0 ? scoped : keys;
            // Prefer a key this model has not tried yet, but do fall back to a fresh
            // turn for one that has: on a single-key profile there is nothing else to
            // try, and a backoff retry of the same key is exactly what a transient
            // 503 wants.
            const untried = pool0.filter((k) => !tried.has(k.key_id));
            const pool = untried.length > 0 ? untried : pool0;
            // Step past the last-used index, then wrap onto a key from the pool. A
            // fresh profile stores -1, so this lands on the first key. The index runs
            // over the (possibly endpoint-scoped) pool, so a single-endpoint generic
            // model always resolves to that endpoint's key.
            cursor += 1;
            const start = ((cursor % pool0.length) + pool0.length) % pool0.length;
            const selectedKey = pool.find((k) => pool0.indexOf(k) >= start) ?? pool[0];
            const keyIdx = pool0.indexOf(selectedKey);
            tried.add(selectedKey.key_id);
            cursor = keyIdx;
            // Outside the try so the failure path can time the attempt it just lost.
            const startedAt = Date.now();
            try {
                // An empty reply is retried once at double the budget and then raised as
                // provider_budget_exhausted — never returned as a legitimate "".
                const resp = await chatWithBudgetRetry((r) => client.chat(r, selectedKey.api_key, selectedKey.account_id ?? undefined, selectedKey.gateway_url ?? undefined), plan, provider, model, messages, systemPrompt, tools, responseFormat);
                const durationMs = Date.now() - startedAt;
                // Success — clear exhaustion, update sticky, log call
                keyStore.clearExhaustion(profile.name, provider, selectedKey.key_id);
                stickyStore.setSticky(profile.name, provider, model);
                keyStore.saveKeyState(profile.name, provider, keyIdx, exhaustedKeys);
                const tokensIn = resp.usage?.prompt_tokens ?? 0;
                const tokensOut = resp.usage?.completion_tokens ?? 0;
                const costUsd = computeCost(provider, model, tokensIn, tokensOut, modelStore.getModel(profile.name, provider, model));
                const callLogId = callLogStore.logCall({
                    profile_name: profile.name,
                    call_uid: callUid,
                    provider,
                    model_id: model,
                    provider_request_id: resp.provider_request_id ?? null,
                    task: brief.slice(0, 500),
                    role,
                    tokens_in: tokensIn,
                    tokens_out: tokensOut,
                    duration_ms: durationMs,
                    finish_reason: resp.finish_reason ?? null,
                    cost_usd: costUsd,
                    ttft_ms: undefined,
                    performance_score: undefined,
                    status: "success",
                });
                return {
                    response: resp,
                    provider,
                    model_id: model,
                    call_uid: callUid,
                    provider_request_id: resp.provider_request_id,
                    call_log_id: callLogId,
                    tokens_in: tokensIn,
                    tokens_out: tokensOut,
                    duration_ms: durationMs,
                    finish_reason: resp.finish_reason ?? null,
                    cost_usd: costUsd,
                };
            }
            catch (err) {
                const httpStatus = err instanceof NanitesError ? err.details?.http_status : undefined;
                const mappedErr = client.mapError(err, httpStatus);
                // Log the error
                errorStore.logError({
                    profile_name: profile.name,
                    call_uid: callUid,
                    provider,
                    model_id: model,
                    error_code: mappedErr.code,
                    error_message: mappedErr.message,
                    http_status: httpStatus,
                    provider_error_code: mappedErr.details?.provider_error_code,
                    retryable: mappedErr.retryable,
                    retry_count: attempt,
                });
                // The ledger row too, not just the error row. A round that
                // timed out used to leave nothing in `provider_sub_agent_calls`, so a
                // run that spent a round and lost it still reported its round count —
                // and the dashboard's round timeline showed a run that never happened.
                // Zero tokens and a null cost: the row records the attempt, not spend.
                callLogStore.logCall({
                    profile_name: profile.name,
                    call_uid: callUid,
                    provider,
                    model_id: model,
                    provider_request_id: null,
                    task: brief.slice(0, 500),
                    role,
                    tokens_in: 0,
                    tokens_out: 0,
                    duration_ms: Date.now() - startedAt,
                    finish_reason: null,
                    cost_usd: undefined,
                    ttft_ms: undefined,
                    performance_score: undefined,
                    status: mappedErr.code === PROVIDER_ERROR_CODES.TIMEOUT ? "timeout" : "error",
                });
                // Persist the advanced cursor on failure too, so the next attempt picks
                // a different key instead of retrying a rate-limited one.
                keyStore.saveKeyState(profile.name, provider, keyIdx, exhaustedKeys);
                // A key-scoped failure retires THAT KEY and keeps going — the provider
                // may still have a healthy key in reserve. Only running out of keys
                // ends the run. (An auth failure on a single-key profile therefore
                // still stops the provider, which is the behavior the plan wanted.)
                if (isKeyScoped(mappedErr.code)) {
                    const until = mappedErr.code === PROVIDER_ERROR_CODES.QUOTA_EXHAUSTED
                        ? nextUtcMidnight()
                        : new Date(Date.now() + 24 * 60 * 60 * 1000);
                    keyStore.exhaustKey(profile.name, provider, selectedKey.key_id, until);
                    modelError = mappedErr;
                    continue; // no backoff — the next key is a different account
                }
                // A model-scoped failure means this model is not the right one; walk on
                // rather than aborting a chain that still has candidates.
                if (isModelScoped(mappedErr.code)) {
                    modelError = mappedErr;
                    break;
                }
                modelError = mappedErr;
                if (!mappedErr.retryable)
                    break;
                // Record failure on this key and back off before the retry.
                keyStore.recordFailure(profile.name, provider, selectedKey.key_id);
                const backoffMs = Math.min(baseDelayFor(provider) * Math.pow(2, attempt), MAX_TOTAL_DELAY_MS);
                await sleepWithJitter(backoffMs);
            }
        }
        if (modelError)
            lastError = modelError;
    }
    // Every model failed. Report the last reason, or the aggregate if we never
    // got a structured error at all.
    throw lastError ?? new NanitesError({
        code: "all_models_exhausted",
        message: `All models for provider ${provider} failed after ${MAX_RETRIES + 1} attempts each.`,
        retryable: false,
    });
}
/** Simple direct route without retry. */
export async function routeCloudDirect(opts, provider, modelId) {
    const { profile, db, effort, role, brief, messages, systemPrompt, tools, responseFormat, maxOutputTokens } = opts;
    const keyStore = new ProviderKeyStore(db);
    const modelStore = new ProviderModelStore(db);
    const stickyStore = new ProviderStickyStore(db);
    const callLogStore = new ProviderCallLogStore(db);
    const errorStore = new ProviderErrorStore(db);
    const plan = planCloudInference(effort, role, undefined, maxOutputTokens);
    const callUid = plan.call_uid;
    const keys = keyStore.availableKeys(profile.name, provider);
    if (keys.length === 0) {
        throw new NanitesError({
            code: "all_keys_exhausted",
            message: `No available API keys for provider ${provider}.`,
            retryable: false,
        });
    }
    const selectedKey = keys[0];
    const client = createProviderClient(provider, selectedKey.gateway_url ?? undefined);
    const req = buildCloudChatRequest(plan, provider, modelId, messages, systemPrompt, undefined, responseFormat);
    try {
        const startedAt = Date.now();
        const resp = await client.chat(req, selectedKey.api_key, selectedKey.account_id ?? undefined, selectedKey.gateway_url ?? undefined);
        const durationMs = Date.now() - startedAt;
        keyStore.clearExhaustion(profile.name, provider, selectedKey.key_id);
        stickyStore.setSticky(profile.name, provider, modelId);
        const tokensIn = resp.usage?.prompt_tokens ?? 0;
        const tokensOut = resp.usage?.completion_tokens ?? 0;
        const costUsd = computeCost(provider, modelId, tokensIn, tokensOut, modelStore.getModel(profile.name, provider, modelId));
        const callLogId = callLogStore.logCall({
            profile_name: profile.name,
            call_uid: callUid,
            provider,
            model_id: modelId,
            provider_request_id: resp.provider_request_id ?? null,
            task: brief.slice(0, 500),
            role,
            tokens_in: tokensIn,
            tokens_out: tokensOut,
            duration_ms: durationMs,
            finish_reason: resp.finish_reason ?? null,
            cost_usd: costUsd,
            ttft_ms: undefined,
            performance_score: undefined,
            status: "success",
        });
        return {
            response: resp,
            provider,
            model_id: modelId,
            call_uid: callUid,
            provider_request_id: resp.provider_request_id,
            call_log_id: callLogId,
            tokens_in: tokensIn,
            tokens_out: tokensOut,
            duration_ms: durationMs,
            finish_reason: resp.finish_reason ?? null,
            cost_usd: costUsd,
        };
    }
    catch (err) {
        const httpStatus = err instanceof NanitesError ? err.details?.http_status : undefined;
        const mappedErr = client.mapError(err, httpStatus);
        errorStore.logError({
            profile_name: profile.name,
            call_uid: callUid,
            provider,
            model_id: modelId,
            error_code: mappedErr.code,
            error_message: mappedErr.message,
            http_status: httpStatus,
            provider_error_code: mappedErr.details?.provider_error_code,
            retryable: mappedErr.retryable,
            retry_count: 0,
        });
        callLogStore.logCall({
            profile_name: profile.name,
            call_uid: callUid,
            provider,
            model_id: modelId,
            provider_request_id: undefined,
            task: brief.slice(0, 500),
            role,
            tokens_in: 0,
            tokens_out: 0,
            duration_ms: 0,
            finish_reason: null,
            cost_usd: undefined,
            ttft_ms: undefined,
            performance_score: undefined,
            status: "error",
        });
        throw mappedErr;
    }
}
/**
 * Compute cost in USD from the model row's per-million rates.
 *
 * Any provider whose model row carries pricing gets a real number — Cloudflare
 * rows are seeded from the catalog's `price` property, so a
 * CF run logs actual spend instead of a null. A provider with no rates on the
 * row (OmniRoute, whose cost arrives via response headers) stays undefined:
 * an absent cost is honest, a guessed one is not.
 */
function computeCost(_provider, _modelId, tokensIn, tokensOut, modelRow) {
    const prompt = modelRow?.pricing_prompt;
    const completion = modelRow?.pricing_completion;
    if (prompt == null && completion == null)
        return undefined;
    return ((tokensIn / 1_000_000) * (prompt ?? 0))
        + ((tokensOut / 1_000_000) * (completion ?? 0));
}
/** Run error cleanup if last run > 24h ago. Call on MCP boot. */
export function runErrorCleanup(db, profileName) {
    const errorStore = new ProviderErrorStore(db);
    const last = errorStore.getLastCleanup(profileName);
    const lastMs = new Date(last).getTime();
    const now = Date.now();
    if (now - lastMs > 24 * 60 * 60 * 1000) {
        const deleted = errorStore.cleanup();
        errorStore.setLastCleanup(profileName, new Date().toISOString());
        if (deleted > 0)
            console.log(`[nanites] provider error cleanup: removed ${deleted} rows older than 5 days`);
    }
}
