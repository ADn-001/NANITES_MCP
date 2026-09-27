/**
 * Phase 15 gate — POST /api/settings/wipe. Seeds sub_agent_calls,
 * sub_agent_events, param_search_attempts, and the Phase-C jobs queue across
 * two dates, then asserts {before_date} removes only older rows, {all:true}
 * clears, and the registry / test_results / test_units tables are never touched.
 */
import { describe, expect, it } from "vitest";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

const DAY_MS = 86_400_000;

function seed(deps: ToolDeps): void {
  const old = new Date(Date.now() - 10 * DAY_MS).toISOString();
  const recent = new Date().toISOString();

  for (const created_at of [old, recent]) {
    deps.callLogs.insert({ profile_name: "t", model_id: "m1", role: "reviewer", tokens_in: 10, tokens_out: 20, duration_ms: 100, created_at });
    deps.subAgentEvents.insert({ profile_name: "t", model_id: "m1", phase: "chat.start", payload: {}, created_at });
    deps.paramSearch.log({ profile_name: "t", model_id: "m1", attempt: created_at === old ? 1 : 2, params: { temperature: 0.3 }, score: 50, detail: "", created_at });
    deps.jobs.create({ profile_name: "t", kind: "sub_agent", payload: { brief: "x" }, created_at });
  }

  // Tables the wipe must NOT touch.
  deps.registry.upsert("t", { model_id: "m1", roles: ["reviewer"], scores: {}, best_params: {}, last_tested: null, performance_score: 50 });
  deps.testResults.insert({ profile_name: "t", model_id: "m1", unit_id: "u1", status: "approved", score: 90 });
  deps.testUnits.registerDefaultRegimen("t");
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe("POST /api/settings/wipe", () => {
  it("{before_date} removes only older rows and leaves other tables untouched", async () => {
    const home = scratchHome();
    const deps = buildDeps(home);
    deps.profiles.createProfile({ name: "t" });
    deps.profiles.switchProfile("t");
    seed(deps);
    const ui: UiServer = await startUiServer(deps, { port: 0 });
    const base = `http://127.0.0.1:${ui.port}`;

    const cutoff = new Date(Date.now() - 5 * DAY_MS).toISOString();
    const { status, json } = await post(base, "/api/settings/wipe", { before_date: cutoff });
    expect(status).toBe(200);
    expect(json).toEqual({
      deleted: {
        sub_agent_calls: 1,
        sub_agent_events: 1,
        param_search_attempts: 1,
        jobs: 1,
        // Phase H (H1) widened the ephemeral wipe bucket to the btw tables.
        btw_chat: 0,
        btw_chat_messages: 0,
        btw_chunks: 0,
        context_caches: 0,
      },
    });

    expect(deps.callLogs.list("t", 1000).length).toBe(1);
    expect(deps.subAgentEvents.listSince("t", 0, 1000).length).toBe(1);
    expect(deps.paramSearch.list("t", "m1").length).toBe(1);
    expect(deps.jobs.listQueued(1000).length).toBe(1);
    expect(deps.registry.list("t").length).toBe(1);
    expect(deps.testResults.list("t", "m1").length).toBe(1);
    expect(deps.testUnits.list("t").length).toBeGreaterThan(0);

    await ui.close();
    deps.close();
    cleanup(home);
  });

  it("{all:true} clears the three log tables and leaves the rest", async () => {
    const home = scratchHome();
    const deps = buildDeps(home);
    deps.profiles.createProfile({ name: "t" });
    deps.profiles.switchProfile("t");
    seed(deps);
    const ui: UiServer = await startUiServer(deps, { port: 0 });
    const base = `http://127.0.0.1:${ui.port}`;

    const { status, json } = await post(base, "/api/settings/wipe", { all: true });
    expect(status).toBe(200);
    expect(json).toEqual({
      deleted: {
        sub_agent_calls: 2,
        sub_agent_events: 2,
        param_search_attempts: 2,
        jobs: 2,
        // Phase H (H1) widened the ephemeral wipe bucket to the btw tables.
        btw_chat: 0,
        btw_chat_messages: 0,
        btw_chunks: 0,
        context_caches: 0,
      },
    });

    expect(deps.callLogs.list("t", 1000).length).toBe(0);
    expect(deps.subAgentEvents.listSince("t", 0, 1000).length).toBe(0);
    expect(deps.paramSearch.list("t", "m1").length).toBe(0);
    expect(deps.jobs.listQueued(1000).length).toBe(0);
    expect(deps.registry.list("t").length).toBe(1);
    expect(deps.testResults.list("t", "m1").length).toBe(1);
    expect(deps.testUnits.list("t").length).toBeGreaterThan(0);

    await ui.close();
    deps.close();
    cleanup(home);
  });

  it("rejects a malformed body with a structured error", async () => {
    const home = scratchHome();
    const deps = buildDeps(home);
    deps.profiles.createProfile({ name: "t" });
    deps.profiles.switchProfile("t");
    const ui: UiServer = await startUiServer(deps, { port: 0 });
    const base = `http://127.0.0.1:${ui.port}`;

    const { status, json } = await post(base, "/api/settings/wipe", { nonsense: true });
    expect(status).toBe(400);
    expect(json).toEqual({ code: "bad_request", message: expect.any(String), retryable: false });

    await ui.close();
    deps.close();
    cleanup(home);
  });
});
