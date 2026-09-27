/**
 * Phase 68 gate — DB hygiene, including the sub_agent_calls index gap.
 *
 * `recentForModel(profile, model, 20)` runs on EVERY run_sub_agent to
 * recompute performance_score, and sub_agent_calls had no index at all, so the
 * cost of a sub-agent call scaled with total history rather than with the 20
 * rows it wanted. The EXPLAIN cases below are the proof.
 *
 * M14: five stores bare-parsed a JSON column on read, so one corrupt cell threw
 * out of the reader. M15: the dashboard is a separate process reading this same
 * file, and the defaults (rollback journal, no busy timeout) serialise them.
 */
import { describe, expect, it } from "vitest";
import { openNanitesDb } from "../../src/storage/db.js";
import { CallLogStore } from "../../src/storage/callLogStore.js";
import { JobStore } from "../../src/storage/jobStore.js";
import { ParamSearchStore } from "../../src/storage/paramSearchStore.js";
import { ProviderModelStore } from "../../src/storage/providerModelStore.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

function harness() {
  const home = scratchHome();
  const { db, close } = openNanitesDb(home);
  return {
    home,
    db,
    close: () => {
      close();
      cleanup(home);
    },
  };
}

describe("sub_agent_calls is indexed (index gap)", () => {
  it("uses an index for the per-run score recompute, not a table scan", () => {
    const h = harness();
    const logs = new CallLogStore(h.db);
    for (let i = 0; i < 50; i++) {
      logs.insert({
        profile_name: "t",
        model_id: "m",
        role: "code",
        loaded: false,
        duration_ms: 5,
        tokens_in: 1,
        tokens_out: 1,
        cost_usd: 0,
      } as never);
    }
    // Exactly the shape recentForModel uses.
    const plan = h.db
      .prepare("EXPLAIN QUERY PLAN SELECT * FROM sub_agent_calls WHERE profile_name = ? AND model_id = ? ORDER BY id DESC LIMIT 20")
      .all("t", "m") as Array<{ detail: string }>;
    const text = JSON.stringify(plan);
    expect(text).toContain("idx_calls_profile_model");
    expect(text).not.toContain('"SCAN sub_agent_calls"');
    h.close();
  });

  it("uses an index for the profile+time ledger query", () => {
    const h = harness();
    const plan = h.db
      .prepare("EXPLAIN QUERY PLAN SELECT * FROM sub_agent_calls WHERE profile_name = ? AND created_at >= ? ORDER BY id DESC LIMIT 100")
      .all("t", "2020-01-01") as Array<{ detail: string }>;
    expect(JSON.stringify(plan)).toContain("idx_calls");
    h.close();
  });
});

describe("a corrupt JSON cell degrades instead of throwing (M14)", () => {
  it("job payload", () => {
    const h = harness();
    const jobs = new JobStore(h.db);
    const id = jobs.create({ kind: "sub_agent", profile_name: "t", payload: { brief: "x" } });
    h.db.prepare("UPDATE jobs SET payload = ? WHERE id = ?").run("{not json", id);
    // Must not throw: a corrupt cell would otherwise take down the job reader.
    expect(() => jobs.get(id)).not.toThrow();
    expect(jobs.get(id)?.payload).toEqual({});
    h.close();
  });

  it("param search params", () => {
    const h = harness();
    const store = new ParamSearchStore(h.db);
    const id = store.log({
      profile_name: "t",
      model_id: "m",
      attempt: 1,
      params: { temperature: 0.2 },
      score: 0.9,
      detail: "",
    } as never);
    h.db.prepare("UPDATE param_search_attempts SET params = ? WHERE id = ?").run("{oops", id);
    expect(() => store.list("t", "m")).not.toThrow();
    h.close();
  });

  it("provider model capabilities", () => {
    const h = harness();
    const store = new ProviderModelStore(h.db);
    store.registerModel("t", "cloudflare", "m", "M");
    h.db.prepare("UPDATE provider_models SET capabilities = ? WHERE model_id = ?").run("not-json", "m");
    expect(() => store.listModels("t")).not.toThrow();
    // The default is a well-formed empty capability set, not undefined.
    const row = store.listModels("t")[0];
    expect(row?.capabilities).toMatchObject({ vision: false, audio: false, video: false, function_calling: false });
    h.close();
  });
});

describe("the connection is configured for a two-process topology (M15)", () => {
  it("uses WAL so a concurrent reader does not block a writer", () => {
    const h = harness();
    const row = h.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(String(row.journal_mode).toLowerCase()).toBe("wal");
    h.close();
  });

  it("sets a busy timeout so a concurrent write waits instead of throwing", () => {
    const h = harness();
    const row = h.db.prepare("PRAGMA busy_timeout").get() as { timeout?: number; busy_timeout?: number };
    const value = Number(row.timeout ?? row.busy_timeout ?? 0);
    expect(value).toBeGreaterThan(0);
    h.close();
  });
});
