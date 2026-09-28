/**
 * Pin-aware model resolution. Orchestrator's explicit
 * `model_id`/`provider` win; otherwise a role pin (if any requested role has
 * one) auto-routes the run — pin provider `local` = LM Studio key, a cloud
 * provider = that provider's model_id. When the pinned target is unreachable
 * (not registered / no usable key), resolution falls back to the pin's
 * provider dynamic selection (router picks from sticky + registered). Only a
 * FULL provider outage (no enabled+unexhausted key OR nothing registered)
 * crosses to the next enabled provider in preference order; nothing usable
 * anywhere is a structured error. A resolution `note` explains every pivot.
 */
import { NanitesError } from "../helpers/errors.js";
import type { ToolDeps } from "../tools/deps.js";
import type { Profile, ProviderKind } from "../storage/profileDefaults.js";
import { PROVIDER_KINDS } from "../storage/profileDefaults.js";
import type { ProviderCapabilities } from "../providers/types.js";
import { RolePinStore, type RolePin } from "../storage/rolePinStore.js";
import { ProviderKeyStore } from "../storage/providerKeyStore.js";
import { ProviderModelStore } from "../storage/providerModelStore.js";
import { rolesFromBrief } from "./roleMatch.js";

export type ResolutionSource =
  | "explicit"
  | "pin"
  | "pin_fallback_dynamic"
  | "dynamic_local"
  | "dynamic_cloud"
  | "cross_endpoint";


export interface ResolvedRoleModel {
  /** "local" = LM Studio path; a cloud kind = cloud path. */
  provider: ProviderKind;
  /** Concrete model to run. null => dynamic (router / findBestModel decides). */
  model_id: string | null;
  source: ResolutionSource;
  note?: string;
}

export interface ResolveInput {
  /** Requested roles (pin match order). When empty, keywords from the brief apply. */
  roles?: string[];
  brief?: string;
  /** Orchestrator-explicit provider/cloud kind. */
  explicitProvider?: ProviderKind;
  /** Orchestrator-explicit model id. */
  explicitModel?: string;
  /** Image input present on the run. Vision is cloud-only:
   * the run routes to the `vision` pin, else the best registered
   * vision-capable model, and never resolves to local LM Studio. */
  vision?: boolean;
  /** The run will use the cloud filesystem tool loop, so the model
   * must be able to emit tool calls. Applied to cloud candidates only — a
   * local run uses LM Studio's external-MCP loop and is not gated. Without
   * this, a pin or dynamic pick can land on a model that silently ignores
   * `tools` and answers from nothing. */
  needsTools?: boolean;
}

/** Enabled + has at least one usable (non-exhausted) key for a provider. */
function providerUsable(deps: ToolDeps, profile: Profile, provider: ProviderKind): boolean {
  if (provider === "local") return true;
  if (profile.providers?.[provider]?.enabled === false) return false;
  return new ProviderKeyStore(deps.db).availableKeys(profile.name, provider).length > 0;
}

/** Cloud model is usable: registered in the provider catalog AND provider has a usable key. */
function cloudModelUsable(
  deps: ToolDeps,
  profile: Profile,
  provider: ProviderKind,
  modelId: string,
): boolean {
  if (!providerUsable(deps, profile, provider)) return false;
  const models = new ProviderModelStore(deps.db).listModels(profile.name, provider, true);
  return models.some((m) => m.model_id === modelId);
}

/** Every cloud provider that has this model id registered, in catalog order.
 *  More than one means the id is genuinely ambiguous across providers, which
 *  is exactly why the caller has to name the provider rather than guess. */
function providersWithModel(deps: ToolDeps, profileName: string, modelId: string): ProviderKind[] {
  const store = new ProviderModelStore(deps.db);
  return PROVIDER_KINDS.filter(
    (p): p is Exclude<ProviderKind, "local"> =>
      p !== "local" && store.listModels(profileName, p, true).some((m) => m.model_id === modelId),
  );
}

/** The run shape that makes a non-tool-capable cloud pin a liability: this
 * profile can run the cloud fs tool loop, which `runSubAgent` turns into
 * `needsTools` on the resolve call. Kept in step with that derivation — a
 * `tools.enabled` grant without an `fs` grant never sets `needsTools`, so a pin
 * to a non-tool-capable model is harmless there and is not reported stale. */
function profileRunsCloudTools(profile: Profile): boolean {
  return profile.tools?.enabled === true && profile.tools?.fs != null;
}

export interface StalePinReport {
  stale: boolean;
  /** Why, when stale — the same condition the gate acts on at run time. */
  reason: string | null;
}

/**
 * Whether the capability gate would reroute a tool-bearing run away from this
 * pin, computed from live data. The gate's `note` tells one run;
 * this is what makes the condition visible on read instead of mid-run.
 *
 * A pin unknown to the registry is NOT stale here: `cloudModelUsable` already
 * fails it and resolution falls back with its own "unavailable" note. Stale
 * means precisely "registered, but cannot do what this profile's runs ask for".
 */
export function stalePin(deps: ToolDeps, profile: Profile, pin: RolePin): StalePinReport {
  if (!profileRunsCloudTools(profile)) return { stale: false, reason: null };
  const provider = pin.provider as ProviderKind;
  if (provider === "local") return { stale: false, reason: null };
  if (!cloudModelUsable(deps, profile, provider, pin.model_id)) return { stale: false, reason: null };
  if (cloudModelToolCapable(deps, profile, provider, pin.model_id)) return { stale: false, reason: null };
  return {
    stale: true,
    reason: `${pin.model_id} cannot call tools — every tool-bearing run on this profile reroutes away from it.`,
  };
}

/** The registered model can emit tool calls. Unregistered/unknown = false —
 * a capability we cannot confirm is not one we may rely on. */
function cloudModelToolCapable(
  deps: ToolDeps,
  profile: Profile,
  provider: ProviderKind,
  modelId: string,
): boolean {
  const model = new ProviderModelStore(deps.db).getModel(profile.name, provider, modelId);
  return model?.capabilities?.function_calling === true;
}

/** Best registered model on a provider satisfying `capable`: performance_score
 * desc (untested rows default 50), then model_id for determinism. Null when none. */
function bestRegisteredModel(
  deps: ToolDeps,
  profile: Profile,
  provider: ProviderKind,
  capable: (caps: ProviderCapabilities | undefined) => boolean,
): string | null {
  const models = new ProviderModelStore(deps.db)
    .listModels(profile.name, provider, true)
    .filter((m) => capable(m.capabilities));
  if (models.length === 0) return null;
  models.sort(
    (a, b) =>
      (deps.registry.get(profile.name, b.model_id, provider)?.performance_score ?? -1) -
        (deps.registry.get(profile.name, a.model_id, provider)?.performance_score ?? -1) ||
      a.model_id.localeCompare(b.model_id),
  );
  return models[0]!.model_id;
}

function isToolCapable(caps: ProviderCapabilities | undefined): boolean {
  return caps?.function_calling === true;
}

function isVisionCapable(caps: ProviderCapabilities | undefined): boolean {
  return caps?.vision === true;
}

/** Vision candidates, narrowed to tool-capable ones when the run uses the cloud
 * fs tool loop — a vision model that ignores `tools` cannot read the images it
 * was handed a path to. */
function visionCapable(deps: ToolDeps, profile: Profile, provider: ProviderKind, needsTools: boolean): string | null {
  return bestRegisteredModel(
    deps,
    profile,
    provider,
    needsTools ? (c) => isVisionCapable(c) && isToolCapable(c) : isVisionCapable,
  );
}

/**
 * Vision delegation resolution. Always cloud — local
 * LM Studio never takes image input. Explicit model wins (provider must be a
 * cloud kind); else the `vision` role pin; else the best registered
 * vision-capable model across enabled providers in preference order.
 */
function resolveVisionModel(
  deps: ToolDeps,
  profile: Profile,
  input: ResolveInput,
): ResolvedRoleModel {
  if (input.explicitProvider === "local") {
    throw new NanitesError({
      code: "vision_local_not_supported",
      message: "Vision delegation is cloud-only — local LM Studio models do not take image input.",
      retryable: false,
    });
  }
  if (input.explicitModel) {
    if (!input.explicitProvider) {
      throw new NanitesError({
        code: "vision_requires_cloud_provider",
        message: `Explicit vision model ${input.explicitModel} needs an explicit cloud provider — image runs never default to local.`,
        retryable: false,
      });
    }
    return {
      provider: input.explicitProvider,
      model_id: input.explicitModel,
      source: "explicit",
      note: `vision explicit model ${input.explicitModel} on ${input.explicitProvider}.`,
    };
  }

  const needsTools = input.needsTools === true;
  const pins = new RolePinStore(deps.db);
  const pin = pins.get(profile.name, "vision");
  if (pin && pin.provider !== "local") {
    const prov = pin.provider as ProviderKind;
    if (cloudModelUsable(deps, profile, prov, pin.model_id)) {
      if (needsTools && !cloudModelToolCapable(deps, profile, prov, pin.model_id)) {
        return toolCapableOrThrow(
          deps, profile, prov, `vision pin ${pin.model_id}`, (c) => isVisionCapable(c), pin,
        );
      }
      return {
        provider: prov,
        model_id: pin.model_id,
        source: "pin",
        note: `vision pin auto-routes ${prov}: ${pin.model_id}.`,
      };
    }
    if (providerUsable(deps, profile, prov)) {
      const fallback = visionCapable(deps, profile, prov, needsTools);
      if (fallback) {
        return {
          provider: prov,
          model_id: fallback,
          source: "pin_fallback_dynamic",
          note: `vision pin ${pin.model_id} unavailable — fell back to registered vision ${fallback} on ${prov}.`,
        };
      }
    }
  }

  for (const provider of profile.provider_preference_order) {
    if (provider === "local") continue;
    if (!providerUsable(deps, profile, provider)) continue;
    const best = visionCapable(deps, profile, provider, needsTools);
    if (best) {
      return {
        provider,
        model_id: best,
        source: "dynamic_cloud",
        note: `no usable vision pin — auto-picked registered vision ${best} on ${provider}.`,
      };
    }
  }

  if (needsTools) {
    return toolCapableOrThrow(deps, profile, profile.provider_preference_order.find((p) => p !== "local") ?? "cloudflare", "vision dynamic selection", (c) => isVisionCapable(c));
  }
  throw new NanitesError({
    code: "no_vision_model_registered",
    message:
      "No registered vision-capable cloud model with a usable key on any enabled provider. Seed the Cloudflare agentic fleet or register one.",
    retryable: false,
  });
}

/** Local pin is usable: the model has a local registry entry. Local rows are
 *  the provider IS NULL ones, so the two-argument get() is exactly right here. */
function localModelUsable(deps: ToolDeps, profile: Profile, modelId: string): boolean {
  return deps.registry.get(profile.name, modelId) !== null;
}

/**
 * A tool-using run landed on a cloud model that cannot call tools. Rather than
 * let it answer from nothing — the failure mode the model-policy review ranks
 * second — pick
 * the best registered tool-capable model on that provider, or refuse loudly.
 * `origin` names the model and how it was chosen, for the error and the note.
 */
function toolCapableOrThrow(
  deps: ToolDeps,
  profile: Profile,
  provider: ProviderKind,
  origin: string,
  /** Extra capability the replacement must also carry — a vision run may only
   * reroute to a model that sees images as well as calls tools. */
  also?: (caps: ProviderCapabilities | undefined) => boolean,
  /** The pin this reroute is abandoning, when the reroute came from a pin
   * rather than from dynamic selection. Recording it on the pin is what turns a
   * one-run `note` into something the pin listing reports on read. */
  mismatchedPin?: Pick<RolePin, "role" | "model_id">,
): ResolvedRoleModel {
  if (mismatchedPin) {
    new RolePinStore(deps.db).markCapabilityMismatch(
      profile.name,
      mismatchedPin.role,
      `${mismatchedPin.model_id} cannot call tools — rerouted on a tool-bearing run.`,
    );
  }
  const fallback = bestRegisteredModel(deps, profile, provider, (c) =>
    isToolCapable(c) && (also ? also(c) : true),
  );
  if (!fallback) {
    const kind = also ? "tool-capable vision" : "tool-capable";
    throw new NanitesError({
      code: "no_tool_capable_model",
      message:
        `This run needs a model that can emit tool calls, but ${origin} cannot, and no ${kind} ` +
        `model is registered on ${provider}. Register one (the Cloudflare agentic fleet has several) ` +
        `or run without a filesystem grant.`,
      retryable: false,
      details: { provider, rejected: origin },
    });
  }
  return {
    provider,
    model_id: fallback,
    source: "pin_fallback_dynamic",
    note: `${origin} cannot call tools — rerouted to tool-capable ${fallback} on ${provider}.`,
  };
}

function bestCrossEndpoint(
  deps: ToolDeps,
  profile: Profile,
  origin: ProviderKind,
): ResolvedRoleModel {
  for (const provider of profile.provider_preference_order) {
    if (provider === "local") continue; // cloud outage never silently redirects to local
    if (provider === origin) continue; // we are already failing on this one
    if (profile.providers?.[provider]?.enabled === false) continue;
    const keys = new ProviderKeyStore(deps.db).availableKeys(profile.name, provider);
    if (keys.length === 0) continue;
    const registered = new ProviderModelStore(deps.db).listModels(profile.name, provider, true);
    if (registered.length === 0) continue;
    return {
      provider,
      model_id: null,
      source: "cross_endpoint",
      note: `crossed to ${provider} — ${origin} had no enabled/unexhausted key or registered model (full outage).`,
    };
  }
  throw new NanitesError({
    code: "no_model_for_role",
    message:
      `No usable model for roles across any enabled provider: ${origin} is out and no other provider has a registered model with a usable key.`,
    retryable: false,
  });
}

/**
 * Resolve which provider/model a sub-agent run should use. Pure decision —
 * never calls a provider; only reads registry/key/model/pin stores.
 */
export function resolveRoleModel(
  deps: ToolDeps,
  profile: Profile,
  input: ResolveInput,
): ResolvedRoleModel {
  // Vision runs skip the normal pin ladder entirely — they must land on a
  // registered vision-capable cloud model, never a local one.
  if (input.vision === true) return resolveVisionModel(deps, profile, input);

  const roles = input.roles && input.roles.length > 0 ? input.roles : input.brief ? rolesFromBrief(input.brief) : [];
  const explicitProvider = input.explicitProvider;

  // 1. Orchestrator explicit args beat pins.
  if (input.explicitModel) {
    if (explicitProvider && explicitProvider !== "local") {
      return {
        provider: explicitProvider,
        model_id: input.explicitModel,
        source: "explicit",
        note: `explicit model ${input.explicitModel} on ${explicitProvider}.`,
      };
    }
    // No provider with a model id: a registered cloud model would be sent to
    // LM Studio, which 404s with "not found in downloaded models" — an error
    // indistinguishable from a typo. Name the provider instead.
    if (!explicitProvider) {
      const cloud = providersWithModel(deps, profile.name, input.explicitModel);
      if (cloud.length === 1) {
        throw new NanitesError({
          code: "cloud_provider_required",
          message:
            `"${input.explicitModel}" is a ${cloud[0]} model, not a local one. ` +
            `Pass provider: "${cloud[0]}" to route it to the cloud.`,
          retryable: false,
          details: { model_id: input.explicitModel, providers: cloud },
        });
      }
      if (cloud.length > 1) {
        throw new NanitesError({
          code: "cloud_provider_required",
          message:
            `"${input.explicitModel}" is registered on ${cloud.length} providers ` +
            `(${cloud.join(", ")}). Pass provider: "<one of them>" to choose.`,
          retryable: false,
          details: { model_id: input.explicitModel, providers: cloud },
        });
      }
    }
    return {
      provider: "local",
      model_id: input.explicitModel,
      source: "explicit",
      note: `explicit local model ${input.explicitModel}.`,
    };
  }

  // Explicit provider only: dynamic within that provider unless a matching pin
  // on the same provider exists and is usable.
  if (explicitProvider && explicitProvider !== "local") {
    const pin = firstPinForRoles(deps, profile.name, roles);
    if (pin && pin.provider === explicitProvider && cloudModelUsable(deps, profile, pin.provider, pin.model_id)) {
      return {
        provider: explicitProvider,
        model_id: pin.model_id,
        source: "pin",
        note: `pin for ${pin.role} honored on ${explicitProvider}: ${pin.model_id}.`,
      };
    }
    if (pin && pin.provider === explicitProvider) {
      return {
        provider: explicitProvider,
        model_id: null,
        source: "pin_fallback_dynamic",
        note: `pin ${pin.model_id} for ${pin.role} unavailable (not registered or no key) — falling back to dynamic on ${explicitProvider}.`,
      };
    }
    if (!providerUsable(deps, profile, explicitProvider)) {
      const cross = bestCrossEndpoint(deps, profile, explicitProvider);
      return cross;
    }
    if (input.needsTools) {
      // Pick a tool-capable model directly; only reroute (via toolCapableOrThrow,
      // which also refuses loudly) when none qualifies — keeping the happy-path
      // note clean so a capable dynamic pick is not reported as a reroute
      //.
      const capable = bestRegisteredModel(deps, profile, explicitProvider, isToolCapable);
      if (capable) {
        return {
          provider: explicitProvider,
          model_id: capable,
          source: "dynamic_cloud",
          note: `dynamic tool-capable selection on ${explicitProvider}: ${capable}.`,
        };
      }
      return toolCapableOrThrow(deps, profile, explicitProvider, `dynamic selection on ${explicitProvider}`);
    }
    return {
      provider: explicitProvider,
      model_id: null,
      source: "dynamic_cloud",
      note: `no matching pin on ${explicitProvider}; router selects dynamic.`,
    };
  }
  if (explicitProvider === "local") {
    return { provider: "local", model_id: null, source: "dynamic_local" };
  }

  // 2. No explicit args: honor a role pin, auto-routing to its provider.
  const pin = firstPinForRoles(deps, profile.name, roles);
  if (pin) {
    if (pin.provider === "local") {
      if (localModelUsable(deps, profile, pin.model_id)) {
        return {
          provider: "local",
          model_id: pin.model_id,
          source: "pin",
          note: `pin for ${pin.role} auto-routes local: ${pin.model_id}.`,
        };
      }
      return {
        provider: "local",
        model_id: null,
        source: "pin_fallback_dynamic",
        note: `local pin ${pin.model_id} for ${pin.role} has no registry entry — falling back to dynamic local selection.`,
      };
    }
    if (cloudModelUsable(deps, profile, pin.provider, pin.model_id)) {
      // The pin wins unless this run needs tools the pinned model cannot call.
      if (input.needsTools && !cloudModelToolCapable(deps, profile, pin.provider, pin.model_id)) {
        return toolCapableOrThrow(
          deps, profile, pin.provider, `pin ${pin.model_id} for ${pin.role}`, undefined, pin,
        );
      }
      return {
        provider: pin.provider,
        model_id: pin.model_id,
        source: "pin",
        note: `pin for ${pin.role} auto-routes ${pin.provider}: ${pin.model_id}.`,
      };
    }
    if (providerUsable(deps, profile, pin.provider)) {
      if (input.needsTools) {
        return toolCapableOrThrow(
          deps, profile, pin.provider, `pin ${pin.model_id} for ${pin.role}`, undefined, pin,
        );
      }
      return {
        provider: pin.provider,
        model_id: null,
        source: "pin_fallback_dynamic",
        note: `pin ${pin.model_id} for ${pin.role} unavailable on ${pin.provider} — falling back to dynamic within ${pin.provider}.`,
      };
    }
    return bestCrossEndpoint(deps, profile, pin.provider);
  }

  // 3. No pin: byte-identical to pre-sprint behavior (provider absent = local).
  if (explicitProvider === "local") return { provider: "local", model_id: null, source: "dynamic_local" };
  return {
    provider: "local",
    model_id: null,
    source: "dynamic_local",
    note: roles.length > 0 ? undefined : "no roles matched — local dynamic selection.",
  };
}

function firstPinForRoles(
  deps: ToolDeps,
  profileName: string,
  roles: string[],
): ({ provider: ProviderKind; model_id: string; role: string }) | null {
  const store = new RolePinStore(deps.db);
  for (const role of roles) {
    const pin = store.get(profileName, role);
    if (pin) {
      // RolePin.provider is validated against PIN_PROVIDERS at write time; the
      // enum is exactly ProviderKind, so assert the storage-agnostic string up.
      return { role, provider: pin.provider as ProviderKind, model_id: pin.model_id };
    }
  }
  return null;
}
