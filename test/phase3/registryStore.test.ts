import { afterAll, describe, expect, it } from "vitest";
import { openNanitesDb } from "../../src/storage/db.js";
import { RegistryStore } from "../../src/storage/registryStore.js";
import { CallLogStore } from "../../src/storage/callLogStore.js";
import { TestResultStore } from "../../src/storage/testResultStore.js";
import { cleanup, scratchHome } from "./helpers.js";

describe("RegistryStore — full-shape round trip", () => {
  const home = scratchHome();
  const { db, close } = openNanitesDb(home);
  const registry = new RegistryStore(db);

  it("writes and reads back a full registry entry", () => {
    registry.upsert("main", {
      model_id: "qwen3.5-0.8b",
      roles: ["code", "formatting", "summary"],
      scores: { quality: 8, latency: 9 },
      best_params: { temperature: 0.3, context_length: 4096 },
      last_tested: "2026-08-30T10:00:00.000Z",
    });
    const read = registry.get("main", "qwen3.5-0.8b");
    expect(read).toMatchObject({
      model_id: "qwen3.5-0.8b",
      roles: ["code", "formatting", "summary"],
      scores: { quality: 8, latency: 9 },
      best_params: { temperature: 0.3, context_length: 4096 },
      last_tested: "2026-08-30T10:00:00.000Z",
    });
    expect(read?.created_at).toBeTruthy();
    expect(read?.updated_at).toBeTruthy();
  });

  it("upsert is per-profile scoped", () => {
    registry.upsert("main", { model_id: "only-main", roles: [], scores: {}, best_params: {}, last_tested: null });
    expect(registry.get("other", "only-main")).toBeNull();
    expect(registry.list("main").map((e) => e.model_id)).toContain("only-main");
  });

  it("list returns entries sorted by model_id", () => {
    const ids = registry.list("main").map((e) => e.model_id);
    expect(ids).toEqual([...ids].sort());
  });

  it("remove deletes and reports success", () => {
    expect(registry.remove("main", "only-main")).toBe(true);
    expect(registry.get("main", "only-main")).toBeNull();
    expect(registry.remove("main", "only-main")).toBe(false);
  });

  it("call log insert/list/totals round trip", () => {
    const calls = new CallLogStore(db);
    const id = calls.insert({
      profile_name: "main",
      model_id: "qwen3.5-0.8b",
      task: "format this docstring",
      tokens_in: 120,
      tokens_out: 40,
      duration_ms: 1500,
      cost_usd: 0.0003,
    });
    expect(id).toBeGreaterThan(0);
    const rows = calls.list("main");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tokens_in: 120, tokens_out: 40, duration_ms: 1500, cost_usd: 0.0003 });
    const totals = calls.totals("main");
    expect(totals).toMatchObject({ calls: 1, tokens_in: 120, tokens_out: 40 });
  });

  it("test-result insert -> pending -> judged -> approved lifecycle", () => {
    const results = new TestResultStore(db);
    const id = results.insert({
      profile_name: "main",
      model_id: "qwen3.5-0.8b",
      unit_id: "task1-instruction-following",
      status: "pending",
      raw_output: "cleaned output...",
    });
    expect(id).toBeGreaterThan(0);
    expect(results.listPending("main", "qwen3.5-0.8b")).toHaveLength(1);

    // User has not approved yet -> stays judged, not final.
    results.submitJudgment("main", "qwen3.5-0.8b", "task1-instruction-following", {
      score: 7,
      orchestrator_notes: "followed, minor drift",
      user_approved: false,
    });
    const judged = results.get("main", "qwen3.5-0.8b", "task1-instruction-following");
    expect(judged?.status).toBe("judged");
    expect(judged?.user_approved).toBe(false);

    // Approval promotes to final.
    results.submitJudgment("main", "qwen3.5-0.8b", "task1-instruction-following", {
      score: 8,
      orchestrator_notes: "followed, minor drift",
      user_approved: true,
      user_notes: "bumped for accuracy",
    });
    const approved = results.get("main", "qwen3.5-0.8b", "task1-instruction-following");
    expect(approved?.status).toBe("approved");
    expect(approved?.user_approved).toBe(true);
    expect(approved?.user_notes).toBe("bumped for accuracy");
    expect(results.listPending("main", "qwen3.5-0.8b")).toHaveLength(0);
  });

  afterAll(() => {
    close();
    cleanup(home);
  });
});
