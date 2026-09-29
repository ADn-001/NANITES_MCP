/**
 * Model discovery for the router.
 *
 * One entry point, called by every test action (provider ping, key test, model
 * test, key add). Centralising it means no call site can forget to refresh, and
 * it means the refresh behaviour is defined once rather than four times.
 *
 * Two deliberate differences from the MCP server's `discoverProviderModels`:
 *
 *  - **No 20-model truncation.** That limit exists because an MCP tool result
 *    goes into the orchestrator's context. A catalog endpoint has no such
 *    budget, and silently truncating makes a configured provider look like it
 *    has fewer models than it does.
 *  - **Per-provider failures are visible.** The dashboard's discover
 *    swallows them, which leaves a user believing a configured provider has an
 *    empty catalog. Here a failure is returned, not swallowed.
 */
import type { DatabaseSync } from "node:sqlite";
import { createProviderClient, GenericClient } from "../../providers/client.js";
import { ProviderKeyStore } from "../../storage/providerKeyStore.js";
import { ProviderModelStore } from "../../storage/providerModelStore.js";
import { NanitesError } from "../../helpers/errors.js";
import type { ProviderKind } from "../../storage/profileDefaults.js";
import { ROUTER_PROFILE } from "../constants.js";

export interface DiscoveryResult {
  provider: string;
  discovered: number;
  ok: true;
}

export interface DiscoveryFailure {
  provider: string;
  ok: false;
  code: string;
  message: string;
}

export type DiscoveryOutcome = DiscoveryResult | DiscoveryFailure;

/**
 * Discover and upsert one provider's catalog. Returns the outcome rather than
 * throwing, so a caller refreshing several providers sees which one failed.
 */
export async function discoverAndRefresh(db: DatabaseSync, provider: ProviderKind): Promise<DiscoveryOutcome> {
  const keyStore = new ProviderKeyStore(db);
  const keys = keyStore.availableKeys(ROUTER_PROFILE, provider);

  if (keys.length === 0) {
    return {
      provider,
      ok: false,
      code: "all_keys_exhausted",
      message: `No enabled, un-exhausted key on "${provider}".`,
    };
  }

  // One key is enough to list a catalog. Which key is irrelevant here — this
  // is a read, and a rate limit on one key should not make a provider look
  // unconfigured. Key SELECTION is R3's job, for inference calls.
  const key = keys[0]!;

  try {
    let models;
    if (provider === "cloudflare") {
      if (!key.account_id) {
        return {
          provider,
          ok: false,
          code: "invalid_arguments",
          message: "A Cloudflare key requires an account_id.",
        };
      }
      models = (await createProviderClient(provider).listModels(key.api_key, key.account_id)).models;
    } else if (provider === "generic" || provider === "omniroute") {
      const base = key.gateway_url
        ?? (provider === "omniroute" ? "http://localhost:20128/v1" : "http://localhost:8080/v1");
      models = (await new GenericClient(base).listModels(key.api_key)).models;
    } else {
      models = (await createProviderClient(provider).listModels(key.api_key)).models;
    }

    // The full set, untruncated. `upsertModels` is a batch upsert with
    // COALESCE on pricing, so a priceless discovery cannot erase a
    // manifest-seeded rate.
    new ProviderModelStore(db).upsertModels(ROUTER_PROFILE, provider, models);
    return { provider, discovered: models.length, ok: true };
  } catch (err) {
    return {
      provider,
      ok: false,
      code: (err as { code?: string }).code ?? "unexpected_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Refresh every configured provider, reporting each outcome. */
export async function discoverAll(db: DatabaseSync, providers: ProviderKind[]): Promise<DiscoveryOutcome[]> {
  const out: DiscoveryOutcome[] = [];
  for (const p of providers) out.push(await discoverAndRefresh(db, p));
  return out;
}

/** Throw a structured error when discovery failed, for single-provider callers. */
export function assertDiscovered(outcome: DiscoveryOutcome): asserts outcome is DiscoveryResult {
  if (!outcome.ok) {
    throw new NanitesError({
      code: outcome.code,
      message: `Discovery failed for "${outcome.provider}": ${outcome.message}`,
      retryable: false,
      details: { provider: outcome.provider },
    });
  }
}
