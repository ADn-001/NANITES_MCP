/**
 * Bulk-seed + preferred-model pin workflows. Seed is
 * deterministic and idempotent: register each manifest model in the provider
 * catalog with its manifest capabilities, role-tag it in the registry (the
 * single role/scoring record, D5 — never clobbering a tested entry), and write
 * the default pins for roles that do not already carry one. Pin CRUD
 * is thin store access with the same structured-error envelope as every other
 * tool.
 *
 * Security (D12): this module only writes the provider model catalog, the
 * registry, and role pins — never any API-key material.
 */
import { NanitesError } from "../helpers/errors.js";
import type { ToolDeps } from "../tools/deps.js";
import { requireActiveProfile } from "../tools/deps.js";
import { ProviderModelStore, type ManifestModelSpec } from "../storage/providerModelStore.js";
import { RegistryStore, type RegistryEntry } from "../storage/registryStore.js";
import { RolePinStore } from "../storage/rolePinStore.js";
import { stalePin } from "./resolveRoleModel.js";
import type { Profile, ProviderKind } from "../storage/profileDefaults.js";
import {
  CLOUDFLARE_AGENT_MANIFEST,
  CLOUDFLARE_DEFAULT_PINS,
  type CloudflareAgentSeed,
} from "../seed/cloudflareAgentManifest.js";

export const SEED_PROVIDERS: readonly ProviderKind[] = ["cloudflare"];

export interface SeedProviderModelsInput {
  profile?: string;
  /** Only cloudflare carries a manifest today. Default cloudflare. */
  provider?: string;
  /** Subset of the manifest to seed; default all entries. */
  model_ids?: string[];
}

export interface SeedSummary {
  profile: string;
  provider: ProviderKind;
  models_registered: Array<{ model_id: string; roles: string[]; vision: boolean }>;
  registered_count: number;
  already_registered_count: number;
  role_tagged: string[];
  role_tags_tested_kept: string[];
  default_pins_written: Array<{ role: string; model_id: string }>;
  default_pins_preserved: string[];
}

export function profileFor(deps: ToolDeps, name?: string): Profile {
  if (name) {
    const profile = deps.profiles.getProfile(name);
    if (!profile) {
      throw new NanitesError({ code: "unknown_profile", message: `Unknown profile '${name}'.`, retryable: false });
    }
    return profile;
  }
  return requireActiveProfile(deps);
}

function sameRoleSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((r) => set.has(r));
}

/** Untested placeholder registry row (role-tag only, no scoring evidence yet). */
function isPlaceholder(entry: RegistryEntry | null): boolean {
  if (!entry) return true;
  if (entry.last_tested !== null) return false;
  return Object.values(entry.scores ?? {}).every((s) => !s || s <= 0);
}

export function seedProviderModels(deps: ToolDeps, input: SeedProviderModelsInput): SeedSummary {
  const profile = profileFor(deps, input.profile);
  const provider = input.provider ?? "cloudflare";
  if (!SEED_PROVIDERS.includes(provider as ProviderKind)) {
    throw new NanitesError({
      code: "no_seed_manifest_for_provider",
      message: `No seed manifest for provider '${provider}'. Only ${SEED_PROVIDERS.join(", ")} has a canonical agentic-model manifest.`,
      retryable: false,
    });
  }
  const prov = provider as ProviderKind;

  const manifestById = new Map(CLOUDFLARE_AGENT_MANIFEST.map((m) => [m.model_id, m]));
  const requested = input.model_ids?.length ? input.model_ids : [...manifestById.keys()];
  const unknown = requested.filter((id) => !manifestById.has(id));
  if (unknown.length > 0) {
    // D11: refuse before any write — never a partial seed.
    throw new NanitesError({
      code: "unknown_manifest_model",
      message: `Unknown manifest model id(s): ${unknown.join(", ")}. They are not in the Cloudflare agentic-model manifest.`,
      retryable: false,
    });
  }

  const modelStore = new ProviderModelStore(deps.db);
  const registry = deps.registry;
  const pins = new RolePinStore(deps.db);

  const models_registered: SeedSummary["models_registered"] = [];
  let already_registered_count = 0;
  const role_tagged: string[] = [];
  const role_tags_tested_kept: string[] = [];
  const default_pins_written: SeedSummary["default_pins_written"] = [];
  const default_pins_preserved: string[] = [];

  for (const model of requested) {
    const seed = manifestById.get(model)!;
    const existed = modelStore.getModel(profile.name, prov, model) !== null;
    const spec: ManifestModelSpec = {
      model_id: seed.model_id,
      context_length: seed.context_length,
      vision: seed.vision,
      function_calling: seed.function_calling,
      reasoning: seed.reasoning,
      pricing_prompt: seed.pricing_prompt,
      pricing_completion: seed.pricing_completion,
    };
    modelStore.registerManifestModel(profile.name, prov, spec);
    if (existed) already_registered_count += 1;
    models_registered.push({ model_id: seed.model_id, roles: seed.roles, vision: seed.vision });

    // Role-tag in the registry — D5/D6 (vision models auto-carry the vision
    // role via the manifest). Never clobber a tested entry's real scores.
    const existing = registry.get(profile.name, model);
    if (isPlaceholder(existing)) {
      // Idempotence: a placeholder already role-tagged with these exact roles
      // needs no rewrite on re-seed — only genuinely new/divergent tags upsert.
      const sameTags = existing !== null && sameRoleSet(existing.roles, seed.roles);
      if (!sameTags) {
        registry.upsert(profile.name, {
          model_id: model,
          provider: prov,
          roles: seed.roles,
          scores: {},
          best_params: {},
          last_tested: null,
        });
        role_tagged.push(model);
      }
    } else {
      role_tags_tested_kept.push(model);
    }

    // Default pins whose target is this model, only where none exists yet.
    for (const pin of CLOUDFLARE_DEFAULT_PINS) {
      if (pin.model_id !== model) continue;
      if (pins.get(profile.name, pin.role)) {
        default_pins_preserved.push(pin.role);
        continue;
      }
      pins.set(profile.name, { role: pin.role, provider: prov, model_id: pin.model_id });
      default_pins_written.push({ role: pin.role, model_id: pin.model_id });
    }
  }

  return {
    profile: profile.name,
    provider: prov,
    models_registered,
    registered_count: requested.length,
    already_registered_count,
    role_tagged,
    role_tags_tested_kept,
    default_pins_written,
    default_pins_preserved,
  };
}

export interface PinInput {
  profile?: string;
  role: string;
  provider: string;
  model_id: string;
}

export function setRolePin(deps: ToolDeps, input: PinInput): { role: string; provider: string; model_id: string; replaced: boolean } {
  const profile = profileFor(deps, input.profile);
  const pins = new RolePinStore(deps.db);
  const replaced = pins.get(profile.name, input.role) !== null;
  pins.set(profile.name, { role: input.role, provider: input.provider as ProviderKind, model_id: input.model_id });
  return { role: input.role, provider: input.provider, model_id: input.model_id, replaced };
}

export interface ListedRolePin {
  role: string;
  provider: string;
  model_id: string;
  updated_at: string | null;
  /** The capability gate would reroute a tool-bearing run away from this pin
   * — computed now, from live registry capabilities, so it cannot
   * describe a state the pin is no longer in. */
  stale: boolean;
  /** Why, when stale. */
  stale_reason: string | null;
  /** When the gate last actually rerouted a run away from this pin, and why.
   * History: it survives the condition being fixed, and is wiped by re-pinning
   * or clearing the pin. */
  last_mismatch_at: string | null;
  last_mismatch_reason: string | null;
}

export function listRolePins(deps: ToolDeps, profileName?: string): { profile: string; pins: ListedRolePin[] } {
  const profile = profileFor(deps, profileName);
  const pins = new RolePinStore(deps.db).list(profile.name).map((p): ListedRolePin => {
    const report = stalePin(deps, profile, p);
    return {
      role: p.role,
      provider: p.provider,
      model_id: p.model_id,
      updated_at: p.updated_at ?? null,
      stale: report.stale,
      stale_reason: report.reason,
      last_mismatch_at: p.last_mismatch_at ?? null,
      last_mismatch_reason: p.last_mismatch_reason ?? null,
    };
  });
  return { profile: profile.name, pins };
}

export function deleteRolePin(deps: ToolDeps, profileName: string | undefined, role: string): { role: string; removed: boolean } {
  const profile = profileFor(deps, profileName);
  const pins = new RolePinStore(deps.db);
  return { role, removed: pins.remove(profile.name, role) };
}

export type { CloudflareAgentSeed };
