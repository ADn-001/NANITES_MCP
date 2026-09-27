/**
 * Cost-saved report (Workflow #5): sum logged sub-agent token usage over a
 * period and convert it to orchestrator-equivalent USD at the active profile's
 * input/output rates. Delegating to local models costs ~$0, so the saved delta
 * is the orchestrator-equivalent cost the orchestrator did NOT spend. Pure
 * arithmetic over real logged usage — nothing inferred. `now` is injectable so
 * period windows are deterministic under test.
 */
import { NanitesError } from "../helpers/errors.js";
import { ProviderModelStore } from "../storage/providerModelStore.js";
const DAY_MS = 24 * 60 * 60 * 1000;
function periodWindowMs(period) {
    switch (period) {
        case "day":
            return DAY_MS;
        case "week":
            return 7 * DAY_MS;
        case "month":
            return 30 * DAY_MS;
        default:
            return Infinity;
    }
}
export function getCostSavedReport(deps, profileName, opts = {}) {
    const profile = deps.profiles.getProfile(profileName);
    if (!profile) {
        throw new NanitesError({ code: "profile_not_found", message: `No profile named "${profileName}"`, retryable: false });
    }
    const period = opts.period ?? "all";
    const nowMs = opts.now ? new Date(opts.now).getTime() : Date.now();
    const windowMs = periodWindowMs(period);
    const cutoff = nowMs - windowMs;
    const calls = deps.callLogs
        .list(profileName, 1_000_000)
        .filter((c) => {
        const created = new Date(c.created_at ?? "").getTime();
        return Number.isFinite(created) && (windowMs === Infinity || created >= cutoff);
    });
    // Cloud calls live in their own table and were previously invisible here:
    // delegation to a provider is still delegation, so its tokens count toward
    // what the orchestrator did not have to spend.
    const cloudCalls = deps.providerCallLogs.listRecent(profileName, {
        sinceIso: windowMs === Infinity ? null : new Date(cutoff).toISOString(),
    });
    const inputRate = profile.pricing.input_per_million_usd;
    const outputRate = profile.pricing.output_per_million_usd;
    const equivOf = (ti, to) => (ti / 1_000_000) * inputRate + (to / 1_000_000) * outputRate;
    const byModel = new Map();
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let totalEquiv = 0;
    let totalSpend = 0;
    const add = (modelId, provider, ti, to, spend) => {
        totalTokensIn += ti;
        totalTokensOut += to;
        const equiv = equivOf(ti, to);
        totalEquiv += equiv;
        totalSpend += spend;
        // Keyed by provider as well as model id. A cloud model id can also appear
        // in the local call log, and keying on the id alone merged the two: the
        // first row created won the `provider` field, and locals are added first,
        // so every cloud model was reported as provider "local" while cloud_calls
        // counted it correctly. Provider is part of a model's identity here, the
        // same way the registry namespaces local and cloud entries.
        const key = provider + "|" + modelId;
        const row = byModel.get(key) ?? {
            model_id: modelId, provider, calls: 0, tokens_in: 0, tokens_out: 0,
            orchestrator_equivalent_usd: 0, actual_cost_usd: 0,
        };
        row.calls += 1;
        row.tokens_in += ti;
        row.tokens_out += to;
        row.orchestrator_equivalent_usd += equiv;
        row.actual_cost_usd += spend;
        byModel.set(key, row);
    };
    for (const call of calls)
        add(call.model_id, "local", call.tokens_in, call.tokens_out, 0);
    for (const call of cloudCalls)
        add(call.model_id, call.provider, call.tokens_in, call.tokens_out, call.cost_usd ?? 0);
    const breakdown = [...byModel.values()].sort((a, b) => a.model_id.localeCompare(b.model_id));
    // A model with no output rate cannot produce a real `cost_usd`: its ledger row
    // carries null, and `call.cost_usd ?? 0` above counts that as free. Naming the
    // count is what turns a silent zero into a visible gap — and it is the number
    // that was 14 before the manifest pricing landed.
    const unpricedModels = new ProviderModelStore(deps.db)
        .listModels(profileName, undefined, true)
        .filter((m) => m.pricing_completion == null).length;
    return {
        profile_name: profileName,
        period,
        calls: calls.length + cloudCalls.length,
        cloud_calls: cloudCalls.length,
        tokens_in: totalTokensIn,
        tokens_out: totalTokensOut,
        orchestrator_equivalent_usd: totalEquiv,
        saved_usd: totalEquiv,
        actual_spend_usd: totalSpend,
        unpriced_models: unpricedModels,
        notes: "Covers local and cloud delegation. saved_usd is the orchestrator-equivalent cost (at this profile's input/output rates) that was NOT spent; actual_spend_usd is what cloud providers really charged, so the net saving is saved_usd minus actual_spend_usd.",
        breakdown,
    };
}
