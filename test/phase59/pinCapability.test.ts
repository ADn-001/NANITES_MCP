/**
 * Phase 59 gate — pin hygiene.
 *
 * Three claims, all against in-memory profiles (no live DB):
 *  1. Clearing a pin removes it from `list_role_pins` and the next resolution
 *     falls back to dynamic selection — no throw, no reroute warning.
 *  2. A pin whose model lacks the role's required capability resolves elsewhere
 *     and reports `stale: true` on read.
 *  3. A pin whose model has the capability is used verbatim and reports no
 *     warning.
 *
 * The cloud fs tool loop is enabled per-profile (`tools.fs`), not per-pin, so
 * `needsTools` is driven by the profile — matching `runSubAgent`'s derivation.
 */
import { describe, expect, it } from "vitest";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { ProviderKeyStore } from "../../src/storage/providerKeyStore.js";
import { ProviderModelStore } from "../../src/storage/providerModelStore.js";
import { RolePinStore } from "../../src/storage/rolePinStore.js";
import { listRolePins } from "../../src/workflows/seedProviderModels.js";
import { resolveRoleModel, type StalePinReport, stalePin } from "../../src/workflows/resolveRoleModel.js";
import { deleteRolePin, setRolePin } from "../../src/workflows/seedProviderModels.js";
import { scratchHome } from "../phase3/helpers.js";

const CF = "cloudflare";
const TOOL_MODEL = "@cf/ibm-granite/granite-4.0-h-micro";
const NO_TOOL = "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b";

function harness(name: string, toolsEnabled: boolean): ToolDeps {
  const d = buildDeps(scratchHome());
  d.profiles.createProfile({
    name,
    ...(toolsEnabled
      ? { tools: { enabled: true, integrations: [], fs: { root: process.cwd() } } }
      : {}),
  });
  d.profiles.switchProfile(name);
  new ProviderKeyStore(d.db).addKey(name, CF, "sk-test-key", { accountId: "acct-0" });
  return d;
}

function register(d: ToolDeps, profile: string, modelId: string, fc: boolean): void {
  new ProviderModelStore(d.db).registerManifestModel(profile, CF, {
    model_id: modelId, context_length: null, vision: false, function_calling: fc,
  });
  d.registry.upsert(profile, {
    model_id: modelId, provider: CF, roles: [], scores: {}, last_tested: null,
  });
}

describe("Phase 59 — pin clearing falls back to dynamic (no reroute)", () => {
  it("clearing a pin removes it from list and the next resolution falls back", () => {
    const d = harness("ph59-clear", true);
    const profile = d.profiles.getProfile("ph59-clear")!;
    register(d, "ph59-clear", TOOL_MODEL, true);
    setRolePin(d, { profile: "ph59-clear", role: "extractor", provider: CF as never, model_id: NO_TOOL });

    expect(deleteRolePin(d, "ph59-clear", "extractor").removed).toBe(true);

    const listed = listRolePins(d, "ph59-clear");
    expect(listed.pins.some((p) => p.role === "extractor")).toBe(false);

    const res = resolveRoleModel(d, profile, { roles: ["extractor"], needsTools: true });
    expect(res.source).not.toBe("pin_fallback_dynamic");
    expect(res.note ?? "").not.toMatch(/rerouted|rout/i);
    d.close();
  });
});

describe("Phase 59 — a capability-lacking pin is reported stale and rerouted", () => {
  it("stalePin reports the mismatch; list_role_pins carries stale:true", () => {
    const d = harness("ph59-stale", true);
    const profile = d.profiles.getProfile("ph59-stale")!;
    register(d, "ph59-stale", NO_TOOL, false);
    setRolePin(d, { profile: "ph59-stale", role: "extractor", provider: CF as never, model_id: NO_TOOL });

    const pin = new RolePinStore(d.db).get("ph59-stale", "extractor")!;
    const report: StalePinReport = stalePin(d, profile, pin);
    expect(report.stale).toBe(true);

    const listed = listRolePins(d, "ph59-stale");
    const row = listed.pins.find((p) => p.role === "extractor")!;
    expect(row.stale).toBe(true);
    expect(row.stale_reason).toMatch(/cannot call tools/);
    d.close();
  });

  it("a tool-bearing run reroutes and marks the pin with last_mismatch", () => {
    const d = harness("ph59-reroute", true);
    const profile = d.profiles.getProfile("ph59-reroute")!;
    register(d, "ph59-reroute", TOOL_MODEL, true);
    register(d, "ph59-reroute", NO_TOOL, false);
    setRolePin(d, { profile: "ph59-reroute", role: "extractor", provider: CF as never, model_id: NO_TOOL });

    const res = resolveRoleModel(d, profile, { roles: ["extractor"], needsTools: true });
    expect(res.source).toBe("pin_fallback_dynamic");
    expect(res.model_id).toBe(TOOL_MODEL);

    const row = new RolePinStore(d.db).get("ph59-reroute", "extractor")!;
    expect(row.last_mismatch_reason).toMatch(/cannot call tools/);
    d.close();
  });
});

describe("Phase 59 — a capable pin is used verbatim, no warning", () => {
  it("capable pin: stale=false, no mismatch mark, source=pin", () => {
    const d = harness("ph59-ok", true);
    const profile = d.profiles.getProfile("ph59-ok")!;
    register(d, "ph59-ok", TOOL_MODEL, true);
    setRolePin(d, { profile: "ph59-ok", role: "extractor", provider: CF as never, model_id: TOOL_MODEL });

    const pin = new RolePinStore(d.db).get("ph59-ok", "extractor")!;
    expect(stalePin(d, profile, pin).stale).toBe(false);

    const res = resolveRoleModel(d, profile, { roles: ["extractor"], needsTools: true });
    expect(res.source).toBe("pin");
    expect(res.model_id).toBe(TOOL_MODEL);

    const listed = listRolePins(d, "ph59-ok");
    const row = listed.pins.find((p) => p.role === "extractor")!;
    expect(row.stale).toBe(false);
    expect(row.last_mismatch_at).toBeNull();
    d.close();
  });

  it("a non-tool profile never flags a no-tool pin as stale", () => {
    const d = harness("ph59-nogate", false);
    const profile = d.profiles.getProfile("ph59-nogate")!;
    register(d, "ph59-nogate", NO_TOOL, false);
    setRolePin(d, { profile: "ph59-nogate", role: "extractor", provider: CF as never, model_id: NO_TOOL });

    const pin = new RolePinStore(d.db).get("ph59-nogate", "extractor")!;
    expect(stalePin(d, profile, pin).stale).toBe(false);
    d.close();
  });
});
