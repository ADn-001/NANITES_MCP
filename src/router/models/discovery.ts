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
import { NanitesError } from "../../helpers/errors.js";
import type { ProviderKind } from "../../storage/profileDefaults.js";
import { routerProfile } from "../constants.js";
import { applyCfCapabilities } from "../providers/cloudflare/capabilities.js";
import { discoverModels } from "../providers/discover.js";

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
 * Discover and upsert one provider's catalog for the ROUTER.
 *
 * A thin wrapper over the shared `discoverModels`, adding only what is
 * router-specific: the profile it resolves against, and the Cloudflare
 * capability pass that fills the audio/image columns R5a reads.
 *
 * It used to carry its own copy of the key-selection and base-URL logic, which
 * had already drifted from the MCP tool's — see src/router/providers/discover.ts.
 */
export async function discoverAndRefresh(db: DatabaseSync, provider: ProviderKind): Promise<DiscoveryOutcome> {
  const outcome = await discoverModels(db, provider, {
    profile: routerProfile(),
    // The published Cloudflare catalog carries no usable capability data for
    // the non-text models, so the REGISTRY supplies it. This is what fills the
    // audio/image capability columns R5a needs and nothing else populates.
    //
    // A separate pass, not part of upsertModels: a model Cloudflare no longer
    // offers must NOT keep its flags. The registry seeds; discovery decides.
    afterCloudflareUpsert: provider === "cloudflare" ? applyCfCapabilities : undefined,
  });
  if (outcome.ok) {
    return { provider: outcome.provider, discovered: outcome.model_count, ok: true };
  }
  return { provider: outcome.provider, ok: false, code: outcome.code, message: outcome.message };
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
