/**
 * Phase 53 gate — cost and observability for the cloud path.
 *
 * Closes a known gap: cloud runs wrote a row to `provider_sub_agent_calls`
 * and NOTHING ever read that table. A cloud sub-agent was therefore invisible
 * to the ledger, absent from the cost-saved report, and its spend never
 * counted. Three concrete defects follow from that:
 *
 * 1. `ProviderCallLogStore.getRecent` had no caller — a write-only table.
 * 2. `computeCost` only computed for OpenRouter, so every Cloudflare run logged
 *    `cost_usd = NULL` even once pricing was known.
 * 3. Neither the ledger nor the cost report could see a `finish_reason`, so a
 *    run truncated at the token ceiling (`length`, empty content) was
 *    indistinguishable from a run that simply answered in prose (`stop`).
 */
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { DatabaseSync as Sqlite } from "node:sqlite";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { ProviderCallLogStore } from "../../src/storage/providerCallLogStore.js";
import { ProviderKeyStore } from "../../src/storage/providerKeyStore.js";
import { ProviderModelStore } from "../../src/storage/providerModelStore.js";
import { applyMigrations } from "../../src/storage/migrations.js";
import { getCostSavedReport } from "../../src/workflows/costSavedReport.js";
import { seedProviderModels } from "../../src/workflows/seedProviderModels.js";
import { routeCloudWithRetry } from "../../src/providers/router.js";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";
import { startMockLmStudio, type MockLmStudio } from "../phase1/mockServer.js";
import { liveHandler } from "../phase11/helpers.js";

const CF = "cloudflare";
const MODEL = "@cf/ibm-granite/granite-4.0-h-micro";

function harness(name: string): ToolDeps {
  const d = buildDeps(scratchHome());
  d.profiles.createProfile({ name });
  d.profiles.switchProfile(name);
  new ProviderKeyStore(d.db).addKey(name, CF, "sk-live-key", { accountId: "acct-0" });
  return d;
}

/** Scripted fetch returning one healthy answer. */
function stubOk(content = "answered", finish = "stop"): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      id: "req-1",
      choices: [{ message: { role: "assistant", content }, finish_reason: finish }],
      usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
    }),
    text: async () => "",
  })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("phase53 — the router prices a cloud run from the model row", () => {
  it("computes cost_usd from the row's per-million rates", async () => {
    const d = harness("ph53-cost-priced");
    const ms = new ProviderModelStore(d.db);
    ms.registerManifestModel("ph53-cost-priced", CF, {
      model_id: MODEL, context_length: 131_000, vision: false, function_calling: true,
      pricing_prompt: 0.017, pricing_completion: 0.112,
    });
    restore = stubOk();

    const res = await routeCloudWithRetry({
      profile: d.profiles.getProfile("ph53-cost-priced")!,
      db: d.db as Sqlite, effort: "medium", role: "reviewer", brief: "hi",
      messages: [{ role: "user", content: "hi" }],
    }, CF, MODEL);

    // 1M in at 0.017 + 1M out at 0.112.
    expect(res.cost_usd).toBeCloseTo(0.129, 6);
    const logged = new ProviderCallLogStore(d.db).listRecent("ph53-cost-priced");
    expect(logged[0]!.cost_usd).toBeCloseTo(0.129, 6);
    d.close();
  });

  it("leaves cost null when the row carries no pricing", async () => {
    const d = harness("ph53-cost-unpriced");
    new ProviderModelStore(d.db).registerManifestModel("ph53-cost-unpriced", CF, {
      model_id: MODEL, context_length: null, vision: false, function_calling: true,
    });
    restore = stubOk();

    const res = await routeCloudWithRetry({
      profile: d.profiles.getProfile("ph53-cost-unpriced")!,
      db: d.db as Sqlite, effort: "medium", role: "reviewer", brief: "hi",
      messages: [{ role: "user", content: "hi" }],
    }, CF, MODEL);

    expect(res.cost_usd).toBeUndefined();
    d.close();
  });

  it("raises a truncated run as budget-exhausted instead of an empty success", async () => {
    const d = harness("ph53-finish-reason");
    new ProviderModelStore(d.db).registerManifestModel("ph53-finish-reason", CF, {
      model_id: MODEL, context_length: null, vision: false, function_calling: true,
    });
    // Empty content with `length` — the budget ran out mid-thought. The budget
    // retry doubles once before giving up, so a second identical answer ends it.
    let n = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      n += 1;
      return {
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }],
          usage: { prompt_tokens: 10, completion_tokens: 4096 },
        }),
        text: async () => "",
      } as unknown as Response;
    }) as typeof fetch;
    restore = () => { globalThis.fetch = original; };

    await expect(routeCloudWithRetry({
      profile: d.profiles.getProfile("ph53-finish-reason")!,
      db: d.db as Sqlite, effort: "medium", role: "reviewer", brief: "hi",
      messages: [{ role: "user", content: "hi" }],
    }, CF, MODEL)).rejects.toMatchObject({ code: "provider_budget_exhausted" });

    expect(n).toBe(2);
    d.close();
  });
});

describe("phase53 — call log store round-trips finish_reason", () => {
  it("writes and reads it back on both readers", () => {
    const d = harness("ph53-store");
    const store = new ProviderCallLogStore(d.db);
    for (const [finish, tokens] of [["stop", 5], ["tool_calls", 7]] as const) {
      store.logCall({
        profile_name: "ph53-store", call_uid: `uid-${finish}`, provider: CF, model_id: MODEL,
        tokens_in: 3, tokens_out: tokens, duration_ms: 100, finish_reason: finish, status: "success",
      });
    }

    expect(store.listRecent("ph53-store").map((r) => r.finish_reason).sort()).toEqual(["stop", "tool_calls"]);
    expect(store.getRecent("ph53-store", CF, MODEL, 10).every((r) => r.finish_reason !== undefined)).toBe(true);
    d.close();
  });

  it("pushes the since bound into SQL", () => {
    const d = harness("ph53-store-range");
    const store = new ProviderCallLogStore(d.db);
    store.logCall({
      profile_name: "ph53-store-range", call_uid: "old", provider: CF, model_id: MODEL,
      tokens_in: 1, tokens_out: 1, duration_ms: 1, status: "success",
    });
    store.logCall({
      profile_name: "ph53-store-range", call_uid: "new", provider: CF, model_id: MODEL,
      tokens_in: 1, tokens_out: 1, duration_ms: 1, status: "success",
    });
    const cutoff = new Date(Date.now() + 60_000).toISOString();

    expect(store.listRecent("ph53-store-range", { sinceIso: cutoff })).toHaveLength(0);
    expect(store.listRecent("ph53-store-range")).toHaveLength(2);
    d.close();
  });
});

describe("phase53 — cost report includes cloud runs", () => {
  it("counts cloud tokens and reports real spend alongside the equivalent", () => {
    const d = harness("ph53-report");
    d.callLogs.insert({
      profile_name: "ph53-report", model_id: "local-model", role: "reviewer",
      tokens_in: 1_000, tokens_out: 1_000, duration_ms: 50,
    });
    new ProviderCallLogStore(d.db).logCall({
      profile_name: "ph53-report", call_uid: "cloud-1", provider: CF, model_id: MODEL,
      role: "reviewer", tokens_in: 2_000, tokens_out: 2_000, duration_ms: 80,
      cost_usd: 0.25, finish_reason: "stop", status: "success",
    });

    const report = getCostSavedReport(d, "ph53-report", { period: "all" });

    expect(report.calls).toBe(2);
    expect(report.cloud_calls).toBe(1);
    expect(report.tokens_in).toBe(3_000);
    expect(report.tokens_out).toBe(3_000);
    expect(report.actual_spend_usd).toBeCloseTo(0.25, 6);
    expect(report.breakdown.map((b) => b.provider).sort()).toEqual(["cloudflare", "local"]);
    expect(report.breakdown.find((b) => b.provider === CF)!.actual_cost_usd).toBeCloseTo(0.25, 6);
    expect(report.breakdown.find((b) => b.provider === "local")!.actual_cost_usd).toBe(0);
    d.close();
  });

  it("excludes cloud runs older than the period window", () => {
    const d = harness("ph53-report-window");
    const store = new ProviderCallLogStore(d.db);
    store.logCall({
      profile_name: "ph53-report-window", call_uid: "recent", provider: CF, model_id: MODEL,
      tokens_in: 100, tokens_out: 100, duration_ms: 10, cost_usd: 0.01, status: "success",
    });
    store.logCall({
      profile_name: "ph53-report-window", call_uid: "ancient", provider: CF, model_id: MODEL,
      tokens_in: 100, tokens_out: 100, duration_ms: 10, cost_usd: 9.99, status: "success",
    });
    d.db.prepare("UPDATE provider_sub_agent_calls SET created_at=? WHERE call_uid=?")
      .run(new Date(Date.now() - 10 * 86_400_000).toISOString(), "ancient");

    const day = getCostSavedReport(d, "ph53-report-window", { period: "day" });
    expect(day.cloud_calls).toBe(1);
    expect(day.actual_spend_usd).toBeCloseTo(0.01, 6);

    const all = getCostSavedReport(d, "ph53-report-window", { period: "all" });
    expect(all.cloud_calls).toBe(2);
    d.close();
  });
});

describe("phase53 — the ledger endpoint shows cloud runs", () => {
  interface Harness { deps: ToolDeps; ui: UiServer; mock: MockLmStudio; base: string }

  async function setupLocal(name: string): Promise<Harness> {
    const deps = buildDeps(scratchHome());
    const mock = await startMockLmStudio(liveHandler);
    deps.profiles.createProfile({ name, endpoint: { url: mock.url }, machine_specs: { vram_gb: 4 } });
    deps.profiles.switchProfile(name);
    const ui = await startUiServer(deps, { port: 0 });
    return { deps, ui, mock, base: `http://127.0.0.1:${ui.port}` };
  }

  it("merges local and cloud rows and keeps spend out of saved_usd", async () => {
    const h = await setupLocal("ph53-ledger");
    h.deps.callLogs.insert({
      profile_name: "ph53-ledger", model_id: "local-model", role: "reviewer",
      tokens_in: 10, tokens_out: 10, duration_ms: 5, cost_usd: 0.5,
    });
    new ProviderCallLogStore(h.deps.db).logCall({
      profile_name: "ph53-ledger", call_uid: "c1", provider: CF, model_id: MODEL,
      role: "reviewer", tokens_in: 20, tokens_out: 20, duration_ms: 30,
      cost_usd: 0.02, finish_reason: "length", status: "success",
    });

    const body = (await (await fetch(`${h.base}/api/ledger?range=all`)).json()) as {
      rows: Array<{ model: string; provider: string | null; finish_reason: string | null }>;
      fun_stats: { saved_usd: number; spent_usd: number; cloud_runs: number; total_runs: number };
    };

    expect(body.fun_stats.total_runs).toBe(2);
    expect(body.fun_stats.cloud_runs).toBe(1);
    expect(body.fun_stats.saved_usd).toBeCloseTo(0.5, 6);
    expect(body.fun_stats.spent_usd).toBeCloseTo(0.02, 6);
    const cloud = body.rows.find((r) => r.provider === CF)!;
    expect(cloud.model).toBe(MODEL);
    expect(cloud.finish_reason).toBe("length");
    expect(body.rows.find((r) => r.model === "local-model")!.provider).toBeNull();

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });

  it("filters by range in SQL, dropping an out-of-window cloud row", async () => {
    const h = await setupLocal("ph53-ledger-range");
    const store = new ProviderCallLogStore(h.deps.db);
    store.logCall({
      profile_name: "ph53-ledger-range", call_uid: "stale", provider: CF, model_id: MODEL,
      tokens_in: 1, tokens_out: 1, duration_ms: 1, cost_usd: 5, status: "success",
    });
    h.deps.db.prepare("UPDATE provider_sub_agent_calls SET created_at=? WHERE call_uid=?")
      .run(new Date(Date.now() - 30 * 86_400_000).toISOString(), "stale");

    const week = (await (await fetch(`${h.base}/api/ledger?range=7d`)).json()) as { fun_stats: { cloud_runs: number; spent_usd: number } };
    expect(week.fun_stats.cloud_runs).toBe(0);
    expect(week.fun_stats.spent_usd).toBe(0);

    const all = (await (await fetch(`${h.base}/api/ledger?range=all`)).json()) as { fun_stats: { cloud_runs: number } };
    expect(all.fun_stats.cloud_runs).toBe(1);

    await h.ui.close();
    h.deps.close();
    await h.mock.close();
    cleanup(h.deps.home);
  });
});

describe("phase53 — seed writes real catalog pricing", () => {
  it("stores the manifest rates on the model row", () => {
    const d = harness("ph53-seed");
    seedProviderModels(d, { profile: "ph53-seed", provider: CF, model_ids: [MODEL] });

    const row = new ProviderModelStore(d.db).getModel("ph53-seed", CF, MODEL);
    expect(row!.pricing_prompt).toBeCloseTo(0.017, 6);
    expect(row!.pricing_completion).toBeCloseTo(0.112, 6);
    d.close();
  });
});

describe("phase53 — migration 20 adds finish_reason to a legacy database", () => {
  it("adds the column and bumps user_version", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE provider_sub_agent_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_name TEXT NOT NULL, call_uid TEXT NOT NULL, provider TEXT NOT NULL,
        model_id TEXT NOT NULL, tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL, ttft_ms INTEGER, performance_score INTEGER,
        status TEXT NOT NULL DEFAULT 'success', created_at TEXT NOT NULL
      );
      PRAGMA user_version = 19;
    `);
    const before = db.prepare("PRAGMA table_info(provider_sub_agent_calls)").all() as Array<{ name: string }>;
    expect(before.some((c) => c.name === "finish_reason")).toBe(false);

    applyMigrations(db);

    const after = db.prepare("PRAGMA table_info(provider_sub_agent_calls)").all() as Array<{ name: string }>;
    expect(after.some((c) => c.name === "finish_reason")).toBe(true);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBeGreaterThanOrEqual(20);
    db.close();
  });
});
