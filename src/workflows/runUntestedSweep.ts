/**
 * Workflow #3: diff the endpoint's downloaded-model list against the active
 * profile's registry and run Workflow #1 on every unregistered LLM. Discovery
 * stays deterministic (findUntestedModels); this orchestrates the per-model
 * regimen runs sequentially so the diff + sweep is a single script chain.
 * ntfy: the health gate pushes health_down on failure, and the sprint boundary
 * (start/end/abort) is notified ONLY here — model-level regimen notifs fire
 * inside runTestRegimen and inherit to download_and_test without a sprint here.
 */
import { NanitesError } from "../helpers/errors.js";
import type { ToolDeps } from "../tools/deps.js";
import { clientForProfile } from "../tools/deps.js";
import { ensureHealthy, type HealthGateOptions } from "./guard.js";
import { findUntestedModels, modelKey, sortBySizeAscending } from "./untested.js";
import { runTestRegimen, type RunRegimenSummary } from "./runTestRegimen.js";
import { fireProfilePush } from "../notify/profileNotifier.js";

export interface SweepOptions extends HealthGateOptions {
  clientTimeoutMs?: number;
}

export interface SweepFailure {
  model_id: string;
  error: { code: string; message: string };
}

export interface SweepResult {
  untested_count: number;
  models: string[];
  summaries: RunRegimenSummary[];
  /** Per-model failures: one model's failure never aborts the sweep — it is
   * recorded and the next model runs. */
  failures: SweepFailure[];
}

export async function runUntestedSweep(deps: ToolDeps, profileName: string, opts: SweepOptions = {}): Promise<SweepResult> {
  const profile = deps.profiles.getProfile(profileName);
  if (!profile) {
    throw new NanitesError({ code: "profile_not_found", message: `No profile named "${profileName}"`, retryable: false });
  }

  try {
    await ensureHealthy(profileName, deps, opts);
  } catch (err) {
    if (err instanceof NanitesError && err.code === "health_check_failed") {
      const reason = (err.details as { reason?: string } | undefined)?.reason ?? err.message;
      void fireProfilePush(profile, "health_down", { profile: profileName, code: err.code, reason });
    }
    throw err;
  }

  const client = clientForProfile(profile, opts.clientTimeoutMs ? { timeoutMs: opts.clientTimeoutMs } : undefined);
  const { models } = await client.listModels();
  const untested = sortBySizeAscending(findUntestedModels(models, deps.registry.list(profileName)));
  const keys = untested.map(modelKey);

  const summaries: RunRegimenSummary[] = [];
  const failures: SweepFailure[] = [];
  try {
    void fireProfilePush(profile, "sprint.start", {
      profile: profileName,
      untested_count: untested.length,
      models: keys,
    });
    for (const model of untested) {
      const key = modelKey(model);
      try {
        summaries.push(await runTestRegimen(deps, profileName, key, opts));
      } catch (err) {
        failures.push({
          model_id: key,
          error:
            err instanceof NanitesError
              ? { code: err.code, message: err.message }
              : { code: "unknown", message: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  } catch (err) {
    // A health_check_failed here was already pushed by the gate above; don't
    // double-notify an abort for the same condition.
    if (!(err instanceof NanitesError && err.code === "health_check_failed")) {
      const code = err instanceof NanitesError ? err.code : "unknown";
      const message = err instanceof Error ? err.message : String(err);
      void fireProfilePush(profile, "sprint.abort", { profile: profileName, code, message });
    }
    throw err;
  }

  void fireProfilePush(profile, "sprint.end", {
    profile: profileName,
    tested: summaries.length,
    failures: failures.length,
  });
  return { untested_count: untested.length, models: keys, summaries, failures };
}
