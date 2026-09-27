/**
 * Phase 51 gate — capability gating and model policy.
 *
 * Root cause this closes: a cloud run with a
 * filesystem grant could resolve to a model that cannot emit tool calls, which
 * then answered from nothing while the run reported success.
 *
 * Covers:
 * 1. Tool-capable gating on the pin ladder — a non-tool-capable pin reroutes to
 *    the best tool-capable model, and refuses loudly when nothing qualifies.
 * 2. The gate is scoped to runs that need it: a run without a filesystem grant
 *    still honors a non-tool-capable pin unchanged.
 * 3. The same gate on the vision path, which carried the identical hole: a
 *    vision run using the fs tool loop may only land on a model that both sees
 *    images and calls tools.
 * 4. Manifest corrections proven against the live API in C5 — qwq-32b carries
 *    function_calling, the deepseek distill does not — and the corrected default
 *    pins write once and survive a re-seed.
 */
import { describe, expect, it } from "vitest";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { ProviderKeyStore } from "../../src/storage/providerKeyStore.js";
import { ProviderModelStore } from "../../src/storage/providerModelStore.js";
import { RolePinStore } from "../../src/storage/rolePinStore.js";
import { resolveRoleModel } from "../../src/workflows/resolveRoleModel.js";
import { seedProviderModels } from "../../src/workflows/seedProviderModels.js";
import {
  CLOUDFLARE_DEFAULT_PINS,
  CLOUDFLARE_AGENT_MANIFEST,
} from "../../src/seed/cloudflareAgentManifest.js";
import { scratchHome } from "../phase3/helpers.js";

const CF = "cloudflare";
const NO_TOOL = "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b";
const TOOL_MODEL = "@cf/ibm-granite/granite-4.0-h-micro";
const NON_FC_VISION = "@cf/meta/llama-3.2-11b-vision-instruct";
const FC_VISION = "@cf/google/gemma-4-26b-a4b-it";

function harness(name: string): ToolDeps {
  const d = buildDeps(scratchHome());
  d.profiles.createProfile({ name });
  d.profiles.switchProfile(name);
  new ProviderKeyStore(d.db).addKey(name, CF, "sk-test-key");
  return d;
}

function register(
  d: ToolDeps,
  profile: string,
  modelId: string,
  caps: { vision: boolean; function_calling: boolean },
  perf?: number,
): void {
  new ProviderModelStore(d.db).registerManifestModel(profile, CF, {
    model_id: modelId,
    context_length: null,
    vision: caps.vision,
    function_calling: caps.function_calling,
  });
  d.registry.upsert(profile, {
    model_id: modelId,
    provider: CF,
    roles: [],
    scores: {},
    last_tested: null,
    ...(perf !== undefined ? { performance_score: perf } : {}),
  });
}

function pin(d: ToolDeps, profile: string, role: string, modelId: string): void {
  new RolePinStore(d.db).set(profile, { role, provider: CF, model_id: modelId });
}

function codeOf(fn: () => unknown): { code: string; details: Record<string, unknown> } {
  try {
    fn();
  } catch (err) {
    const e = err as { code?: string; details?: Record<string, unknown> };
    return { code: String(e.code), details: e.details ?? {} };
  }
  throw new Error("expected a throw");
}

describe("phase51 — tool-capable gating on the pin ladder", () => {
  it("reroutes a non-tool-capable pin to the best tool-capable model", () => {
    const d = harness("ph51-reroute");
    register(d, "ph51-reroute", NO_TOOL, { vision: false, function_calling: false });
    register(d, "ph51-reroute", TOOL_MODEL, { vision: false, function_calling: true });
    pin(d, "ph51-reroute", "extractor", NO_TOOL);

    const r = resolveRoleModel(d, d.profiles.getProfile("ph51-reroute")!, {
      roles: ["extractor"],
      needsTools: true,
    });

    expect(r.model_id).toBe(TOOL_MODEL);
    expect(r.provider).toBe(CF);
    expect(r.source).toBe("pin_fallback_dynamic");
    expect(r.note).toContain("cannot call tools");
  });

  it("refuses with no_tool_capable_model when nothing on the provider can call tools", () => {
    const d = harness("ph51-refuse");
    register(d, "ph51-refuse", NO_TOOL, { vision: false, function_calling: false });
    pin(d, "ph51-refuse", "extractor", NO_TOOL);

    const { code, details } = codeOf(() =>
      resolveRoleModel(d, d.profiles.getProfile("ph51-refuse")!, { roles: ["extractor"], needsTools: true }),
    );

    expect(code).toBe("no_tool_capable_model");
    expect(details.provider).toBe(CF);
    expect(String(details.rejected)).toContain(NO_TOOL);
  });

  it("honors a non-tool-capable pin unchanged when the run needs no tools", () => {
    const d = harness("ph51-nogate");
    register(d, "ph51-nogate", NO_TOOL, { vision: false, function_calling: false });
    register(d, "ph51-nogate", TOOL_MODEL, { vision: false, function_calling: true });
    pin(d, "ph51-nogate", "extractor", NO_TOOL);

    const r = resolveRoleModel(d, d.profiles.getProfile("ph51-nogate")!, { roles: ["extractor"] });

    expect(r.model_id).toBe(NO_TOOL);
    expect(r.source).toBe("pin");
  });

  it("gates dynamic selection on an explicit provider too", () => {
    const d = harness("ph51-explicit");
    register(d, "ph51-explicit", TOOL_MODEL, { vision: false, function_calling: true });

    const r = resolveRoleModel(d, d.profiles.getProfile("ph51-explicit")!, {
      roles: ["reviewer"],
      explicitProvider: CF,
      needsTools: true,
    });

    expect(r.model_id).toBe(TOOL_MODEL);
    expect(r.source).toBe("dynamic_cloud");
    expect(r.note).not.toMatch(/rerouted|rout/i);
  });
});

describe("phase51 — the same gate on the vision path", () => {
  it("does not select a non-tool-capable vision model for a vision-plus-tools run", () => {
    const d = harness("ph51-vision-tools");
    register(d, "ph51-vision-tools", NON_FC_VISION, { vision: true, function_calling: false });
    register(d, "ph51-vision-tools", FC_VISION, { vision: true, function_calling: true });

    const r = resolveRoleModel(d, d.profiles.getProfile("ph51-vision-tools")!, {
      vision: true,
      needsTools: true,
    });

    expect(r.model_id).toBe(FC_VISION);
    expect(r.provider).toBe(CF);
  });

  it("still resolves a plain vision run to a vision model that cannot call tools", () => {
    const d = harness("ph51-vision-plain");
    register(d, "ph51-vision-plain", NON_FC_VISION, { vision: true, function_calling: false });

    const r = resolveRoleModel(d, d.profiles.getProfile("ph51-vision-plain")!, { vision: true });

    expect(r.model_id).toBe(NON_FC_VISION);
  });

  it("reroutes a non-tool-capable vision pin when the run needs tools", () => {
    const d = harness("ph51-vision-pin");
    register(d, "ph51-vision-pin", NON_FC_VISION, { vision: true, function_calling: false });
    register(d, "ph51-vision-pin", FC_VISION, { vision: true, function_calling: true });
    pin(d, "ph51-vision-pin", "vision", NON_FC_VISION);

    const r = resolveRoleModel(d, d.profiles.getProfile("ph51-vision-pin")!, {
      vision: true,
      needsTools: true,
    });

    expect(r.model_id).toBe(FC_VISION);
    expect(r.note).toContain("cannot call tools");
  });

  it("refuses a vision-plus-tools run when no vision model can call tools", () => {
    const d = harness("ph51-vision-refuse");
    register(d, "ph51-vision-refuse", NON_FC_VISION, { vision: true, function_calling: false });

    const { code } = codeOf(() =>
      resolveRoleModel(d, d.profiles.getProfile("ph51-vision-refuse")!, { vision: true, needsTools: true }),
    );

    expect(code).toBe("no_tool_capable_model");
  });
});

describe("phase51 — manifest corrections and seeding", () => {
  it("marks qwq-32b tool-capable and leaves the deepseek distill uncapable", () => {
    const byId = new Map(CLOUDFLARE_AGENT_MANIFEST.map((m) => [m.model_id, m]));
    // Corrected in C5 after 2/2 live runs returned real tool_calls.
    expect(byId.get("@cf/qwen/qwq-32b")?.function_calling).toBe(true);
    // Confirmed non-calling live (0/2, answered in prose) — flag stands.
    expect(byId.get(NO_TOOL)?.function_calling).toBe(false);
  });

  it("pins every default role to a tool-capable model", () => {
    const byId = new Map(CLOUDFLARE_AGENT_MANIFEST.map((m) => [m.model_id, m]));
    for (const p of CLOUDFLARE_DEFAULT_PINS) {
      const seed = byId.get(p.model_id);
      expect(seed, `${p.role} pins unknown model ${p.model_id}`).toBeDefined();
      expect(seed!.function_calling, `${p.role} pins non-tool-capable ${p.model_id}`).toBe(true);
    }
  });

  it("writes the corrected pins once and preserves them on a re-seed", () => {
    const d = harness("ph51-seed");
    const first = seedProviderModels(d, { profile: "ph51-seed" });
    const written = new Map(first.default_pins_written.map((p) => [p.role, p.model_id]));
    expect(written.get("extractor")).toBe("@cf/qwen/qwen3-30b-a3b-fp8");
    expect(written.get("classifier")).toBe("@cf/ibm-granite/granite-4.0-h-micro");

    const second = seedProviderModels(d, { profile: "ph51-seed" });
    expect(second.default_pins_written).toEqual([]);
    expect(second.default_pins_preserved.length).toBe(first.default_pins_written.length);

    const pins = new RolePinStore(d.db).get("ph51-seed", "extractor");
    expect(pins?.model_id).toBe("@cf/qwen/qwen3-30b-a3b-fp8");

    const qwq = new ProviderModelStore(d.db).getModel("ph51-seed", CF, "@cf/qwen/qwq-32b");
    expect(qwq?.capabilities.function_calling).toBe(true);
  });
});
