import { afterAll, describe, expect, it } from "vitest";
import { ProfileManager } from "../../src/storage/profileManager.js";
import {
  DEFAULT_ENDPOINT_URL,
  DEFAULT_NTFY_SERVER_URL,
  DEFAULT_PRICING,
  DEFAULT_TEST_PLAN_REF,
  DEFAULT_USE_CASE,
  MACHINE_SPEC_BASELINE,
  type Profile,
} from "../../src/storage/profileDefaults.js";
import { cleanup, scratchHome } from "./helpers.js";

const homes: string[] = [];

describe("ProfileManager — CRUD round trip", () => {
  const home = scratchHome();
  homes.push(home);
  const pm = new ProfileManager(home);

  it("creates a profile with explicit fields", () => {
    const created = pm.createProfile({
      name: "alpha",
      machine_specs: { cpu: "Intel i7", gpu: "RTX 3080", vram_gb: 10, ram_gb: 32, storage: "NVMe" },
      endpoint: { url: "http://localhost:4321", auth_token: "tok" },
      use_case: "code review",
      pricing: { input_per_million_usd: 5, output_per_million_usd: 20 },
      test_plan_ref: null,
      ntfy: { topic: "nan", server_url: "http://ntfy.local", access_token: "abc" },
    });
    expect(created.name).toBe("alpha");
    expect(created.machine_specs.vram_gb).toBe(10);
    expect(created.ntfy.server_url).toBe("http://ntfy.local");
  });

  it("reads back the same shape", () => {
    const read = pm.getProfile("alpha");
    expect(read).not.toBeNull();
    expect(read).toMatchObject({
      name: "alpha",
      use_case: "code review",
      endpoint: { url: "http://localhost:4321", auth_token: "tok" },
      test_plan_ref: null,
    });
  });

  it("rejects duplicate names and invalid names", () => {
    expect(() => pm.createProfile({ name: "alpha" })).toThrowError(/already exists/);
    expect(() => pm.createProfile({ name: "../evil" })).toThrowError(/may only contain/);
  });

  it("switches the active pointer and persists it", () => {
    pm.createProfile({ name: "beta" });
    expect(pm.getActiveProfile()).toBeNull();
    pm.switchProfile("beta");
    const active = pm.getActiveProfile();
    expect(active?.name).toBe("beta");
    expect(pm.listProfiles()).toEqual(["alpha", "beta"]);
  });

  it("switch to a missing profile is a structured error", () => {
    expect(() => pm.switchProfile("ghost")).toThrowError(/No profile named "ghost"/);
  });

  it("updateProfile merges a patch and preserves created_at", () => {
    const updated = pm.updateProfile("alpha", { use_case: "translation" });
    expect(updated.use_case).toBe("translation");
    expect(updated.endpoint.url).toBe("http://localhost:4321"); // untouched
    expect(updated.created_at).toBe(pm.getProfile("alpha")!.created_at);
  });

  afterAll(() => {
    cleanup(home);
  });
});

describe("ProfileManager — default fallback per omitted field", () => {
  const home = scratchHome();
  homes.push(home);
  const pm = new ProfileManager(home);

  it("machine_specs omitted -> project baseline constant", () => {
    const p = pm.createProfile({ name: "no-specs" });
    expect(p.machine_specs).toEqual(MACHINE_SPEC_BASELINE);
  });

  it("endpoint omitted -> localhost:1234, no auth", () => {
    const p = pm.createProfile({ name: "no-endpoint" });
    expect(p.endpoint).toEqual({ url: DEFAULT_ENDPOINT_URL, auth_token: null });
  });

  it("endpoint partial (url only) -> auth_token defaults to null", () => {
    const p = pm.createProfile({ name: "partial-endpoint", endpoint: { url: "http://x" } });
    expect(p.endpoint).toEqual({ url: "http://x", auth_token: null });
  });

  it("use_case omitted -> 'nanites-default'", () => {
    const p = pm.createProfile({ name: "no-usecase" });
    expect(p.use_case).toBe(DEFAULT_USE_CASE);
  });

  it("pricing omitted -> documented placeholder default", () => {
    const p = pm.createProfile({ name: "no-pricing" });
    expect(p.pricing).toEqual(DEFAULT_PRICING);
  });

  it("test_plan_ref omitted -> 'default'", () => {
    const p = pm.createProfile({ name: "no-testplan" });
    expect(p.test_plan_ref).toBe(DEFAULT_TEST_PLAN_REF);
  });

  it("ntfy omitted -> topic null, public server, no auth", () => {
    const p = pm.createProfile({ name: "no-ntfy" });
    expect(p.ntfy).toEqual({ topic: null, server_url: DEFAULT_NTFY_SERVER_URL, access_token: null });
  });

  it("concurrency is derived from resolved machine specs, not stored input", () => {
    const baseline = pm.createProfile({ name: "con-baseline" }); // vram 4 -> forced sequential (1x1)
    expect(baseline.concurrency).toEqual({ mode: "sequential", max_parallel_models: 1, num_parallel: 1 });
    expect(baseline.concurrency_override).toBeNull();
    const parallel = pm.createProfile({ name: "con-ultra", machine_specs: { vram_gb: 32 } });
    expect(parallel.concurrency).toEqual({ mode: "parallel", max_parallel_models: 4, num_parallel: 2 });
  });

  it("full create stays internally consistent (no placeholder leakage into explicit fields)", () => {
    const p = pm.createProfile({ name: "explicit", ntfy: { topic: "t" } }) as Profile;
    expect(p.ntfy.topic).toBe("t");
    expect(p.ntfy.server_url).toBe(DEFAULT_NTFY_SERVER_URL); // only topic given
    expect(p.name).toBe("explicit");
  });

  afterAll(() => {
    cleanup(home);
  });
});
