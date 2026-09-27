/**
 * Phase CP-5 gate — the dashboard is the concurrency-override surface. Over the
 * real UI server: a concurrency_override patch round-trips to /api/profile and
 * shows up (overridden flag + num_parallel) on /api/health; a forced-tier
 * override is rejected with concurrency_override_invalid and never persists;
 * clearing an override returns the profile to derived. The served dashboard
 * HTML carries the new override control's markers.
 */
import { describe, expect, it } from "vitest";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";
import { startMockLmStudio, type MockLmStudio } from "../phase1/mockServer.js";
import { liveHandler } from "../phase11/helpers.js";

interface Harness {
  deps: ToolDeps;
  ui: UiServer;
  mock: MockLmStudio;
  base: string;
}

async function setup(vramGb: number): Promise<Harness> {
  const home = scratchHome();
  const deps = buildDeps(home);
  const mock = await startMockLmStudio(liveHandler);
  deps.profiles.createProfile({ name: "t", endpoint: { url: mock.url }, machine_specs: { vram_gb: vramGb } });
  deps.profiles.switchProfile("t");
  const ui = await startUiServer(deps, { port: 0 });
  return { deps, ui, mock, base: `http://127.0.0.1:${ui.port}` };
}

async function patchProfile(h: Harness, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${h.base}/api/settings/profile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function profileOf(h: Harness): Promise<Record<string, unknown>> {
  const res = await fetch(`${h.base}/api/profile?name=t`);
  return ((await res.json()) as { profile: Record<string, unknown> }).profile;
}

async function healthHardware(h: Harness): Promise<Record<string, unknown>> {
  const res = await fetch(`${h.base}/api/health`);
  return ((await res.json()) as { hardware: Record<string, unknown> }).hardware;
}

describe("CP-5 concurrency override via the UI server", () => {
  it("round-trips an allowed override on a 16GB (2x2-only) profile", async () => {
    const h = await setup(16);
    const r = await patchProfile(h, {
      concurrency_override: { max_parallel_models: 2, num_parallel: 2 },
    });
    expect(r.status).toBe(200);

    const p = await profileOf(h);
    expect(p.concurrency_override).toEqual({ max_parallel_models: 2, num_parallel: 2 });
    expect(p.overridden).toBe(true);
    expect(p.allowed_pairs).toEqual([{ max_parallel_models: 2, num_parallel: 2 }]);
    expect((p.concurrency as { num_parallel: number }).num_parallel).toBe(2);

    const hw = await healthHardware(h);
    expect(hw.num_parallel).toBe(2);
    expect(hw.process_cap).toBe(2);
    expect(hw.overridden).toBe(true);
    expect(hw.allowed_pairs).toEqual([{ max_parallel_models: 2, num_parallel: 2 }]);

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });

  it("rejects an override on a forced sequential tier and never persists it", async () => {
    const h = await setup(4);
    const r = await patchProfile(h, {
      concurrency_override: { max_parallel_models: 2, num_parallel: 2 },
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("concurrency_override_invalid");

    const p = await profileOf(h);
    expect(p.concurrency_override).toBeNull();
    expect(p.overridden).toBe(false);

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });

  it("clearing an override returns the profile to the derived default", async () => {
    const h = await setup(24); // ultra: derived 4x2, all four pairs allowed
    await patchProfile(h, { concurrency_override: { max_parallel_models: 4, num_parallel: 4 } });
    const p1 = await profileOf(h);
    expect(p1.overridden).toBe(true);
    expect((p1.concurrency as { max_parallel_models: number }).max_parallel_models).toBe(4);
    expect((p1.concurrency as { num_parallel: number }).num_parallel).toBe(4);

    const r = await patchProfile(h, { concurrency_override: null });
    expect(r.status).toBe(200);
    const p2 = await profileOf(h);
    expect(p2.overridden).toBe(false);
    expect(p2.concurrency_override).toBeNull();
    expect(p2.concurrency).toEqual({ mode: "parallel", max_parallel_models: 4, num_parallel: 2 });

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });
});

describe("CP-5 dashboard HTML carries the override control", () => {
  it("serves the pair-picker markers", async () => {
    const h = await setup(16);
    const body = await (await fetch(`${h.base}/`)).text();
    expect(body).toContain('id="cfgTier"');
    expect(body).toContain('id="cfgTierHint"');
    expect(body).toContain("function renderTierOptions");
    expect(body).toContain("function allowedConcurrencyPairs");
    expect(body).toContain('id="hwTier"');
    expect(body).toContain('id="hwGuardNote"');
    expect(body).toContain("Auto (from specs)");
    expect(body).toContain("concurrency_override");

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });
});
