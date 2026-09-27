/**
 * Phase CP-2 gate — concurrency_override through the JSON profile store:
 * create/update validate against the effective tier (write path rejects
 * out-of-set pairs with a structured error), reads recompute the effective
 * config, and a hand-edit that drifts a profile across VRAM tiers degrades a
 * now-invalid override to the tier default instead of breaking the read.
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ProfileManager } from "../../src/storage/profileManager.js";
import {
  concurrencyOverrideSchema,
  profilePatchSchema,
  type ConcurrencyOverride,
} from "../../src/storage/profileDefaults.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

function expectInvalidOverride(fn: () => unknown): void {
  try {
    fn();
    expect.fail("expected a concurrency_override_invalid error");
  } catch (err) {
    expect((err as { code?: string }).code).toBe("concurrency_override_invalid");
  }
}

describe("createProfile — override validation", () => {
  const home = scratchHome();
  const pm = new ProfileManager(home);

  it("accepts a valid override on the ultra tier and stores it effective", () => {
    const p = pm.createProfile({
      name: "ultra-4x4",
      machine_specs: { vram_gb: 32 },
      concurrency_override: { max_parallel_models: 4, num_parallel: 4 },
    });
    expect(p.concurrency).toEqual({ mode: "parallel", max_parallel_models: 4, num_parallel: 4 });
    expect(p.concurrency_override).toEqual({ max_parallel_models: 4, num_parallel: 4 });

    const read = pm.getProfile("ultra-4x4")!;
    expect(read.concurrency.num_parallel).toBe(4);
  });

  it("rejects (4,4) on the high tier (only (2,2) allowed)", () => {
    expectInvalidOverride(() =>
      pm.createProfile({ name: "high-bad", machine_specs: { vram_gb: 16 }, concurrency_override: { max_parallel_models: 4, num_parallel: 4 } }),
    );
  });

  it("rejects any override on a forced sequential tier", () => {
    expectInvalidOverride(() =>
      pm.createProfile({ name: "seq-bad", machine_specs: { vram_gb: 4 }, concurrency_override: { max_parallel_models: 2, num_parallel: 2 } }),
    );
  });

  it("no override -> derived default, override stored null", () => {
    const p = pm.createProfile({ name: "plain", machine_specs: { vram_gb: 16 } });
    expect(p.concurrency).toEqual({ mode: "parallel", max_parallel_models: 2, num_parallel: 2 });
    expect(p.concurrency_override).toBeNull();
  });

  afterAll(() => cleanup(home));
});

describe("updateProfile — override set / clear / drift", () => {
  const home = scratchHome();
  const pm = new ProfileManager(home);

  it("sets an override, then clears it back to the derived default", () => {
    const base = pm.createProfile({ name: "u", machine_specs: { vram_gb: 32 } });
    expect(base.concurrency.num_parallel).toBe(2);

    const overridden = pm.updateProfile("u", { concurrency_override: { max_parallel_models: 2, num_parallel: 4 } });
    expect(overridden.concurrency).toEqual({ mode: "parallel", max_parallel_models: 2, num_parallel: 4 });

    const cleared = pm.updateProfile("u", { concurrency_override: null });
    expect(cleared.concurrency).toEqual({ mode: "parallel", max_parallel_models: 4, num_parallel: 2 });
    expect(cleared.concurrency_override).toBeNull();
  });

  it("rejects a patch that lowers VRAM below an existing override's allowed tier", () => {
    pm.createProfile({ name: "v", machine_specs: { vram_gb: 40 }, concurrency_override: { max_parallel_models: 4, num_parallel: 4 } });
    // Lowering to high tier (16GB) makes the stored (4,4) override invalid -> reject.
    expectInvalidOverride(() => pm.updateProfile("v", { machine_specs: { vram_gb: 16 } }));
  });

  it("hand-edit drift: a now-invalid stored override degrades to derived on read", () => {
    const raw: Record<string, unknown> = {
      name: "drifter",
      machine_specs: { cpu: "c", gpu: "g", vram_gb: 16, ram_gb: 16, storage: "ssd" },
      endpoint: { url: "http://localhost:1234", auth_token: null },
      use_case: "nanites-default",
      pricing: { input_per_million_usd: 3, output_per_million_usd: 15 },
      test_plan_ref: "default",
      ntfy: { topic: null, server_url: "https://ntfy.sh", access_token: null },
      // Stored when the box reported 32GB; file later hand-edited to 16GB.
      concurrency: { mode: "parallel", max_parallel_models: 4, num_parallel: 2 },
      concurrency_override: { max_parallel_models: 4, num_parallel: 4 },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const dir = path.join(home, "profiles");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "drifter.json"), JSON.stringify(raw));

    const read = pm.getProfile("drifter")!;
    expect(read.machine_specs.vram_gb).toBe(16);
    // Invalid on high tier -> override dropped, derived (2x2) wins.
    expect(read.concurrency_override).toBeNull();
    expect(read.concurrency).toEqual({ mode: "parallel", max_parallel_models: 2, num_parallel: 2 });
  });

  afterAll(() => cleanup(home));
});

describe("legacy + schema round trips", () => {
  const home = scratchHome();
  const pm = new ProfileManager(home);

  it("a legacy concurrency file without num_parallel reads and backfills it", () => {
    const raw: Record<string, unknown> = {
      name: "legacy",
      machine_specs: { cpu: "c", gpu: "g", vram_gb: 4, ram_gb: 16, storage: "ssd" },
      endpoint: { url: "http://localhost:1234", auth_token: null },
      use_case: "nanites-default",
      pricing: { input_per_million_usd: 3, output_per_million_usd: 15 },
      test_plan_ref: "default",
      ntfy: { topic: null, server_url: "https://ntfy.sh", access_token: null },
      concurrency: { mode: "sequential", max_parallel_models: 1 }, // no num_parallel
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const dir = path.join(home, "profiles");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "legacy.json"), JSON.stringify(raw));

    const read = pm.getProfile("legacy")!;
    expect(read.concurrency).toEqual({ mode: "sequential", max_parallel_models: 1, num_parallel: 1 });
    expect(read.concurrency_override).toBeNull();
  });

  it("concurrencyOverrideSchema accepts a valid pair and null, rejects junk", () => {
    const valid: ConcurrencyOverride = { max_parallel_models: 2, num_parallel: 4 };
    expect(concurrencyOverrideSchema.parse(valid)).toEqual(valid);
    expect(concurrencyOverrideSchema.parse(null)).toBeNull();
    expect(concurrencyOverrideSchema.safeParse({ max_parallel_models: 0, num_parallel: 4 }).success).toBe(false);
    expect(concurrencyOverrideSchema.safeParse({ max_parallel_models: 2 }).success).toBe(false);
  });

  it("profilePatchSchema accepts concurrency_override (incl. null) and rejects malformed pairs", () => {
    const ok = profilePatchSchema.safeParse({ concurrency_override: { max_parallel_models: 4, num_parallel: 4 } });
    expect(ok.success).toBe(true);
    expect(profilePatchSchema.safeParse({ concurrency_override: null }).success).toBe(true);
    expect(profilePatchSchema.safeParse({ concurrency_override: { max_parallel_models: -1, num_parallel: 4 } }).success).toBe(false);
  });

  afterAll(() => cleanup(home));
});
