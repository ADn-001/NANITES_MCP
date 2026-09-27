/**
 * Workflow #1: test and register a model. Health gate first, then per model:
 * load -> run the profile's test-unit set -> deterministic units auto-score
 * inline under both param candidates (each logged to the param search, only the
 * per-unit winner recorded approved), orchestrator_judged units run BOTH
 * candidates but log nothing yet (score is unknown at run time — judged
 * attempts are logged at submit time with the real score, D10): the `baseline`
 * run lands `pending`, the `variant` run lands the internal `staged` hold ->
 * unload exactly once on every path -> if nothing is pending, write the
 * registry entry. Idempotent pending (D1): a judged unit that already has a
 * live (pending|staged) row from an earlier run is skipped, never re-run or
 * stacked. Every inserted row is stamped with the current test_run (max+1), so
 * a later re-test supersedes the earlier cycle in the E1 aggregation.
 *
 * Context acquisition is *ascending*: the model is loaded once at a unit's
 * recommended (clamped) context, and is only reloaded UPWARD when a later unit
 * needs more context than the resident instance provides. A same-key resident
 * whose loaded context already meets the need is reused; a resident the user
 * loaded before the run is adopted but never reloaded or torn down. `chat`
 * bodies never carry `context_length` (LM Studio treats it as a JIT load
 * request and spawns a sibling instance per prompt — the observed clone bug);
 * the context is applied once at load. Fail-loud: empty-after-clean replies
 * are retried once; a unit that still yields nothing is marked failed (never
 * recorded as a 0 or stored pending); if EVERY executed unit is empty-failed
 * the run aborts with a structured error and nothing finalizes.
 */
import { acquireInferenceSlot } from "../helpers/inferenceGate.js";
import { NanitesError } from "../helpers/errors.js";
import { unloadModelKey } from "./runSubAgent.js";
import { clientForProfile } from "../tools/deps.js";
import { scoreDeterministicRule } from "../testunits/scorer.js";
import { paramsForCandidate } from "../testunits/candidateParams.js";
import { cleanReply } from "../helpers/cleaner.js";
import { concurrencyLoadExtras } from "../helpers/concurrency.js";
import { GENERATION_IDLE_TIMEOUT_MS } from "../helpers/idleTimeout.js";
import { ensureHealthy } from "./guard.js";
import { finalizeIfComplete } from "./finalize.js";
import { contextCeilingForVram } from "../guardrails/tiers.js";
import { loadTimeoutFor } from "../helpers/performanceScorer.js";
import { DEFAULT_EFFORT } from "../storage/profileDefaults.js";
import { fireProfilePush } from "../notify/profileNotifier.js";
function clampContext(requested, modelMaxContext, vramGb) {
    if (!requested || requested <= 0)
        return { need: null, clamped: false, requested: null, used: null };
    const max = modelMaxContext && modelMaxContext > 0 ? modelMaxContext : Number.POSITIVE_INFINITY;
    const used = Math.max(1, Math.min(requested, max, contextCeilingForVram(vramGb)));
    return { need: used, clamped: used !== requested, requested, used };
}
/**
 * Ascending context acquisition. Guarantees that before the caller chats, `state`
 * points at a loaded instance whose context is at least `need` whenever one can
 * be had without touching a user-loaded resident. Reloads only upward, and only
 * an instance this run loaded is ever evicted. Never sends `context_length` on a
 * chat — context is applied once at load here.
 */
async function ensureContext(client, profile, modelId, need, state, loadTimeoutMs) {
    const mode = profile.concurrency?.mode ?? "sequential";
    const capacity = Math.max(1, profile.concurrency?.max_parallel_models ?? 1);
    const modelsNow = async () => {
        const { models } = await client.listModels();
        return models.filter((m) => m.loaded_instances.length > 0);
    };
    const enoughId = (loaded) => {
        const same = loaded.find((m) => m.key === modelId);
        if (!same)
            return null;
        const qualifying = same.loaded_instances
            .filter((i) => need === null || (i.config?.context_length ?? 0) >= need)
            .sort((a, b) => (b.config?.context_length ?? 0) - (a.config?.context_length ?? 0));
        if (qualifying.length === 0)
            return null;
        const own = qualifying.find((i) => i.id === state.loadedId);
        return own ? own.id : qualifying[0].id;
    };
    let loaded = await modelsNow();
    // Fast path: the working instance (or any qualifying same-key resident) is
    // already adequate — adopt without reloading.
    const target = enoughId(loaded);
    if (target !== null && state.loadedId === target) {
        return { inherited_smaller: false };
    }
    if (target !== null && state.owned && state.loadedId !== null && state.loadedId !== target) {
        // A bigger same-key resident appeared (JIT sibling) while we hold a smaller
        // one of ours: reclaim ours and adopt the bigger instance.
        await client.unloadModel({ instance_id: state.loadedId }).catch(() => { });
        state.loadedId = target;
        return { inherited_smaller: false };
    }
    if (target !== null) {
        // Inherited resident (user-loaded) that already meets the need: adopt it and
        // run at its window — it is never reloaded or torn down.
        state.loadedId = target;
        state.owned = false;
        return { inherited_smaller: false };
    }
    // No adequate same-key resident. Reclaim a smaller instance we own before
    // loading bigger (bump upward, one resident at a time).
    if (state.owned && state.loadedId !== null) {
        await client.unloadModel({ instance_id: state.loadedId }).catch(() => { });
        state.loadedId = null;
        state.owned = false;
        loaded = await modelsNow();
    }
    // A same-key resident smaller than needed that we do NOT own is the user's
    // model — the doc contract says never touch it, so run at its window.
    const sameKey = loaded.find((m) => m.key === modelId);
    const inherited = sameKey?.loaded_instances[0];
    if (inherited && !state.owned) {
        state.loadedId = inherited.id;
        state.owned = false;
        return { inherited_smaller: true };
    }
    if (loaded.length >= capacity) {
        if (mode === "sequential" && loaded.length > 0) {
            // Sequential tier has room for one: evict the unrelated occupant so the
            // test isn't run under VRAM contention.
            const victim = loaded[0].loaded_instances[0].id;
            await client.unloadModel({ instance_id: victim }).catch(() => { });
        }
        else {
            throw new NanitesError({
                code: "concurrency_limit",
                message: `Profile is at its parallel-tier limit (${loaded.length} loaded, max ${capacity})`,
                retryable: true,
                details: { loaded: loaded.length, max_parallel_models: capacity },
            });
        }
    }
    const loadReq = {
        model: modelId,
        ...(need ? { context_length: need } : {}),
        ...concurrencyLoadExtras(profile.concurrency?.num_parallel ?? 1),
    };
    const loadResp = await client.loadModelWithHeartbeat(loadReq, { timeoutMs: loadTimeoutMs });
    state.loadedId = loadResp.instance_id;
    state.owned = true;
    return { inherited_smaller: false };
}
export async function runTestRegimen(deps, profileName, modelId, opts = {}) {
    const profile = deps.profiles.getProfile(profileName);
    if (!profile) {
        throw new NanitesError({ code: "profile_not_found", message: `No profile named "${profileName}"`, retryable: false });
    }
    // Cloud regimen: routed per-unit chats, no LM Studio
    // lifecycle. Handled by its own pass so the local path below stays untouched.
    if (opts.provider !== undefined && opts.provider !== "local") {
        return runCloudRegimen(deps, profileName, modelId, profile, opts);
    }
    // Health gate runs before anything else; abort cleanly when down (pushing a
    // health-down notification when a topic is configured).
    try {
        await ensureHealthy(profileName, deps, opts);
    }
    catch (err) {
        if (err instanceof NanitesError && err.code === "health_check_failed") {
            const reason = err.details?.reason ?? err.message;
            void fireProfilePush(profile, "health_down", { profile: profileName, code: err.code, reason });
        }
        throw err;
    }
    let units = deps.testUnits.list(profileName);
    if (units.length === 0) {
        deps.testUnits.registerDefaultRegimen(profileName);
        units = deps.testUnits.list(profileName);
    }
    void fireProfilePush(profile, "regimen.start", {
        profile: profileName,
        model_id: modelId,
        unit_count: units.length,
    });
    const client = clientForProfile(profile, opts.clientTimeoutMs ? { timeoutMs: opts.clientTimeoutMs } : undefined);
    // Per-unit chats stream and are idle-killed (a stuck unit dies on silence,
    // not on a guessed fixed budget), never cutting off a slow-but-alive model.
    const idleTimeoutMs = opts.idle_timeout_ms ?? GENERATION_IDLE_TIMEOUT_MS;
    const state = { loadedId: null, owned: false };
    // Size the load request's timeout from the model's recorded load history
    // (generous on first load, then 3x the rolling average + buffer).
    const loadTimeoutMs = loadTimeoutFor(deps.registry.get(profileName, modelId)?.avg_load_ms ?? null);
    // Best-effort context-ceiling discovery for clamping (mirrors run_sub_agent).
    let modelMaxContext = null;
    try {
        const { models } = await client.listModels();
        modelMaxContext = models.find((m) => m.key === modelId)?.max_context_length ?? null;
    }
    catch {
        // Best effort; clampContext falls back to the VRAM-tier ceiling alone.
    }
    const deterministicUnits = units.filter((u) => u.scoring.method === "deterministic_rule");
    const judgedUnits = units.filter((u) => u.scoring.method === "orchestrator_judged");
    const existingRows = deps.testResults.list(profileName, modelId);
    // Run stamp: next run number, so this cycle's rows supersede the last.
    const testRun = existingRows.reduce((max, r) => Math.max(max, r.test_run ?? 0), 0) + 1;
    // Live (pending|staged) rows already on disk — judged units mid-judgment
    // from an earlier run. They are skipped below, not re-run or stacked.
    const liveByUnit = new Map();
    for (const r of existingRows) {
        if (r.status === "pending" || r.status === "staged") {
            const arr = liveByUnit.get(r.unit_id) ?? [];
            arr.push(r);
            liveByUnit.set(r.unit_id, arr);
        }
    }
    // Attempt numbering continues from the param-search log (max+1) so judged
    // attempts logged at submit time (D10) never collide with regimen logs.
    let attempt = deps.paramSearch.nextAttempt(profileName, modelId);
    let paramAttempts = 0;
    const failedEmptyUnits = [];
    const clampedUnits = [];
    let executedUnits = 0;
    let deterministicScored = 0;
    const planFor = (unit) => {
        const plan = clampContext(unit.recommended_config?.context_length, modelMaxContext, profile.machine_specs.vram_gb);
        if (plan.clamped && plan.requested !== null && plan.used !== null) {
            clampedUnits.push({ unit_id: unit.id, requested: plan.requested, used: plan.used });
        }
        return plan;
    };
    // CP-4: a local regimen loads a model and runs one inference at a time, so
    // it holds the same per-profile gate runSubAgent uses. Without it, a
    // blocking regimen and a concurrent sub-agent on a sequential profile each
    // acquire their own model and the sub-agent evicts the running one from
    // under it. Parallel tiers never take this gate.
    //
    // Declared outside the try and assigned inside it: acquiring before the try
    // would strand the hold for any throw in between, deadlocking the profile.
    let releaseGate;
    try {
        releaseGate = await acquireInferenceSlot(profileName);
        // Phase A: deterministic units, each under every param candidate. Every
        // attempt is logged with its attribution; only the per-unit winner is
        // recorded as approved. A candidate whose cleaned output is empty after a
        // retry is logged (score 0, EMPTY_OUTPUT) but excluded from the winner — a
        // both-empty unit is left untested rather than silently approved as 0.
        for (const unit of deterministicUnits) {
            const plan = planFor(unit);
            const rule = unit.scoring.rule;
            if (rule) {
                await ensureContext(client, profile, modelId, plan.need, state, loadTimeoutMs);
                executedUnits++;
            }
            let best = null;
            let anyReal = false;
            for (const candidate of ["baseline", "variant"]) {
                const params = paramsForCandidate(unit.recommended_config, candidate);
                if (!rule) {
                    deps.paramSearch.log({
                        profile_name: profileName,
                        model_id: modelId,
                        attempt,
                        params,
                        score: 0,
                        detail: "no_rule",
                        unit_id: unit.id,
                        candidate,
                    });
                    attempt++;
                    paramAttempts++;
                    if (best === null)
                        best = { candidate, score: { score: 0, detail: "no_rule" } };
                    anyReal = true;
                    continue;
                }
                const run = await runUnitChats(client, state.loadedId, unit, params, idleTimeoutMs);
                if (run.emptyPromptIds.length > 0) {
                    deps.paramSearch.log({
                        profile_name: profileName,
                        model_id: modelId,
                        attempt,
                        params,
                        score: 0,
                        detail: `EMPTY_OUTPUT no usable text for prompt(s): ${run.emptyPromptIds.join(", ")}`,
                        unit_id: unit.id,
                        candidate,
                    });
                    attempt++;
                    paramAttempts++;
                    continue; // empty evidence is never a winner
                }
                anyReal = true;
                const scored = scoreDeterministicRule(run.text, rule);
                const detail = plan.clamped
                    ? `${scored.detail} | clamped_context:${plan.requested}->${plan.used}`
                    : scored.detail;
                deps.paramSearch.log({
                    profile_name: profileName,
                    model_id: modelId,
                    attempt,
                    params,
                    score: scored.score,
                    detail,
                    unit_id: unit.id,
                    candidate,
                });
                attempt++;
                paramAttempts++;
                if (best === null || scored.score > best.score.score)
                    best = { candidate, score: scored };
            }
            if (anyReal && best !== null) {
                deterministicScored++;
                deps.testResults.insert({
                    profile_name: profileName,
                    model_id: modelId,
                    unit_id: unit.id,
                    status: "approved",
                    candidate: best.candidate,
                    test_run: testRun,
                    score: best.score.score,
                    raw_output: null,
                });
            }
            else if (rule) {
                failedEmptyUnits.push(unit.id);
            }
        }
        // Phase B: orchestrator-judged units. Run BOTH candidates: baseline ->
        // pending (the row judged first), variant -> staged (held until the
        // baseline judgment promotes it). NOT logged to the param search here — the
        // score only exists once the orchestrator judges (D10). A unit already
        // holding a live pending/staged row is skipped entirely (idempotent). A
        // baseline that yields nothing after retry is marked failed (no pending row,
        // variant not run); an empty variant simply skips the staged hold.
        for (const unit of judgedUnits) {
            const live = liveByUnit.get(unit.id) ?? [];
            if (live.length > 0) {
                deps.testResults.stampRun(profileName, modelId, unit.id, testRun);
                continue;
            }
            const plan = planFor(unit);
            await ensureContext(client, profile, modelId, plan.need, state, loadTimeoutMs);
            executedUnits++;
            const baselineParams = paramsForCandidate(unit.recommended_config, "baseline");
            const baselineRun = await runUnitChats(client, state.loadedId, unit, baselineParams, idleTimeoutMs);
            if (baselineRun.emptyPromptIds.length > 0) {
                failedEmptyUnits.push(unit.id);
                continue;
            }
            deps.testResults.insert({
                profile_name: profileName,
                model_id: modelId,
                unit_id: unit.id,
                status: "pending",
                candidate: "baseline",
                test_run: testRun,
                score: null,
                raw_output: baselineRun.text,
            });
            const variantParams = paramsForCandidate(unit.recommended_config, "variant");
            const variantRun = await runUnitChats(client, state.loadedId, unit, variantParams, idleTimeoutMs);
            if (variantRun.emptyPromptIds.length === 0) {
                deps.testResults.insert({
                    profile_name: profileName,
                    model_id: modelId,
                    unit_id: unit.id,
                    status: "staged",
                    candidate: "variant",
                    test_run: testRun,
                    score: null,
                    raw_output: variantRun.text,
                });
            }
        }
        // Units with a live pending row still need a judgment pass.
        const pendingUnitIds = [
            ...new Set(deps.testResults.listPending(profileName, modelId).map((r) => r.unit_id)),
        ];
        // Fail-loud: if every executed unit produced no usable output, nothing was
        // scored and nothing should finalize — abort with a structured error (the
        // teardown in the finally still unloads exactly once).
        if (executedUnits > 0 && failedEmptyUnits.length === executedUnits) {
            throw new NanitesError({
                code: "all_output_empty",
                message: `Every unit produced empty output for ${modelId} after a retry — nothing was scored or recorded`,
                retryable: true,
                details: { model_id: modelId, empty_failed: failedEmptyUnits.length, units: failedEmptyUnits },
            });
        }
        const registered_entry = pendingUnitIds.length === 0 ? finalizeIfComplete(deps, profileName, modelId) : null;
        void fireProfilePush(profile, "regimen.end", {
            profile: profileName,
            model_id: modelId,
            deterministic_scored: deterministicScored,
            pending: pendingUnitIds.length,
            empty_failed: failedEmptyUnits.length,
            registered: registered_entry !== null,
        });
        return {
            model_id: modelId,
            deterministic_scored: deterministicScored,
            pending_unit_ids: pendingUnitIds,
            registered_entry,
            param_attempts: paramAttempts,
            failed_empty_units: failedEmptyUnits,
            clamped_units: clampedUnits,
        };
    }
    catch (err) {
        const code = err instanceof NanitesError ? err.code : "unknown";
        const message = err instanceof Error ? err.message : String(err);
        const detail = err instanceof NanitesError && err.details ? JSON.stringify(err.details).slice(0, 200) : undefined;
        void fireProfilePush(profile, "regimen.error", { profile: profileName, model_id: modelId, code, message, detail });
        throw err;
    }
    finally {
        // Unload exactly once per model the regimen itself loaded — success,
        // mid-test failure, and timeout all pass through here. A reused resident
        // instance (owned false) is left alone. If load itself failed there is
        // nothing to unload. Unload failures are swallowed so they never fail the
        // pass.
        if (state.loadedId !== null && state.owned) {
            if (profile.dynamic_model !== false) {
                // Dynamic profile: reclaim the whole key so a JIT sibling instance of
                // the tested model is not left idle after the pass. Non-dynamic
                // profiles keep their user-configured resident model untouched —
                // unload only the id we loaded.
                await unloadModelKey(client, modelId).catch(() => { });
            }
            else {
                await client.unloadModel({ instance_id: state.loadedId }).catch(() => { });
            }
        }
        // Release last, after teardown, so the next waiter never observes a
        // profile whose model is still being unloaded.
        releaseGate?.();
    }
}
/** Run every prompt of a unit through the loaded model; returns the cleaned,
 * joined output. `context_length` is stripped from the wire params — context is
 * applied once at load, never per-chat (a native chat body carrying
 * `context_length` makes LM Studio JIT-load a fresh sibling instance). An
 * empty-after-clean reply is retried once on the same instance. Chats stream
 * and are idle-killed rather than cut off by a fixed budget. Throws on a
 * failed/stalled chat so the caller's finally unloads the model exactly once. */
async function runUnitChats(client, instanceId, unit, params, idleTimeoutMs) {
    const { context_length: _omitted, ...wire } = params;
    const outputs = [];
    const emptyPromptIds = [];
    for (const prompt of unit.prompts) {
        const chatOnce = async () => {
            const { response } = await client.chat(instanceId, prompt.text, { ...wire, stream: true }, { idleTimeoutMs });
            const messageText = response.output
                .filter((o) => o.type === "message")
                .map((o) => o.content)
                .join("\n");
            return cleanReply(messageText, { maxChars: 100_000 }).text;
        };
        let text = await chatOnce();
        if (text.trim() === "")
            text = await chatOnce();
        if (text.trim() === "")
            emptyPromptIds.push(prompt.id);
        outputs.push(text);
    }
    return { text: outputs.join("\n\n---\n\n"), emptyPromptIds };
}
/** Default cloud unit chat: route one prompt through the provider router (its
 * own retry/key-rotation/backoff), shaped like a single-turn cloud sub-agent.
 * The router logs provider cost/usage per attempt. */
async function defaultCloudChat(input) {
    const { routeCloudWithRetry } = await import("../providers/router.js");
    const res = await routeCloudWithRetry({
        profile: input.profile,
        db: input.db,
        effort: input.effort,
        role: input.role,
        brief: input.prompt,
        messages: [{ role: "user", content: input.prompt }],
    }, input.provider, input.model_id);
    return { text: res.response.content ?? "" };
}
/** Run every prompt of a unit through the routed cloud seam, joining the cleaned
 * replies and retrying once on empty — the cloud twin of `runUnitChats`. A
 * route error (provider down, exhausted keys, refused model) propagates so the
 * regimen fails loudly instead of recording a silent 0. */
async function runCloudUnit(chat, cctx, unit) {
    const role = unit.applicable_roles[0] ?? "test_unit";
    const outputs = [];
    const emptyPromptIds = [];
    for (const prompt of unit.prompts) {
        const once = async () => cleanReply((await chat({ ...cctx, role, prompt: prompt.text })).text, { maxChars: 100_000 }).text;
        let text = await once();
        if (text.trim() === "")
            text = await once();
        if (text.trim() === "")
            emptyPromptIds.push(prompt.id);
        outputs.push(text);
    }
    return { text: outputs.join("\n\n---\n\n"), emptyPromptIds };
}
/**
 * Cloud regimen pass: same unit orchestration as the local
 * pass — deterministic winner + param-search attempts, judged pending/staged,
 * empty-retry, `test_run` stamping — but per-prompt chats route through a cloud
 * seam (default: the provider router). No load/unload/ensureContext/clamp (the
 * router's planner owns effort + ceiling) and no LMS health gate. Every
 * `test_results` row is provider-tagged so a later finalize (including the
 * provider-less submit path) writes a provider-tagged registry entry.
 */
async function runCloudRegimen(deps, profileName, modelId, profile, opts) {
    const provider = opts.provider;
    const effort = opts.effort ?? profile.inference?.effort ?? DEFAULT_EFFORT;
    const chat = opts.cloudChat ?? defaultCloudChat;
    const cctx = { profile, db: deps.db, provider, model_id: modelId, effort };
    let units = deps.testUnits.list(profileName);
    if (units.length === 0) {
        deps.testUnits.registerDefaultRegimen(profileName);
        units = deps.testUnits.list(profileName);
    }
    void fireProfilePush(profile, "regimen.start", {
        profile: profileName,
        model_id: modelId,
        provider,
        unit_count: units.length,
    });
    const deterministicUnits = units.filter((u) => u.scoring.method === "deterministic_rule");
    const judgedUnits = units.filter((u) => u.scoring.method === "orchestrator_judged");
    const existingRows = deps.testResults.list(profileName, modelId);
    const testRun = existingRows.reduce((max, r) => Math.max(max, r.test_run ?? 0), 0) + 1;
    const liveByUnit = new Map();
    for (const r of existingRows) {
        if (r.status === "pending" || r.status === "staged") {
            const arr = liveByUnit.get(r.unit_id) ?? [];
            arr.push(r);
            liveByUnit.set(r.unit_id, arr);
        }
    }
    let attempt = deps.paramSearch.nextAttempt(profileName, modelId);
    let paramAttempts = 0;
    const failedEmptyUnits = [];
    let executedUnits = 0;
    let deterministicScored = 0;
    try {
        // Deterministic units, one chat per prompt under each candidate. Cloud
        // candidates carry no sampling params (the router's planner owns them), but
        // both passes + both param-search attempts are logged for shape parity.
        for (const unit of deterministicUnits) {
            const rule = unit.scoring.rule;
            if (rule)
                executedUnits++;
            let best = null;
            let anyReal = false;
            for (const candidate of ["baseline", "variant"]) {
                if (!rule) {
                    deps.paramSearch.log({
                        profile_name: profileName,
                        model_id: modelId,
                        attempt,
                        params: paramsForCandidate(unit.recommended_config, candidate),
                        score: 0,
                        detail: "no_rule",
                        unit_id: unit.id,
                        candidate,
                    });
                    attempt++;
                    paramAttempts++;
                    if (best === null)
                        best = { candidate, score: { score: 0, detail: "no_rule" } };
                    anyReal = true;
                    continue;
                }
                const run = await runCloudUnit(chat, cctx, unit);
                if (run.emptyPromptIds.length > 0) {
                    deps.paramSearch.log({
                        profile_name: profileName,
                        model_id: modelId,
                        attempt,
                        params: paramsForCandidate(unit.recommended_config, candidate),
                        score: 0,
                        detail: `EMPTY_OUTPUT no usable text for prompt(s): ${run.emptyPromptIds.join(", ")}`,
                        unit_id: unit.id,
                        candidate,
                    });
                    attempt++;
                    paramAttempts++;
                    continue; // empty evidence is never a winner
                }
                anyReal = true;
                const scored = scoreDeterministicRule(run.text, rule);
                deps.paramSearch.log({
                    profile_name: profileName,
                    model_id: modelId,
                    attempt,
                    params: paramsForCandidate(unit.recommended_config, candidate),
                    score: scored.score,
                    detail: scored.detail,
                    unit_id: unit.id,
                    candidate,
                });
                attempt++;
                paramAttempts++;
                if (best === null || scored.score > best.score.score)
                    best = { candidate, score: scored };
            }
            if (anyReal && best !== null) {
                deterministicScored++;
                deps.testResults.insert({
                    profile_name: profileName,
                    model_id: modelId,
                    unit_id: unit.id,
                    provider,
                    status: "approved",
                    candidate: best.candidate,
                    test_run: testRun,
                    score: best.score.score,
                    raw_output: null,
                });
            }
            else if (rule) {
                failedEmptyUnits.push(unit.id);
            }
        }
        // Judged units: baseline -> pending (judged first), variant -> staged hold.
        // A unit already holding a live pending/staged row is skipped (idempotent).
        for (const unit of judgedUnits) {
            const live = liveByUnit.get(unit.id) ?? [];
            if (live.length > 0) {
                deps.testResults.stampRun(profileName, modelId, unit.id, testRun);
                continue;
            }
            executedUnits++;
            const baselineRun = await runCloudUnit(chat, cctx, unit);
            if (baselineRun.emptyPromptIds.length > 0) {
                failedEmptyUnits.push(unit.id);
                continue;
            }
            deps.testResults.insert({
                profile_name: profileName,
                model_id: modelId,
                unit_id: unit.id,
                provider,
                status: "pending",
                candidate: "baseline",
                test_run: testRun,
                score: null,
                raw_output: baselineRun.text,
            });
            const variantRun = await runCloudUnit(chat, cctx, unit);
            if (variantRun.emptyPromptIds.length === 0) {
                deps.testResults.insert({
                    profile_name: profileName,
                    model_id: modelId,
                    unit_id: unit.id,
                    provider,
                    status: "staged",
                    candidate: "variant",
                    test_run: testRun,
                    score: null,
                    raw_output: variantRun.text,
                });
            }
        }
        const pendingUnitIds = [
            ...new Set(deps.testResults.listPending(profileName, modelId).map((r) => r.unit_id)),
        ];
        if (executedUnits > 0 && failedEmptyUnits.length === executedUnits) {
            throw new NanitesError({
                code: "all_output_empty",
                message: `Every unit produced empty output for ${modelId} after a retry — nothing was scored or recorded`,
                retryable: true,
                details: { model_id: modelId, provider, empty_failed: failedEmptyUnits.length, units: failedEmptyUnits },
            });
        }
        const registered_entry = pendingUnitIds.length === 0 ? finalizeIfComplete(deps, profileName, modelId, provider) : null;
        void fireProfilePush(profile, "regimen.end", {
            profile: profileName,
            model_id: modelId,
            provider,
            deterministic_scored: deterministicScored,
            pending: pendingUnitIds.length,
            empty_failed: failedEmptyUnits.length,
            registered: registered_entry !== null,
        });
        return {
            model_id: modelId,
            deterministic_scored: deterministicScored,
            pending_unit_ids: pendingUnitIds,
            registered_entry,
            param_attempts: paramAttempts,
            failed_empty_units: failedEmptyUnits,
            clamped_units: [], // no context clamping on the cloud path
        };
    }
    catch (err) {
        const code = err instanceof NanitesError ? err.code : "unknown";
        const message = err instanceof Error ? err.message : String(err);
        const detail = err instanceof NanitesError && err.details ? JSON.stringify(err.details).slice(0, 200) : undefined;
        void fireProfilePush(profile, "regimen.error", { profile: profileName, model_id: modelId, provider, code, message, detail });
        throw err;
    }
}
