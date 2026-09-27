/**
 * Phase 14 gate — REST endpoints. Starts the node:http UI server on an
 * ephemeral port against a scratch NANITES_HOME + mock LM Studio, then asserts
 * /, /api/leaderboard, /api/ledger, and /api/health over real HTTP.
 */
import { describe, expect, it } from "vitest";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";
import { startMockLmStudio, type MockLmStudio } from "../phase1/mockServer.js";
import { liveHandler } from "../phase11/helpers.js";

const DAY_MS = 86_400_000;

interface Harness {
  deps: ToolDeps;
  ui: UiServer;
  mock: MockLmStudio;
  base: string;
}

async function setup(seed: (deps: ToolDeps) => void = () => {}): Promise<Harness> {
  const home = scratchHome();
  // Pin the health report's free-disk reading — see test/phase5/helpers.ts.
  // Without this, `/api/health`'s healthy/degraded verdict depends on the host
  // volume's free space.
  const deps = buildDeps(home, { healthDisk: { availableGb: 500 } });
  const mock = await startMockLmStudio(liveHandler);
  deps.profiles.createProfile({ name: "t", endpoint: { url: mock.url }, machine_specs: { vram_gb: 4 } });
  deps.profiles.switchProfile("t");
  seed(deps);
  const ui = await startUiServer(deps, { port: 0 });
  return { deps, ui, mock, base: `http://127.0.0.1:${ui.port}` };
}

describe("GET /", () => {
  it("serves the dashboard HTML (dev fallback when not built)", async () => {
    const h = await setup();
    const res = await fetch(`${h.base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body.toLowerCase()).toContain("<html");
    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });
});

describe("GET /api/leaderboard", () => {
  it("sorts by performance_score desc and filters by role", async () => {
    const h = await setup((deps) => {
      deps.registry.upsert("t", { model_id: "a/reviewer", roles: ["reviewer"], scores: {}, best_params: {}, last_tested: null, performance_score: 10 });
      deps.registry.upsert("t", { model_id: "b/coder", roles: ["coder"], scores: {}, best_params: { context_length: 4096, temperature: 0.3 }, last_tested: "2026-01-01T00:00:00.000Z", performance_score: 90 });
      deps.registry.upsert("t", { model_id: "c/summarizer", roles: ["summarizer"], scores: {}, best_params: {}, last_tested: null, performance_score: 50 });
    });

    const all = (await (await fetch(`${h.base}/api/leaderboard?role=all`)).json()) as { rows: Array<{ model: string; score: number; params: string }> };
    expect(all.rows.map((r) => r.model)).toEqual(["b/coder", "c/summarizer", "a/reviewer"]);
    expect(all.rows[0]!.score).toBe(90);
    expect(all.rows[0]!.params).toContain("ctx 4096");

    const coder = (await (await fetch(`${h.base}/api/leaderboard?role=coder`)).json()) as { rows: Array<{ model: string }> };
    expect(coder.rows.map((r) => r.model)).toEqual(["b/coder"]);

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });

  it("reflects an active-profile switch on the next request", async () => {
    const h = await setup((deps) => {
      deps.registry.upsert("t", { model_id: "a/t-only", roles: ["coder"], scores: {}, best_params: {}, last_tested: null, performance_score: 80 });
    });
    h.deps.profiles.createProfile({ name: "second", endpoint: { url: h.mock.url }, machine_specs: { vram_gb: 4 } });
    h.deps.profiles.switchProfile("second");
    h.deps.registry.upsert("second", { model_id: "z/second-only", roles: ["coder"], scores: {}, best_params: {}, last_tested: null, performance_score: 20 });

    const rows = (await (await fetch(`${h.base}/api/leaderboard?role=all`)).json()) as { rows: Array<{ model: string }> };
    expect(rows.rows.map((r) => r.model)).toEqual(["z/second-only"]);

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });
});

describe("GET /api/ledger", () => {
  function seedLedger(deps: ToolDeps): void {
    const recent = new Date().toISOString();
    const old = new Date(Date.now() - 10 * DAY_MS).toISOString();
    // Two recent successful runs of model "a", one recent failure, one old run.
    deps.callLogs.insert({ profile_name: "t", model_id: "a", role: "reviewer", tokens_in: 100, tokens_out: 200, duration_ms: 3000, cost_usd: 0.001, created_at: recent });
    deps.callLogs.insert({ profile_name: "t", model_id: "a", role: "reviewer", tokens_in: 50, tokens_out: 50, duration_ms: 1000, cost_usd: 0.0005, created_at: recent });
    deps.callLogs.insert({ profile_name: "t", model_id: "b", role: "coder", tokens_in: 10, tokens_out: 10, duration_ms: 500, cost_usd: 0.0001, error_code: "timeout", created_at: recent });
    deps.callLogs.insert({ profile_name: "t", model_id: "b", role: "coder", tokens_in: 1000, tokens_out: 1000, duration_ms: 5000, cost_usd: 0.01, created_at: old });
  }

  it("computes fun stats, favourite model, and timeseries buckets", async () => {
    const h = await setup(seedLedger);
    const body = (await (await fetch(`${h.base}/api/ledger?range=all`)).json()) as {
      fun_stats: { total_runs: number; success_rate: number; favourite_model: string | null; tokens_vs_moby_dick: number; avg_t_s: number };
      timeseries: { labels: string[]; tokens: number[] };
      roles: Array<{ role: string; calls: number }>;
    };

    expect(body.fun_stats.total_runs).toBe(4);
    expect(body.fun_stats.favourite_model).toBe("a");
    expect(body.fun_stats.success_rate).toBe(0.75); // 3 of 4 without error_code
    // total tokens = 100+200 + 50+50 + 10+10 + 1000+1000 = 2420
    expect(body.timeseries.tokens.reduce((s, n) => s + n, 0)).toBe(2420);
    expect(body.fun_stats.tokens_vs_moby_dick).toBeCloseTo(2420 / 1_160_000, 4);
    // roles: reviewer 2, coder 2
    const byRole = Object.fromEntries(body.roles.map((r) => [r.role, r.calls]));
    expect(byRole).toEqual({ reviewer: 2, coder: 2 });
    // avg t/s = 2420 tokens / (9500ms / 1000) = 254.7...
    expect(body.fun_stats.avg_t_s).toBeCloseTo(254.7, 1);

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });

  it("respects the 7d window", async () => {
    const h = await setup(seedLedger);
    const body = (await (await fetch(`${h.base}/api/ledger?range=7d`)).json()) as {
      fun_stats: { total_runs: number };
    };
    expect(body.fun_stats.total_runs).toBe(3); // the old 10-day row is excluded

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });
});

describe("GET /api/health", () => {
  it("reports reachable/healthy and resident cards", async () => {
    const h = await setup();
    const body = (await (await fetch(`${h.base}/api/health`)).json()) as {
      overall: string;
      reachable: boolean;
      loaded_models: string[];
      resident: Array<{ id: string; quant: string | null; ctx: number | null; vram_pct: number; level: string }>;
      hardware: {
        vram_gb: number;
        mode: string;
        max_parallel_models: number;
        process_cap: number;
        num_parallel: number;
        allowed_pairs: Array<{ max_parallel_models: number; num_parallel: number }>;
        overridden: boolean;
      };
    };
    expect(body.overall).toBe("healthy");
    expect(body.reachable).toBe(true);
    expect(body.loaded_models).toContain("gemma-3-270m-it-qat");
    expect(body.resident).toEqual([
      { id: "gemma-3-270m-it-qat", quant: "Q4_0", ctx: 4096, vram_pct: 6, level: "ok" },
    ]);
    expect(body.hardware).toEqual({
      vram_gb: 4,
      mode: "sequential",
      max_parallel_models: 1,
      process_cap: 1,
      num_parallel: 1,
      allowed_pairs: [],
      overridden: false,
    });

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });
});

describe("profiles endpoints", () => {
  it("GET /api/profiles lists profiles and the active one", async () => {
    const h = await setup();
    h.deps.profiles.createProfile({ name: "second", endpoint: { url: h.mock.url }, machine_specs: { vram_gb: 8 } });
    const body = (await (await fetch(`${h.base}/api/profiles`)).json()) as { active: string | null; profiles: Array<{ name: string }> };
    expect(body.active).toBe("t");
    expect(body.profiles.map((p) => p.name).sort()).toEqual(["second", "t"].sort());

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });

  it("GET /api/profile?name= returns editable fields of a named profile", async () => {
    const h = await setup();
    const body = (await (await fetch(`${h.base}/api/profile?name=t`)).json()) as {
      profile: { name: string; endpoint: { auth_token: string | null }; machine_specs: { vram_gb: number } };
    };
    expect(body.profile.name).toBe("t");
    expect(body.profile.machine_specs.vram_gb).toBe(4);
    expect(body.profile.endpoint.auth_token).toBeNull();

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });

  it("GET /api/profile?name= 404s on unknown profile", async () => {
    const h = await setup();
    const res = await fetch(`${h.base}/api/profile?name=nope`);
    expect(res.status).toBe(404);

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });

  it("POST /api/settings/profile patches the named profile, not just active", async () => {
    const h = await setup();
    h.deps.profiles.createProfile({ name: "second", endpoint: { url: h.mock.url }, machine_specs: { vram_gb: 8 } });
    const res = await fetch(`${h.base}/api/settings/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "second", endpoint: { auth_token: "tok" } }),
    });
    expect(res.status).toBe(200);
    const patched = h.deps.profiles.getProfile("second");
    expect(patched?.endpoint.auth_token).toBe("tok");
    // active untouched
    const active = h.deps.profiles.getProfile("t");
    expect(active?.endpoint.auth_token).toBeNull();

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });

  it("POST /api/settings/profile without a profile field patches the active profile", async () => {
    const h = await setup();
    const res = await fetch(`${h.base}/api/settings/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: { auth_token: "active-tok" } }),
    });
    expect(res.status).toBe(200);
    expect(h.deps.profiles.getProfile("t")?.endpoint.auth_token).toBe("active-tok");

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });
});
