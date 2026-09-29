/**
 * Provider model discovery, shared by the MCP tool and the router.
 *
 * ## Why this was extracted
 *
 * `nanites_discoverProviderModels` (src/tools/providers.ts) and the router's
 * `discoverAndRefresh` (src/router/models/discovery.ts) were two copies of the
 * same sequence: pick an available key, work out the base URL, list models,
 * upsert. They had already drifted — the MCP copy hardcoded a base URL for
 * `omniroute` that the router copy derived from the key, so a key configured
 * with a custom gateway was honoured by one caller and ignored by the other.
 *
 * That is the failure this file prevents: a provider that lists models for the
 * Providers tab and not for the router is indistinguishable from a provider
 * with no models, and the fix (re-entering the key) is the wrong one.
 *
 * The base-URL rules are therefore stated ONCE:
 *   - `generic`   -> the key's `gateway_url`, else http://localhost:8080/v1
 *   - `omniroute` -> the key's `gateway_url`, else http://localhost:20128/v1
 *   - everything else -> the client default
 *
 * The key's `gateway_url` WINS for both, which is the behaviour the router had
 * and the MCP path did not.
 */
import type { DatabaseSync } from "node:sqlite";
import type { ProviderKind } from "../../storage/profileDefaults.js";
import { ProviderKeyStore } from "../../storage/providerKeyStore.js";
import type { ProviderKey } from "../../providers/types.js";
import { ProviderModelStore } from "../../storage/providerModelStore.js";
import { createProviderClient } from "../../providers/client.js";
import { GenericClient } from "../../providers/client.js";

export interface DiscoveryOk {
  ok: true;
  provider: ProviderKind;
  model_count: number;
}

export interface DiscoveryErr {
  ok: false;
  provider: ProviderKind;
  code: string;
  message: string;
}

export type DiscoveryOutcome = DiscoveryOk | DiscoveryErr;

/** The base URL a provider's list-models call should use, from the key. */
export function discoveryBaseUrl(provider: ProviderKind, key: ProviderKey): string | undefined {
  if (provider === "generic") return key.gateway_url ?? "http://localhost:8080/v1";
  if (provider === "omniroute") return key.gateway_url ?? "http://localhost:20128/v1";
  return undefined;
}

export interface DiscoverOptions {
  profile: string;
  /**
   * Called after a Cloudflare upsert, so the registry can fill the capability
   * columns discovery does not carry. The router needs it (R5a reads those
   * columns); the Providers tab does not.
   */
  afterCloudflareUpsert?: (db: DatabaseSync) => void;
}

/**
 * List and upsert one provider's catalog.
 *
 * Returns an outcome rather than throwing, so a caller refreshing several
 * providers can see which one failed instead of losing the batch to the first
 * error. The MCP tool converts the failure back into a throw at its boundary.
 */
export async function discoverModels(
  db: DatabaseSync,
  provider: ProviderKind,
  opts: DiscoverOptions,
): Promise<DiscoveryOutcome> {
  const keyStore = new ProviderKeyStore(db);
  const keys = keyStore.availableKeys(opts.profile, provider);
  if (keys.length === 0) {
    return {
      ok: false,
      provider,
      code: "all_keys_exhausted",
      message: `No enabled, un-exhausted key on "${provider}". Add a key first.`,
    };
  }

  // One key is enough to LIST a catalog. Which key is irrelevant here: this is
  // a read, and a rate limit on one key must not make a provider look
  // unconfigured. Key SELECTION for inference is a separate concern.
  const key = keys[0]!;
  const base = discoveryBaseUrl(provider, key);

  try {
    let models: Awaited<ReturnType<GenericClient["listModels"]>>["models"];
    if (provider === "cloudflare") {
      if (!key.account_id) {
        return {
          ok: false,
          provider,
          code: "invalid_arguments",
          message: "A Cloudflare key requires an account_id.",
        };
      }
      models = (await createProviderClient(provider).listModels(key.api_key, key.account_id)).models;
    } else if (provider === "generic" || provider === "omniroute") {
      models = (await new GenericClient(base!).listModels(key.api_key)).models;
    } else {
      models = (await createProviderClient(provider).listModels(key.api_key)).models;
    }

    // The full set, untruncated. `upsertModels` COALESCEs pricing, so a
    // priceless discovery cannot erase a manifest-seeded rate.
    new ProviderModelStore(db).upsertModels(opts.profile, provider, models);
    if (provider === "cloudflare") opts.afterCloudflareUpsert?.(db);

    return { ok: true, provider, model_count: models.length };
  } catch (err) {
    return {
      ok: false,
      provider,
      code: "provider_unavailable",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
