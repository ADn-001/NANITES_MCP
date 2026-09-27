/**
 * Workflow #2: sub-agent spin-up / teardown. Task brief -> registry role
 * lookup (or explicit model) -> acquire a model (reuse if already loaded;
 * evict to make room on a sequential tier; refuse when a parallel tier is at
 * capacity) -> run one chat -> clean the reply -> unload exactly once on every
 * path -> log exactly one token-usage entry per call regardless of outcome.
 */
import { NanitesError } from "../helpers/errors.js";
import { LmErrorCodes } from "../lmstudio/errors.js";
import { clientForProfile } from "../tools/deps.js";
import { DEFAULT_EFFORT, DEFAULT_OUTPUT_TOKEN_CEILING, DEFAULT_TOOLS, } from "../storage/profileDefaults.js";
import { cleanReply } from "../helpers/cleaner.js";
import { countTokens } from "../helpers/tokenize.js";
import { usageFromStats, usageEstimate } from "../helpers/tokenCounter.js";
import { GENERATION_IDLE_TIMEOUT_MS } from "../helpers/idleTimeout.js";
import { scoreRuns, avgLoadMs, avgResponseMs, loadTimeoutFor } from "../helpers/performanceScorer.js";
import { planInference, seedReasoningType } from "../helpers/inferencePlanner.js";
import { concurrencyLoadExtras } from "../helpers/concurrency.js";
import { acquireInferenceSlot } from "../helpers/inferenceGate.js";
import { buildSystemPrompt } from "../helpers/systemPromptPlanner.js";
import { ensureHealthy } from "./guard.js";
import { findBestModel, rolesFromBrief, FITNESS_FLOOR } from "./roleMatch.js";
import { resolveRoleModel } from "./resolveRoleModel.js";
import { SubAgentPool } from "./subAgentPool.js";
import { buildVisionContent, resolveImageUris } from "../providers/vision.js";
import { parseStructured } from "../providers/outputSchema.js";
import { leakedToolCallDialect, looksLikeLeakedToolCall, parseLeakedToolCalls } from "../helpers/toolCallLeak.js";
export async function acquireModel(client, profile, modelId, loadTimeoutMs, contextLength) {
    const { models } = await client.listModels();
    const loaded = models.filter((m) => m.loaded_instances.length > 0);
    const existing = loaded.find((m) => m.key === modelId);
    if (existing) {
        return {
            instance_id: existing.loaded_instances[0].id,
            loaded_this_call: false,
            evicted_instance_ids: [],
            context_length: existing.loaded_instances[0]?.config?.context_length ?? null,
        };
    }
    const loadReq = {
        model: modelId,
        ...(contextLength ? { context_length: contextLength } : {}),
        ...concurrencyLoadExtras(profile.concurrency.num_parallel),
    };
    const capacity = profile.concurrency.max_parallel_models;
    if (loaded.length >= capacity) {
        if (profile.concurrency.mode === "sequential") {
            // Capacity is 1 on a sequential tier: evict the occupant to make room.
            const victim = loaded[0];
            const victimId = victim.loaded_instances[0].id;
            await client.unloadModel({ instance_id: victimId });
            const loadResp = await client.loadModelWithHeartbeat(loadReq, { timeoutMs: loadTimeoutMs });
            return {
                instance_id: loadResp.instance_id,
                loaded_this_call: true,
                evicted_instance_ids: [victimId],
                context_length: loadResp.load_config?.context_length ?? null,
            };
        }
        throw new NanitesError({
            code: "concurrency_limit",
            message: `Profile is at its parallel-tier limit (${loaded.length} loaded, max ${capacity})`,
            retryable: true,
            details: { loaded: loaded.length, max_parallel_models: capacity },
        });
    }
    const loadResp = await client.loadModelWithHeartbeat(loadReq, { timeoutMs: loadTimeoutMs });
    return {
        instance_id: loadResp.instance_id,
        loaded_this_call: true,
        evicted_instance_ids: [],
        context_length: loadResp.load_config?.context_length ?? null,
    };
}
/**
 * Evict every resident instance of `modelId` (dynamic-model profiles). LM
 * Studio's JIT can spawn its own sibling instance of a key while a workload
 * holds an explicitly loaded one (observed live: `key` + `key:3` resident at
 * once); unloading only the id we were handed leaves that JIT sibling behind as
 * an idle orphan. When a call loaded the model itself it owns the whole slot,
 * so it unloads the whole key. Never used on non-dynamic profiles, where a
 * resident model is the user's own preconfigured instance.
 */
export async function unloadModelKey(client, modelId) {
    const { models } = await client.listModels();
    for (const m of models) {
        if (m.key !== modelId)
            continue;
        for (const inst of m.loaded_instances) {
            await client.unloadModel({ instance_id: inst.id }).catch(() => { });
        }
    }
}
function costFor(profile, usage) {
    return ((usage.inputTokens / 1_000_000) * profile.pricing.input_per_million_usd +
        (usage.outputTokens / 1_000_000) * profile.pricing.output_per_million_usd);
}
export async function runSubAgent(deps, profileName, brief, opts = {}) {
    const profile = deps.profiles.getProfile(profileName);
    if (!profile) {
        throw new NanitesError({ code: "profile_not_found", message: `No profile named "${profileName}"`, retryable: false });
    }
    // When dynamic_model is off, selection uses the loaded LM Studio pool and no
    // model is loaded/unloaded by us; the registry is read-only. Needs to be in
    // scope for the finally teardown.
    const offMode = profile.dynamic_model === false;
    // Pin-aware model resolution runs before any health gate or
    // provider branch: explicit `provider`/`model_id` beat pins, and a role pin
    // (or the no-args local default) decides whether this is a local or a cloud
    // run. Pure store reads — never touches a provider or LM Studio. Image input
    // forces the `vision` role and the cloud-only vision resolution ladder.
    const hasImages = (opts.images?.length ?? 0) > 0;
    const requestedRoles = hasImages
        ? ["vision"]
        : opts.roles && opts.roles.length > 0
            ? opts.roles
            : rolesFromBrief(brief);
    const resolution = resolveRoleModel(deps, profile, {
        roles: requestedRoles,
        brief,
        explicitProvider: opts.provider,
        explicitModel: opts.model_id,
        vision: hasImages,
        // The cloud fs tool loop needs a model that can actually emit tool calls.
        needsTools: profile.tools?.enabled === true && profile.tools?.fs != null,
    });
    // Health gate only for LM Studio runs. A cloud run (explicit or pin-routed)
    // never touches the local server, so the LMS health gate — which can abort on
    // a down local instance — would wrongly block a healthy cloud delegation.
    if (resolution.provider === "local") {
        await ensureHealthy(profileName, deps, opts);
    }
    // Snapshot the hold request so the finally teardown reads a stable policy
    // even if opts were mutated between entry and exit.
    const hold = opts.hold;
    const started = Date.now();
    let chosenModel = resolution.model_id ?? "";
    let role = requestedRoles[0] ?? "";
    let instanceId = null;
    let loadedThisCall = false;
    let evictedIds = [];
    let unloaded = false;
    let stats = null;
    let clean = { text: "", cleaned: false, issues: [] };
    let schemaProblems = [];
    let client = null;
    let callLogId = 0;
    let loadMs = null;
    let contextWindow = null;
    let errorCode = null;
    let performanceScore = 50;
    let totalMs = 0;
    let usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    let toolsUsed = [];
    let heldInstanceId = null;
    let lowConfidence = false;
    let confidenceNote = "";
    // Planner note surfaced on the result (F2): the model context ceiling being
    // unknowable is the discovery-fallback case; the planner's own note covers
    // decisions like skipping reasoning on a non-reasoning model.
    let planNote;
    const emit = (phase, payload = {}) => {
        deps.subAgentEvents.insert({ profile_name: profileName, model_id: chosenModel || "unknown", phase, payload });
    };
    emit("resolution", {
        provider: resolution.provider,
        ...(chosenModel ? { model_id: chosenModel } : {}),
        source: resolution.source,
        ...(resolution.note ? { note: resolution.note } : {}),
    });
    const pool = opts.pool ?? new SubAgentPool(profile.concurrency.max_parallel_models);
    if (!pool.tryAcquire()) {
        throw new NanitesError({
            code: "concurrency_limit",
            message: `Sub-agent pool full (${pool.activeCount}/${pool.maxCapacity})`,
            retryable: true,
            details: { max_parallel_models: pool.maxCapacity },
        });
    }
    // Sequential-tier serialization: at most one inference in flight per profile
    // even when callers overlap (parallel blocking run_sub_agent calls, job
    // drains). Parallel tiers skip the gate — their bounded fan-out is the pool.
    const releaseInference = profile.concurrency.mode === "sequential" ? await acquireInferenceSlot(profileName) : () => { };
    // ---- Cloud provider path ----
    if (resolution.provider !== "local") {
        // Everything from the dynamic imports to the dispatch sits inside one
        // try/finally so no throw between the two acquisitions and the dispatch can
        // strand a pool slot or the sequential inference gate.
        try {
            const effectiveProvider = resolution.provider;
            const { routeCloudWithRetry } = await import("../providers/router.js");
            const { runCloudToolLoop } = await import("../providers/cloudToolLoop.js");
            const effort = opts.effort ?? profile.inference?.effort ?? DEFAULT_EFFORT;
            // Cloud model selection happens inside the router (sticky + registered
            // models); the role still drives the planner's reasoning difficulty and the
            // call log. Default it off the brief like the local branch does.
            role = requestedRoles[0] ?? "";
            chosenModel = resolution.model_id ?? "";
            // The fs grant is the cloud counterpart of LM Studio's `integrations` loop:
            // when set, Nanites advertises allowlisted file tools and executes the
            // model's calls itself. Without it, a cloud run is tool-less.
            const toolsConfig = profile.tools ?? DEFAULT_TOOLS;
            const fsGrant = toolsConfig.enabled ? (toolsConfig.fs ?? null) : null;
            // Vision runs are tool-less: images and the fs tool loop are mutually
            // exclusive (the loop replays tool messages the image parts would corrupt).
            // Rejected before any file read so a bad combo costs nothing.
            if (hasImages && fsGrant) {
                throw new NanitesError({
                    code: "vision_with_tool_loop",
                    message: "A vision run cannot combine images with the filesystem tool loop — drop the fs grant or the images.",
                    retryable: false,
                });
            }
            const imageUrls = hasImages ? await resolveImageUris(opts.images) : null;
            const reasoningType = (resolution.model_id ? deps.registry.get(profileName, resolution.model_id)?.reasoning_type : undefined) ?? "unknown";
            const systemPrompt = opts.system_prompt_override !== undefined
                ? opts.system_prompt_override
                : buildSystemPrompt({
                    profile: {
                        use_case: profile.use_case,
                        machine_specs: { vram_gb: profile.machine_specs.vram_gb, gpu: profile.machine_specs.gpu },
                        concurrency: profile.concurrency,
                        effort,
                        dynamic_model: !offMode,
                        system_prompt: profile.inference?.system_prompt ?? null,
                    },
                    role,
                    modelId: chosenModel || "cloud",
                    reasoningType,
                });
            emit("chat.start", { role, effort, brief: brief.slice(0, 120), provider: effectiveProvider, fs: fsGrant !== null });
            let replyText;
            let callUid;
            let callLogId = 0;
            let rounds = 1;
            let roundsDetail;
            let truncated;
            // Loop-level notes — merged into
            // `validation.issues` so a caller sees them where it already looks.
            let loopIssues = [];
            // Schema-conformance problems from either cloud path, merged into
            // `validation.issues` below so a caller sees them where it already looks.
            schemaProblems = [];
            if (fsGrant) {
                const loopResult = await runCloudToolLoop({
                    profile,
                    db: deps.db,
                    provider: effectiveProvider,
                    modelId: resolution.model_id ?? undefined,
                    effort,
                    role,
                    brief,
                    systemPrompt,
                    fsGrant,
                    ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
                    ...(opts.outputSchemaName ? { outputSchemaName: opts.outputSchemaName } : {}),
                    ...(opts.route ? { route: opts.route } : {}),
                    onEvent: (phase, payload) => emit(phase, payload),
                });
                replyText = loopResult.reply;
                callUid = loopResult.call_uid;
                callLogId = loopResult.call_log_id ?? 0;
                toolsUsed = loopResult.tools_used;
                rounds = loopResult.rounds;
                roundsDetail = loopResult.rounds_detail;
                totalMs = loopResult.duration_ms;
                usage = { inputTokens: loopResult.tokens_in, outputTokens: loopResult.tokens_out, reasoningTokens: 0 };
                chosenModel = loopResult.model_id;
                truncated = loopResult.truncated;
                loopIssues = loopResult.issues ?? [];
                if (loopResult.structured && !loopResult.structured.valid) {
                    schemaProblems = loopResult.structured.problems.map((p) => `output_schema_invalid: ${p}`);
                }
                emit("chat.end", { tools_used: toolsUsed.length, rounds, truncated: loopResult.truncated ?? null });
            }
            else {
                const cloudResult = await (opts.route ?? routeCloudWithRetry)({
                    profile,
                    db: deps.db,
                    effort,
                    role,
                    brief,
                    messages: imageUrls
                        ? [{ role: "user", content: buildVisionContent(brief, imageUrls) }]
                        : [{ role: "user", content: brief }],
                    systemPrompt,
                    // A tool-less run has one round, so the schema lands on it directly.
                    // (Vision runs reject a schema too — images and a JSON contract on
                    // the same call is not a combination worth guessing at.)
                    ...(opts.outputSchema && !imageUrls
                        ? { responseFormat: { type: "json_schema", schema: opts.outputSchema, ...(opts.outputSchemaName ? { name: opts.outputSchemaName } : {}) } }
                        : {}),
                }, effectiveProvider, resolution.model_id ?? undefined);
                replyText = cloudResult.response.content ?? "";
                // With no tool loop there is nothing that could execute a
                // leaked call, so refuse to pass the markup off as an answer.
                if (looksLikeLeakedToolCall(replyText)) {
                    throw new NanitesError({
                        code: "tool_call_leak",
                        message: "Model returned a tool call in its message content instead of an answer, and this run has no tool loop to execute it",
                        retryable: false,
                        details: {
                            provider: effectiveProvider,
                            model_id: cloudResult.model_id,
                            dialect: leakedToolCallDialect(replyText),
                            parsed: parseLeakedToolCalls(replyText) !== null,
                        },
                    });
                }
                callUid = cloudResult.call_uid;
                callLogId = cloudResult.call_log_id ?? 0;
                toolsUsed = [];
                totalMs = cloudResult.duration_ms;
                usage = { inputTokens: cloudResult.tokens_in, outputTokens: cloudResult.tokens_out, reasoningTokens: 0 };
                chosenModel = cloudResult.model_id;
                // No loop to re-ask here: one round is the whole run, so a
                // non-conforming answer is flagged rather than re-prompted.
                if (opts.outputSchema && !imageUrls) {
                    const check = parseStructured(replyText, opts.outputSchema);
                    if (!check.ok)
                        schemaProblems = check.problems.map((p) => `output_schema_invalid: ${p}`);
                }
                emit("chat.end", { tools_used: 0 });
            }
            clean = cleanReply(replyText, { maxChars: 100_000 });
            performanceScore = 50;
            if (clean.text)
                emit("chat.reply", { text: clean.text });
            return {
                role,
                model_id: chosenModel,
                instance_id: `cloud:${callUid}`,
                reply: clean.text,
                loaded_this_call: false,
                evicted_instance_ids: [],
                unloaded: false,
                token_usage: usage,
                validation: { cleaned: clean.cleaned, issues: [...clean.issues, ...loopIssues, ...schemaProblems] },
                stats: null,
                call_log_id: callLogId,
                performance_score: performanceScore,
                tools_used: toolsUsed,
                metrics: {
                    load_ms: 0,
                    infer_ms: totalMs,
                    ttft_ms: 0,
                    t_s: 0,
                    ...(roundsDetail
                        ? { rounds: roundsDetail.length, rounds_detail: roundsDetail }
                        : {}),
                },
                ...(resolution.note ? { note: resolution.note } : {}),
                ...(truncated ? { truncated } : {}),
            };
        }
        finally {
            pool.release();
            releaseInference();
        }
    }
    try {
        // Discovery: poll the endpoint once. Serves both (1) the loaded pool when
        // dynamic_model is off, and (2) the chosen model's context ceiling for the
        // planner. Best-effort.
        const discover = clientForProfile(profile);
        let maxContextLength = 32768;
        let models = [];
        let discoveryFailed = false;
        try {
            ({ models } = await discover.listModels());
            const info = models.find((m) => m.key === chosenModel);
            if (info?.max_context_length)
                maxContextLength = info.max_context_length;
        }
        catch {
            // Discovery is best-effort; the planner falls back to a generous ceiling.
            // Flag it (F2) so the caller sees the budget was planned against the
            // default, not a measured ceiling — a silent fallback would mislead.
            discoveryFailed = true;
        }
        // Role/model selection when no explicit model was requested.
        if (!chosenModel) {
            const requested = opts.roles ?? rolesFromBrief(brief);
            if (offMode) {
                // Loaded-pool mode: use the user's resident models, loading nothing.
                const loaded = models.filter((m) => m.loaded_instances.length > 0);
                if (loaded.length === 0) {
                    throw new NanitesError({
                        code: "no_model_loaded",
                        message: "No model is currently loaded in LM Studio — load one, or flip dynamic-model selection back on",
                        retryable: false,
                    });
                }
                const regByKey = new Map(deps.registry.listLocal(profileName).map((e) => [e.model_id, e]));
                const loadedRegistered = loaded
                    .map((m) => ({ model: m, entry: regByKey.get(m.key) }))
                    .filter((x) => x.entry !== undefined);
                // Stage 1: a registered loaded model that role-matches; prefer highest performance_score.
                const matches = loadedRegistered.filter((x) => findBestModel([x.entry], requested) !== null);
                if (matches.length > 0) {
                    const pick = matches.sort((a, b) => (b.entry.performance_score ?? 50) - (a.entry.performance_score ?? 50) ||
                        a.entry.model_id.localeCompare(b.entry.model_id))[0];
                    chosenModel = pick.entry.model_id;
                    role = pick.entry.roles.find((r) => requested.includes(r)) ?? requested[0] ?? "";
                }
                else {
                    // Stage 2 fallback: highest-scoring registered loaded model, else any loaded model.
                    const scored = loadedRegistered.filter((x) => typeof x.entry.performance_score === "number");
                    const pick = scored.length
                        ? scored.sort((a, b) => (b.entry.performance_score ?? 0) - (a.entry.performance_score ?? 0))[0].model
                        : loaded[0];
                    chosenModel = pick.key;
                    role = requested[0] ?? "";
                }
            }
            else {
                const match = findBestModel(deps.registry.listLocal(profileName), requested);
                if (!match) {
                    throw new NanitesError({
                        code: "no_model_for_role",
                        message: `No registry entry matches roles: ${requested.join(", ")}`,
                        retryable: false,
                        details: { roles: requested },
                    });
                }
                chosenModel = match.entry.model_id;
                role = match.matched_roles[0] ?? "";
                // E3: a matched role with no approved backing above the floor is
                // surfaced (additively) so the orchestrator can weigh confidence —
                // selection itself is unchanged.
                const belowFloor = match.matched_roles.filter((r) => (match.entry.score_minima?.[r] ?? 0) < FITNESS_FLOOR);
                if (belowFloor.length > 0) {
                    lowConfidence = true;
                    confidenceNote = `Matched role(s) ${belowFloor.join(", ")} have no approved regimen evidence above the confidence floor (${FITNESS_FLOOR}) — treat this delegation as unproven.`;
                }
            }
        }
        const effort = opts.effort ?? profile.inference?.effort ?? DEFAULT_EFFORT;
        const recordedType = deps.registry.get(profileName, chosenModel)?.reasoning_type ?? "unknown";
        const reasoningType = recordedType === "unknown" ? seedReasoningType(chosenModel) : recordedType;
        const outputTokenCeiling = profile.inference?.output_token_ceiling ?? DEFAULT_OUTPUT_TOKEN_CEILING;
        const plan = planInference({
            effort,
            role,
            reasoningType,
            promptTokens: countTokens(brief),
            outputTokenCeiling,
            maxContextLength,
            reasoningBudgetOverride: opts.reasoning_budget,
            unknownContextCeiling: discoveryFailed,
        });
        planNote = plan.note;
        // Rebuild the client with the planner's generation timeout so a reasoning
        // model on a hard task isn't cut off mid-thought by the default 30s.
        client = clientForProfile(profile, opts.clientTimeoutMs ? { timeoutMs: opts.clientTimeoutMs } : { timeoutMs: plan.generation_timeout_ms });
        emit("chat.start", { role, effort, brief: brief.slice(0, 120), dynamic_model: !offMode });
        // System prompt: a per-call override replaces the generated header verbatim;
        // otherwise buildSystemPrompt layers the profile base + identity/scope/role.
        const systemPrompt = opts.system_prompt_override !== undefined
            ? opts.system_prompt_override
            : buildSystemPrompt({
                profile: {
                    use_case: profile.use_case,
                    machine_specs: { vram_gb: profile.machine_specs.vram_gb, gpu: profile.machine_specs.gpu },
                    concurrency: profile.concurrency,
                    effort,
                    dynamic_model: !offMode,
                    system_prompt: profile.inference?.system_prompt ?? null,
                },
                role,
                modelId: chosenModel,
                reasoningType,
            });
        // Tool grant + transport eligibility (decided once per run, never per chat).
        // When the profile opts into a per-request ttl on a dynamic profile, a
        // plain (tool-less, no-hold) sub-agent is served over /v1/chat/completions
        // + `ttl` — LM Studio JIT-loads, keeps the model warm across the burst, and
        // auto-evicts on drain, replacing our explicit load/teardown choreography.
        // The openai transport is chosen on the *model key* (not an instance id).
        const toolsConfig = profile.tools ?? DEFAULT_TOOLS;
        const integrations = toolsConfig.enabled ? toolsConfig.integrations : undefined;
        const ttl_s = profile.inference?.ttl_s ?? 0;
        const ttlEligible = !offMode && ttl_s > 0 && integrations === undefined && !hold;
        if (offMode) {
            // Loaded-pool mode: no load/unload — use the already-resident instance.
            const info = models.find((m) => m.key === chosenModel);
            const inst = info?.loaded_instances[0];
            if (!inst) {
                throw new NanitesError({ code: "no_model_loaded", message: `"${chosenModel}" is no longer loaded`, retryable: false });
            }
            instanceId = inst.id;
            loadedThisCall = false;
            evictedIds = [];
            contextWindow = inst.config?.context_length ?? null;
            loadMs = 0;
        }
        else if (ttlEligible) {
            // No acquire — the model is JIT-loaded by the /v1 request and auto-evicted
            // after its ttl. Nothing is pinned, so there is no instance id and no
            // teardown. load_ms stays null (no explicit load happened). The
            // model_load.end stage fires so the dashboard's stage flow stays coherent;
            // `loaded_this_call: true` reads as "engaged" not "pinned by us".
            emit("model_load.end", { instance_id: null, load_ms: null, loaded_this_call: true, transport: "openai" });
        }
        else {
            // Size the load request's timeout from the model's recorded load history:
            // generous on first load, then 3x the rolling average + a fixed buffer.
            const loadTimeoutMs = loadTimeoutFor(deps.registry.get(profileName, chosenModel)?.avg_load_ms ?? null);
            const acquired = await acquireModel(client, profile, chosenModel, loadTimeoutMs, plan.context_length);
            instanceId = acquired.instance_id;
            loadedThisCall = acquired.loaded_this_call;
            evictedIds = acquired.evicted_instance_ids;
            contextWindow = acquired.context_length;
            loadMs = Date.now() - started;
            emit("model_load.end", { instance_id: instanceId, load_ms: loadMs, loaded_this_call: loadedThisCall });
        }
        const chatParams = {
            temperature: 0.3,
            max_output_tokens: plan.max_output_tokens,
            system_prompt: systemPrompt,
            ...(integrations !== undefined ? { integrations } : {}),
            ...(plan.reasoning !== undefined ? { reasoning: plan.reasoning } : {}),
            ...(plan.reasoning_budget !== undefined ? { reasoning_budget: plan.reasoning_budget } : {}),
            ...(opts.outputSchema
                ? {
                    response_format: {
                        type: "json_schema",
                        json_schema: { name: opts.outputSchemaName, schema: opts.outputSchema },
                    },
                }
                : {}),
        };
        const lm = client;
        // Target differs by transport: native addresses the loaded instance id,
        // openai addresses the registry model key (LM Studio JIT-loads by key).
        const chatTarget = ttlEligible ? chosenModel : instanceId;
        // Live reply build-up: mirror LM Studio's SSE message.delta events into throttled
        // chat.content events so the Vox-Terminus panel shows the reply streaming in, without
        // hammering the DB once per token. Flush when a chunk accumulates or ~250ms passes.
        let pendingContent = "";
        let lastContentFlush = 0;
        const CONTENT_FLUSH_CHARS = 40;
        const CONTENT_FLUSH_MS = 250;
        const flushContent = (force) => {
            if (!pendingContent)
                return;
            if (!force && pendingContent.length < CONTENT_FLUSH_CHARS && Date.now() - lastContentFlush < CONTENT_FLUSH_MS)
                return;
            emit("chat.content", { text: pendingContent });
            pendingContent = "";
            lastContentFlush = Date.now();
        };
        const emitContent = (ev) => {
            const data = ev.data;
            if (ev.type === "message.delta" && typeof data.content === "string") {
                pendingContent += data.content;
                flushContent(false);
            }
            else if (ev.type === "chat.end") {
                flushContent(true);
            }
        };
        // Live per-token deltas only make sense for a plain (tool-less) reply. A
        // tool-loop run executes tool calls server-side and returns them as buffered
        // output that SSE reassembly cannot carry, so route those non-streaming.
        const streamLive = integrations === undefined;
        // Streaming chats are idle-killed (zero tokens for the window), not
        // fixed-budget: a slow-but-alive local model is never cut off mid-thought.
        // On the ttl-eligible path the transport is openai + the per-request ttl, so
        // LM Studio owns the load lifecycle; native keeps the explicit load/teardown.
        const doChat = (prm) => streamLive
            ? lm.chat(chatTarget, brief, { ...prm, stream: true }, {
                onEvent: emitContent,
                idleTimeoutMs: opts.idle_timeout_ms ?? GENERATION_IDLE_TIMEOUT_MS,
                ...(ttlEligible ? { transport: "openai", ttl_s } : {}),
            })
            : lm.chat(chatTarget, brief, prm);
        const runChat = async () => doChat(chatParams);
        // A reasoning value the model can't honor ("on" or "off") surfaces as a 400;
        // learn `non_reasoning`, then retry once without reasoning (keeping the
        // system prompt but dropping the now-invalid reasoning/budget flags).
        let result;
        if (plan.reasoning !== undefined) {
            try {
                result = await runChat();
            }
            catch (err) {
                const detail = err instanceof NanitesError ? JSON.stringify(err.details ?? "") : "";
                if (err instanceof NanitesError && err.code === LmErrorCodes.HTTP_4XX && /reasoning/i.test(detail)) {
                    const learnTarget = deps.registry.get(profileName, chosenModel);
                    if (learnTarget && !offMode) {
                        deps.registry.upsert(profileName, { ...learnTarget, reasoning_type: "non_reasoning" });
                    }
                    result = await doChat({
                        temperature: 0.3,
                        max_output_tokens: chatParams.max_output_tokens,
                        system_prompt: systemPrompt,
                    });
                }
                else {
                    throw err;
                }
            }
        }
        else {
            result = await runChat();
        }
        const chatResult = result.response;
        stats = chatResult.stats;
        if (stats.reasoning_output_tokens && stats.reasoning_output_tokens > 0 && !offMode) {
            const existing = deps.registry.get(profileName, chosenModel);
            if (existing)
                deps.registry.upsert(profileName, { ...existing, reasoning_type: "reasoning" });
        }
        const messageText = chatResult.output
            .filter((o) => o.type === "message")
            .map((o) => o.content)
            .join("\n");
        clean = cleanReply(messageText, { maxChars: 100_000 });
        // LM Studio honours response_format, so validate the local reply against the
        // requested schema the same way the cloud path does — a non-conforming answer
        // is flagged in validation.issues, not silently returned as prose.
        if (opts.outputSchema) {
            const check = parseStructured(clean.text, opts.outputSchema);
            if (!check.ok)
                schemaProblems = check.problems.map((p) => `output_schema_invalid: ${p}`);
        }
        // Surface the tool calls the sub-agent made (names + truncated outputs). Only
        // report those the server actually executed (output present) so a refused or
        // invalid tool call isn't presented as having run.
        toolsUsed = chatResult.output
            .filter((o) => o.type === "tool_call" && typeof o.output === "string")
            .map((o) => ({ tool: o.tool, output: o.output.slice(0, 4000) }));
        emit("chat.end", { tok_s: stats.tokens_per_second, ttft_ms: stats.time_to_first_token_seconds * 1000, tools_used: toolsUsed.length });
        if (clean.text) {
            emit("chat.reply", { text: clean.text });
        }
    }
    catch (err) {
        errorCode = err instanceof NanitesError ? err.code : "unknown";
        throw err;
    }
    finally {
        // Teardown: unload exactly once, and only if we loaded it this call. When
        // `hold` was requested, skip the unload and hand the warm instance to the
        // caller instead — the holder owns teardown (its own finally, or eviction
        // by the concurrency tier), so a multi-call consumer pays one load.
        if (client !== null && instanceId !== null && loadedThisCall) {
            if (hold) {
                heldInstanceId = instanceId;
                hold.instance_id_out?.(instanceId);
                try {
                    emit("model_hold.start", { instance_id: instanceId, max_hold_ms: hold.max_hold_ms ?? null });
                }
                catch {
                    // Hold-reporting is best-effort; never mask the run's real outcome.
                }
            }
            else if (!offMode) {
                // We loaded this model on a dynamic profile: reclaim the whole key so a
                // JIT sibling instance (see unloadModelKey) isn't left behind as an
                // idle orphan. Non-dynamic profiles never reach here (they reuse the
                // user's loaded pool, loadedThisCall stays false).
                await unloadModelKey(client, chosenModel).catch(() => { });
                unloaded = true;
            }
            else {
                await client.unloadModel({ instance_id: instanceId }).catch(() => { });
                unloaded = true;
            }
        }
        // Token log: exactly one entry per call that engaged a model, regardless
        // of outcome. Calls that never chose a model (role lookup failure) or
        // were refused before acquisition log nothing.
        if (chosenModel !== "") {
            totalMs = Date.now() - started;
            usage = stats !== null ? usageFromStats(stats) : usageEstimate([brief], clean.text);
            callLogId = deps.callLogs.insert({
                profile_name: profileName,
                model_id: chosenModel,
                task: opts.task ?? brief.slice(0, 200),
                role,
                tokens_in: usage.inputTokens,
                tokens_out: usage.outputTokens,
                duration_ms: totalMs,
                cost_usd: costFor(profile, usage),
                ttft_ms: stats !== null ? Math.round(stats.time_to_first_token_seconds * 1000) : null,
                load_ms: loadMs,
                error_code: errorCode,
                context_window: contextWindow,
            });
            // Recompute the model's performance score only when the chat actually
            // ran (stats present); a failed/refused call leaves the score as-is.
            // In loaded-pool mode (dynamic_model off) the registry is read-only — the
            // user's own models are outside the model sheet, so no upsert.
            if (stats !== null && !offMode) {
                const runs = deps.callLogs.recentForModel(profileName, chosenModel, 20);
                performanceScore = scoreRuns(runs);
                const avgLoad = avgLoadMs(runs);
                const avgResponse = avgResponseMs(runs);
                const existing = deps.registry.get(profileName, chosenModel);
                deps.registry.upsert(profileName, {
                    model_id: chosenModel,
                    roles: existing?.roles ?? [],
                    scores: existing?.scores ?? {},
                    // Preserve the role minima produced by finalize/backfill — this is a
                    // performance-score write, not a scoring write.
                    score_minima: existing?.score_minima,
                    best_params: existing?.best_params ?? {},
                    // Carry the provider forward. The upsert keys on
                    // (profile_name, model_id) only, so omitting it here re-tagged a
                    // CLOUD model as local on every score write.
                    provider: existing?.provider ?? null,
                    last_tested: existing?.last_tested ?? null,
                    performance_score: performanceScore,
                    avg_load_ms: avgLoad,
                    avg_response_ms: avgResponse,
                    // Preserve the reasoning type learned this run (or earlier) — the
                    // upsert writes `reasoning_type ?? "unknown"`, so omitting it here
                    // would clobber a learned "reasoning"/"non_reasoning" back to unknown.
                    reasoning_type: existing?.reasoning_type,
                });
            }
        }
        pool.release();
        releaseInference();
    }
    // Surface the planner's note (F2 discovery-fallback ceiling, reasoning skip)
    // and the E3 confidence note in the one human-readable `note` slot, when any
    // exist. Selection/flag semantics unchanged — additive only.
    const surfacedNotes = [resolution.note, planNote, ...(lowConfidence ? [confidenceNote] : [])].filter((n) => Boolean(n));
    const ttftMs = stats !== null ? Math.round(stats.time_to_first_token_seconds * 1000) : 0;
    const inferMs = Math.max(0, totalMs - (loadMs ?? 0) - ttftMs);
    const t_s = stats?.tokens_per_second ?? (inferMs > 0 ? (usage.inputTokens + usage.outputTokens) / (inferMs / 1000) : 0);
    return {
        role,
        model_id: chosenModel,
        instance_id: instanceId ?? "",
        reply: clean.text,
        loaded_this_call: loadedThisCall,
        evicted_instance_ids: evictedIds,
        unloaded,
        // Only present when `hold` actually handed an instance over — the key is
        // omitted otherwise so the response shape stays additive, not noisy.
        ...(heldInstanceId !== null ? { held_instance_id: heldInstanceId } : {}),
        // E3: emitted only when the default registry branch flags a low-confidence
        // match; absent otherwise so the shape stays additive. `note` is emitted
        // whenever a planner/discovery note exists, whether or not low_confidence
        // is set (F2).
        ...(lowConfidence ? { low_confidence: true } : {}),
        ...(surfacedNotes.length > 0 ? { note: surfacedNotes.join(" ") } : {}),
        token_usage: usage,
        validation: { cleaned: clean.cleaned, issues: [...clean.issues, ...schemaProblems] },
        stats,
        call_log_id: callLogId,
        performance_score: performanceScore,
        tools_used: toolsUsed,
        metrics: {
            load_ms: loadMs ?? 0,
            infer_ms: inferMs,
            ttft_ms: ttftMs,
            t_s: Math.round(t_s * 100) / 100,
        },
    };
}
