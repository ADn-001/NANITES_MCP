/**
 * Phase 42 gate — pin-aware resolution.
 * Pure decision function `resolveRoleModel` never touches a provider or LM
 * Studio — only reads the registry / key / model / pin stores. So the whole
 * gate runs on scratch homes with real stores and zero network.
 * Covers:
 * 1. No args, no pin → byte-identical default: local dynamic.
 * 2. Explicit model/provider beat pins (source "explicit").
 * 3. A role pin auto-routes to its provider (local or cloud).
 * 4. Unavailable pin → within-provider dynamic (pin_fallback_dynamic, null model).
 * 5. Full provider outage → cross_endpoint to the next enabled provider.
 * 6. Everything exhausted → structured no_model_for_role error.
 * 7. Pin matched in requested-role order (first role with a pin wins).
 */
import { afterAll, describe, expect, it } from "vitest";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { RolePinStore } from "../../src/storage/rolePinStore.js";
import { ProviderKeyStore } from "../../src/storage/providerKeyStore.js";
import { ProviderModelStore } from "../../src/storage/providerModelStore.js";
import type { Profile } from "../../src/storage/profileDefaults.js";
import { resolveRoleModel, type ResolvedRoleModel } from "../../src/workflows/resolveRoleModel.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

const homes: ToolDeps[] = [];

function harness(profileName: string, providerPrefs?: Profile["providers"]): { d: ToolDeps; profile: Profile } {
  const d = buildDeps(scratchHome());
  homes.push(d);
  d.profiles.createProfile({ name: profileName, providers: providerPrefs ?? {} });
  const profile = d.profiles.getProfile(profileName);
  if (!profile) throw new Error("fixture profile missing");
  return { d, profile };
}

function addKey(d: ToolDeps, profile: string, provider: "cloudflare" | "openrouter", enabled = true): void {
  const store = new ProviderKeyStore(d.db);
  const id = store.addKey(profile, provider, `sk-test-${profile}-${provider}-${Math.random().toString(36).slice(2)}`);
  if (!enabled) store.setEnabled(profile, provider, id, false);
}

function addModel(d: ToolDeps, profile: string, provider: "cloudflare" | "openrouter", modelId: string): void {
  new ProviderModelStore(d.db).registerModel(profile, provider, modelId);
}

function addLocal(d: ToolDeps, profile: string, modelId: string): void {
  d.registry.upsert(profile, { model_id: modelId, roles: ["code_writer"], scores: { code_writer: 80 }, best_params: {} });
}

function pin(d: ToolDeps, profile: string, role: string, provider: string, modelId: string): void {
  new RolePinStore(d.db).set(profile, { role, provider, model_id: modelId });
}

function resolve(d: ToolDeps, profile: Profile, input?: Parameters<typeof resolveRoleModel>[2]): ResolvedRoleModel {
  return resolveRoleModel(d, profile, input ?? {});
}

afterAll(() => {
  for (const d of homes.splice(0)) {
    d.close();
    cleanup(d.home);
  }
});

describe("default + explicit precedence", () => {
  it("no args, no pin → local dynamic (pre-sprint default)", () => {
    const { d, profile } = harness("p-def");
    expect(resolve(d, profile)).toMatchObject({ provider: "local", model_id: null, source: "dynamic_local" });
  });

  it("explicit model with no provider → explicit local model", () => {
    const { d, profile } = harness("p-exp-local");
    expect(resolve(d, profile, { explicitModel: "local-llama" })).toMatchObject({
      provider: "local",
      model_id: "local-llama",
      source: "explicit",
    });
  });

  it("explicit model + provider → explicit cloud run", () => {
    const { d, profile } = harness("p-exp-cf");
    expect(resolve(d, profile, { explicitProvider: "cloudflare", explicitModel: "@cf/openai/gpt-oss-120b" })).toMatchObject({
      provider: "cloudflare",
      model_id: "@cf/openai/gpt-oss-120b",
      source: "explicit",
    });
  });

  it("explicit provider suppresses a pin on another provider → dynamic within the explicit one", () => {
    const { d, profile } = harness("p-exp-over");
    addLocal(d, "p-exp-over", "local-llama");
    pin(d, "p-exp-over", "code_writer", "local", "local-llama");
    addKey(d, "p-exp-over", "cloudflare");
    const r = resolve(d, profile, { explicitProvider: "cloudflare" });
    expect(r.provider).toBe("cloudflare");
    expect(r.model_id).toBeNull();
    expect(r.source).toBe("dynamic_cloud");
  });
});

describe("pins honored", () => {
  it("local pin registered in registry → pinned local model", () => {
    const { d, profile } = harness("p-pin-local");
    addLocal(d, "p-pin-local", "local-llama");
    pin(d, "p-pin-local", "code_writer", "local", "local-llama");
    expect(resolve(d, profile, { roles: ["code_writer"] })).toMatchObject({
      provider: "local",
      model_id: "local-llama",
      source: "pin",
    });
  });

  it("local pin with no registry entry → dynamic local fallback", () => {
    const { d, profile } = harness("p-pin-local-miss");
    pin(d, "p-pin-local-miss", "code_writer", "local", "ghost");
    const r = resolve(d, profile, { roles: ["code_writer"] });
    expect(r).toMatchObject({ provider: "local", model_id: null, source: "pin_fallback_dynamic" });
    expect(r.note).toMatch(/no registry entry/);
  });

  it("cloud pin usable (key + registered) → auto-routes to cloudflare", () => {
    const { d, profile } = harness("p-pin-cf");
    addKey(d, "p-pin-cf", "cloudflare");
    addModel(d, "p-pin-cf", "cloudflare", "@cf/google/gemma-4-26b-a4b-it");
    pin(d, "p-pin-cf", "vision", "cloudflare", "@cf/google/gemma-4-26b-a4b-it");
    expect(resolve(d, profile, { roles: ["vision"] })).toMatchObject({
      provider: "cloudflare",
      model_id: "@cf/google/gemma-4-26b-a4b-it",
      source: "pin",
    });
  });

  it("brief keywords auto-route through the vision pin when roles are omitted", () => {
    const { d, profile } = harness("p-pin-vision-brief");
    addKey(d, "p-pin-vision-brief", "cloudflare");
    addModel(d, "p-pin-vision-brief", "cloudflare", "@cf/google/gemma-4-26b-a4b-it");
    pin(d, "p-pin-vision-brief", "vision", "cloudflare", "@cf/google/gemma-4-26b-a4b-it");
    const r = resolve(d, profile, { brief: "describe this image for me" });
    expect(r.provider).toBe("cloudflare");
    expect(r.model_id).toBe("@cf/google/gemma-4-26b-a4b-it");
    expect(r.source).toBe("pin");
  });

  it("first requested role with a pin wins (order matters)", () => {
    const { d, profile } = harness("p-pin-order");
    addKey(d, "p-pin-order", "cloudflare");
    addModel(d, "p-pin-order", "cloudflare", "@cf/code-m");
    addModel(d, "p-pin-order", "cloudflare", "@cf/doc-m");
    pin(d, "p-pin-order", "code_writer", "cloudflare", "@cf/code-m");
    pin(d, "p-pin-order", "doc_writer", "cloudflare", "@cf/doc-m");
    // code_writer first → its pin routes, doc_writer's pin is not consulted.
    expect(resolve(d, profile, { roles: ["code_writer", "doc_writer"] }).model_id).toBe("@cf/code-m");
    expect(resolve(d, profile, { roles: ["doc_writer", "code_writer"] }).model_id).toBe("@cf/doc-m");
  });

  it("explicit provider + usable pin on that provider → pin honored", () => {
    const { d, profile } = harness("p-pin-explicit-match");
    addKey(d, "p-pin-explicit-match", "cloudflare");
    addModel(d, "p-pin-explicit-match", "cloudflare", "@cf/openai/gpt-oss-120b");
    pin(d, "p-pin-explicit-match", "code_writer", "cloudflare", "@cf/openai/gpt-oss-120b");
    expect(
      resolve(d, profile, { explicitProvider: "cloudflare", roles: ["code_writer"] }),
    ).toMatchObject({ provider: "cloudflare", model_id: "@cf/openai/gpt-oss-120b", source: "pin" });
  });
});

describe("fallback ladder", () => {
  it("cloud pin with key but unregistered model → dynamic within the pinned provider", () => {
    const { d, profile } = harness("p-fb-unregistered");
    addKey(d, "p-fb-unregistered", "cloudflare");
    pin(d, "p-fb-unregistered", "vision", "cloudflare", "@cf/not-registered");
    const r = resolve(d, profile, { roles: ["vision"] });
    expect(r).toMatchObject({ provider: "cloudflare", model_id: null, source: "pin_fallback_dynamic" });
    expect(r.note).toMatch(/unavailable on cloudflare/);
  });

  it("pin provider with no key + a later provider healthy → cross_endpoint", () => {
    const { d, profile } = harness("p-fb-cross");
    // cloudflare pin exists but cloudflare has no usable key; openrouter does.
    pin(d, "p-fb-cross", "vision", "cloudflare", "@cf/google/gemma-4-26b-a4b-it");
    addKey(d, "p-fb-cross", "openrouter");
    addModel(d, "p-fb-cross", "openrouter", "openai/gpt-4o-mini");
    const r = resolve(d, profile, { roles: ["vision"] });
    expect(r.provider).toBe("openrouter");
    expect(r.model_id).toBeNull();
    expect(r.source).toBe("cross_endpoint");
    expect(r.note).toMatch(/crossed to openrouter/);
  });

  it("explicit provider with no key + a later provider healthy → cross_endpoint", () => {
    const { d, profile } = harness("p-fb-cross-exp");
    addKey(d, "p-fb-cross-exp", "openrouter");
    addModel(d, "p-fb-cross-exp", "openrouter", "anthropic/claude-haiku-4-5");
    const r = resolve(d, profile, { explicitProvider: "cloudflare" });
    expect(r.provider).toBe("openrouter");
    expect(r.source).toBe("cross_endpoint");
  });

  it("all providers exhausted → structured no_model_for_role", () => {
    const { d, profile } = harness("p-fb-none");
    addModel(d, "p-fb-none", "cloudflare", "@cf/openai/gpt-oss-120b"); // registered but no key anywhere
    pin(d, "p-fb-none", "code_writer", "cloudflare", "@cf/openai/gpt-oss-120b");
    let threw: unknown;
    try {
      resolve(d, profile, { roles: ["code_writer"] });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeTruthy();
    expect((threw as { code?: string }).code).toBe("no_model_for_role");
  });

  it("explicit provider disabled by pref → unusable, and local is never a silent cross target", () => {
    const { d, profile } = harness("p-fb-disabled", { cloudflare: { enabled: false } });
    addKey(d, "p-fb-disabled", "cloudflare"); // key exists but provider pref is off
    addLocal(d, "p-fb-disabled", "local-llama");
    let threw: unknown;
    try {
      resolve(d, profile, { explicitProvider: "cloudflare" });
    } catch (err) {
      threw = err;
    }
    // disabled cloudflare + no other cloud provider enabled: even though a local
    // registry model exists, resolution never redirects a cloud request to LM Studio.
    expect(threw).toBeTruthy();
    expect((threw as { code?: string }).code).toBe("no_model_for_role");
  });
});

describe("provider kinds", () => {
  it("explicit provider local → dynamic local, gate still applies downstream", () => {
    const { d, profile } = harness("p-kind-local");
    expect(resolve(d, profile, { explicitProvider: "local" })).toMatchObject({
      provider: "local",
      model_id: null,
      source: "dynamic_local",
    });
  });
});

/**
 * Found in a live run: run_sub_agent with a cloud model_id and no `provider`
 * sent the call to LM Studio, which 404'd with "not found in downloaded
 * models" — indistinguishable from a typo'd local model, even though the model
 * was registered and sitting in the profile. Resolution now names the provider.
 */
describe("an explicit cloud model id with no provider is refused clearly", () => {
  it("names the single provider that has the model", () => {
    const { d, profile } = harness("p-cloud-noprov");
    addKey(d, "p-cloud-noprov", "cloudflare");
    addModel(d, "p-cloud-noprov", "cloudflare", "@cf/meta/llama-3.2-3b-instruct");

    let err: unknown;
    try {
      resolveRoleModel(d, profile, { roles: [], brief: "hi", explicitModel: "@cf/meta/llama-3.2-3b-instruct" });
    } catch (e) { err = e; }
    expect(err, "expected a structured refusal, not a local dispatch").toBeDefined();
    const e = err as { code: string; message: string; details?: { providers?: string[] } };
    expect(e.code).toBe("cloud_provider_required");
    expect(e.message).toContain("cloudflare");
    expect(e.details?.providers).toEqual(["cloudflare"]);
  });

  it("lists every provider when the id is ambiguous across two", () => {
    const { d, profile } = harness("p-cloud-ambig");
    addKey(d, "p-cloud-ambig", "cloudflare");
    addKey(d, "p-cloud-ambig", "openrouter");
    addModel(d, "p-cloud-ambig", "cloudflare", "shared-id");
    addModel(d, "p-cloud-ambig", "openrouter", "shared-id");

    let err: unknown;
    try {
      resolveRoleModel(d, profile, { roles: [], brief: "hi", explicitModel: "shared-id" });
    } catch (e) { err = e; }
    const e = err as { code: string; details?: { providers?: string[] } };
    expect(e.code).toBe("cloud_provider_required");
    expect(e.details?.providers).toEqual(["cloudflare", "openrouter"]);
  });

  it("still routes when the provider IS given", () => {
    const { d, profile } = harness("p-cloud-given");
    addKey(d, "p-cloud-given", "cloudflare");
    addModel(d, "p-cloud-given", "cloudflare", "@cf/x/y");
    expect(resolveRoleModel(d, profile, {
      roles: [], brief: "hi", explicitModel: "@cf/x/y", explicitProvider: "cloudflare",
    })).toMatchObject({ provider: "cloudflare", model_id: "@cf/x/y", source: "explicit" });
  });

  it("still treats an unregistered id as local", () => {
    const { d, profile } = harness("p-local-unreg");
    // No keys, no registered cloud models: a genuinely local name must pass.
    expect(resolveRoleModel(d, profile, { roles: [], brief: "hi", explicitModel: "qwen3.5-0.8b" }))
      .toMatchObject({ provider: "local", model_id: "qwen3.5-0.8b", source: "explicit" });
  });
});
