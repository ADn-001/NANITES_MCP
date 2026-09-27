/**
 * Phase 8 gate — Workflow #2 sub-agent spin-up/teardown (test suite items
 * 8-1..8-5). Drives a stateful mock whose loaded-models view reflects live
 * load/unload calls, so acquire policy, unload-once-on-every-path, and the
 * exactly-one-token-log contract are asserted against endpoint behavior, not
 * fixtures.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSubAgentHarness, type SubAgentHarness } from "./helpers.js";
import { SubAgentPool } from "../../src/workflows/subAgentPool.js";
import type { RegistryEntry } from "../../src/storage/registryStore.js";

const GEM = "lmstudio-community/gemma-3-270m-it-qat";
const OSS = "openai/gpt-oss-20b";
const QWEN = "qwen/qwen3-vl-4b";

function entry(modelId: string, roles: string[], scores: Record<string, number>): RegistryEntry {
  return { model_id: modelId, roles, scores, best_params: {}, last_tested: null };
}

async function rejection(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected promise to reject");
}

describe("Phase 8 gate — role lookup and model selection", () => {
  it("exact role match resolves, loads, runs, unloads", async () => {
    const h = await createSubAgentHarness({ registry: [entry(OSS, ["code_qa", "reviewer"], { code_qa: 90 })] });
    const res = await h.runAgent({ roles: ["code_qa"] });
    expect(res.model_id).toBe(OSS);
    expect(res.role).toBe("code_qa");
    expect(res.loaded_this_call).toBe(true);
    expect(res.unloaded).toBe(true);
    expect(res.reply).toBe("done");
    expect(h.counts.loads).toBe(1);
    expect(h.counts.unloads).toBe(1);
    expect(h.counts.chats).toBe(1);
    await h.close();
  });

  it("same tier: highest best-score entry wins", async () => {
    const h = await createSubAgentHarness({
      registry: [entry(OSS, ["code_qa"], { code_qa: 90 }), entry(QWEN, ["code_qa"], { code_qa: 95 })],
    });
    const res = await h.runAgent({ roles: ["code_qa"] });
    expect(res.model_id).toBe(QWEN);
    await h.close();
  });

  it("partial role overlap is a documented fallback", async () => {
    const h = await createSubAgentHarness({ registry: [entry(OSS, ["code_qa", "reviewer"], { code_qa: 90 })] });
    const res = await h.runAgent({ roles: ["code reviewer"] });
    expect(res.model_id).toBe(OSS);
    expect(res.role).toBe("code_qa");
    await h.close();
  });

  it("no registry match: structured no_model_for_role, no model touched, no token log", async () => {
    const h = await createSubAgentHarness({ registry: [] });
    const err = await rejection(() => h.runAgent({ roles: ["poet"] }));
    expect((err as { code?: string }).code).toBe("no_model_for_role");
    expect(h.counts.loads).toBe(0);
    expect(h.counts.unloads).toBe(0);
    expect(h.deps.callLogs.list("t")).toHaveLength(0);
    await h.close();
  });
});

describe("Phase 8 gate — acquire policy", () => {
  it("already-loaded correct model is reused, never loaded or unloaded", async () => {
    const h = await createSubAgentHarness({
      initiallyLoaded: [GEM],
      registry: [entry(GEM, ["summarizer"], { summarizer: 80 })],
    });
    const res = await h.runAgent({ roles: ["summarizer"] });
    expect(res.model_id).toBe(GEM);
    expect(res.loaded_this_call).toBe(false);
    expect(res.unloaded).toBe(false);
    expect(h.counts.loads).toBe(0);
    expect(h.counts.unloads).toBe(0);
    expect(h.loaded.get(GEM)).toBe(GEM); // still resident after the call
    await h.close();
  });

  it("sequential tier evicts the wrong occupant, then loads and unloads the chosen model", async () => {
    const h = await createSubAgentHarness({
      initiallyLoaded: [GEM],
      registry: [entry(GEM, ["summarizer"], { summarizer: 80 }), entry(OSS, ["code_qa"], { code_qa: 90 })],
    });
    const res = await h.runAgent({ roles: ["code_qa"] });
    expect(res.model_id).toBe(OSS);
    expect(res.evicted_instance_ids).toEqual([GEM]);
    expect(res.loaded_this_call).toBe(true);
    expect(res.unloaded).toBe(true);
    // GEM evicted to make room + OSS unloaded on teardown.
    expect(h.counts.loads).toBe(1);
    expect(h.counts.unloads).toBe(2);
    await h.close();
  });

  it("parallel tier at capacity refuses a new model without touching the loaded set", async () => {
    const h = await createSubAgentHarness({ vramGb: 16, initiallyLoaded: [GEM, OSS] }); // high tier, max 2
    const err = await rejection(() => h.runAgent({ model_id: QWEN }));
    expect((err as { code?: string }).code).toBe("concurrency_limit");
    expect((err as { retryable?: boolean }).retryable).toBe(true);
    expect(h.counts.loads).toBe(0);
    expect(h.counts.unloads).toBe(0);
    expect([...h.loaded.keys()].sort()).toEqual([GEM, OSS].sort());
    await h.close();
  });
});

describe("Phase 8 gate — unload exactly once on every path", () => {
  it("success: unload fires exactly once", async () => {
    const h = await createSubAgentHarness();
    const res = await h.runAgent({ model_id: OSS });
    expect(res.unloaded).toBe(true);
    expect(h.counts.loads).toBe(1);
    expect(h.counts.unloads).toBe(1);
    await h.close();
  });

  it("chat failure: abort, unload fires exactly once", async () => {
    const h = await createSubAgentHarness({ chatFail: true });
    await rejection(() => h.runAgent({ model_id: OSS }));
    expect(h.counts.loads).toBe(1);
    expect(h.counts.unloads).toBe(1);
    await h.close();
  });

  it("timeout: abort, unload fires exactly once", async () => {
    const h = await createSubAgentHarness({ chatDelayMs: 300 });
    const err = await rejection(() => h.runAgent({ model_id: OSS, clientTimeoutMs: 100 }));
    expect(err.message).toMatch(/timed out/i);
    expect(h.counts.loads).toBe(1);
    expect(h.counts.unloads).toBe(1);
    await h.close();
  });

  it("load failure: no instance, no unload attempted", async () => {
    const h = await createSubAgentHarness({ loadFail: true });
    const err = await rejection(() => h.runAgent({ model_id: OSS }));
    expect(err.message).toMatch(/HTTP 500/i);
    expect(h.counts.loads).toBe(1);
    expect(h.counts.unloads).toBe(0);
    await h.close();
  });
});

describe("Phase 8 gate — token logging", () => {
  it("exactly one call-log entry with authoritative stats on success", async () => {
    const h = await createSubAgentHarness();
    const res = await h.runAgent({ model_id: OSS, task: "summarize the diff" });
    const logs = h.deps.callLogs.list("t");
    expect(logs).toHaveLength(1);
    expect(res.call_log_id).toBe(logs[0]!.id);
    expect(logs[0]!.model_id).toBe(OSS);
    expect(logs[0]!.task).toBe("summarize the diff");
    expect(logs[0]!.tokens_in).toBe(17); // chatResponseFixture stats
    expect(logs[0]!.tokens_out).toBe(50);
    expect(logs[0]!.cost_usd).toBeGreaterThan(0);
    await h.close();
  });

  it("failure path still logs exactly one entry with an estimate", async () => {
    const h = await createSubAgentHarness({ chatFail: true });
    await rejection(() => h.runAgent({ model_id: OSS }));
    const logs = h.deps.callLogs.list("t");
    expect(logs).toHaveLength(1);
    expect(logs[0]!.model_id).toBe(OSS);
    expect(logs[0]!.tokens_in).toBeGreaterThan(0);
    expect(logs[0]!.tokens_out).toBe(0);
    await h.close();
  });

  it("no-model role failure logs nothing", async () => {
    const h = await createSubAgentHarness({ registry: [] });
    await rejection(() => h.runAgent({ roles: ["poet"] }));
    expect(h.deps.callLogs.list("t")).toHaveLength(0);
    await h.close();
  });
});

describe("Phase 8 gate — sub-agent pool enforcement", () => {
  let h: SubAgentHarness;

  beforeEach(async () => {
    h = await createSubAgentHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("a shared pool at capacity refuses with a retryable concurrency_limit", async () => {
    const pool = new SubAgentPool(1);
    expect(pool.tryAcquire()).toBe(true);
    const err = await rejection(() => h.runAgent({ model_id: OSS, pool }));
    expect((err as { code?: string }).code).toBe("concurrency_limit");
    expect((err as { retryable?: boolean }).retryable).toBe(true);
    expect(h.counts.loads).toBe(0);
    pool.release();
  });

  it("the slot is released after a failed call", async () => {
    const h2 = await createSubAgentHarness({ chatFail: true });
    const pool = new SubAgentPool(1);
    await rejection(() => h2.runAgent({ model_id: OSS, pool }));
    expect(pool.activeCount).toBe(0); // released even though the call failed
    expect(pool.tryAcquire()).toBe(true); // slot is genuinely free again
    pool.release();
    await h2.close();
  });

  it("two sequential calls without a shared pool both succeed", async () => {
    const r1 = await h.runAgent({ model_id: OSS });
    const r2 = await h.runAgent({ model_id: QWEN });
    expect(r1.call_log_id).not.toBe(r2.call_log_id);
    expect(h.deps.callLogs.list("t")).toHaveLength(2);
  });
});
