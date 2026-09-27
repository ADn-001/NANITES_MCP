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
import type { ToolDeps } from "../tools/deps.js";
import type { ProviderKind } from "../storage/profileDefaults.js";

export type ReportPeriod = "all" | "day" | "week" | "month";

export interface CostSavedReportOptions {
  period?: ReportPeriod;
  /** ISO timestamp acting as "now" for period windows. Defaults to now. */
  now?: string;
}

export interface ModelBreakdown {
  model_id: string;
  /** Which namespace the model ran in: `local` (LM Studio) or a cloud kind. */
  provider: ProviderKind | "local";
  calls: number;
  tokens_in: number;
  tokens_out: number;
  orchestrator_equivalent_usd: number;
  /** What the provider actually charged for these calls, from the logged
   * `cost_usd`. Zero for local runs, which cost nothing. */
  actual_cost_usd: number;
}

export interface CostSavedReportResult {
  profile_name: string;
  period: ReportPeriod;
  calls: number;
  /** Calls that ran on a cloud provider rather than LM Studio. */
  cloud_calls: number;
  tokens_in: number;
  tokens_out: number;
  orchestrator_equivalent_usd: number;
  saved_usd: number;
  /** Real money paid to cloud providers in this window. Local runs add nothing.
   * `saved_usd` is the orchestrator-equivalent avoided; this is what was spent
   * instead, so the honest saving is the difference. */
  actual_spend_usd: number;
  /** Registered provider models with no output rate, whose cloud calls log a
   * null `cost_usd` and are therefore counted as zero above. Non-zero means
   * `actual_spend_usd` understates what was really spent. */
  unpriced_models: number;
  notes: string;
  breakdown: ModelBreakdown[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function periodWindowMs(period: ReportPeriod): number {
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

export function getCostSavedReport(deps: ToolDeps, profileName: string, opts: CostSavedReportOptions = {}): CostSavedReportResult {
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
  const equivOf = (ti: number, to: number): number => (ti / 1_000_000) * inputRate + (to / 1_000_000) * outputRate;

  const byModel = new Map<string, ModelBreakdown>();
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalEquiv = 0;
  let totalSpend = 0;

  const add = (modelId: string, provider: ProviderKind | "local", ti: number, to: number, spend: number): void => {
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

  for (const call of calls) add(call.model_id, "local", call.tokens_in, call.tokens_out, 0);
  for (const call of cloudCalls) add(call.model_id, call.provider, call.tokens_in, call.tokens_out, call.cost_usd ?? 0);

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
