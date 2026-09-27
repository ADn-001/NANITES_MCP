/**
 * Phase 27 gate — Phase A of the systemic-fixes spec: the additive `hold`
 * option on `runSubAgent`. Default behavior (no `hold`) is unchanged; when a
 * call loads the model AND `hold` is passed, teardown is skipped and the warm
 * instance is handed to the caller (via the response's `held_instance_id` and
 * the `instance_id_out` callback), leaving ownership to whoever asked for the
 * hold. Driven through the phase8 stateful mock harness.
 */
import { describe, expect, it } from "vitest";
import { createSubAgentHarness } from "../phase8/helpers.js";
import type { RegistryEntry } from "../../src/storage/registryStore.js";
import type { ToolDeps } from "../../src/tools/deps.js";

const GEM = "lmstudio-community/gemma-3-270m-it-qat";
const OSS = "openai/gpt-oss-20b";
const QWEN = "qwen/qwen3-vl-4b";

async function rejection(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected promise to reject");
}

function holdEvents(h: { deps: ToolDeps }) {
  return h.deps.subAgentEvents.listSince("t", 0).filter((e) => e.phase === "model_hold.start");
}

describe("Phase 27 gate — hold keeps the loaded instance warm", () => {
  it("hold: skips teardown, keeps the instance resident, and hands the id to the caller", async () => {
    const h = await createSubAgentHarness();
    const received: string[] = [];
    const res = await h.runAgent({ model_id: OSS, hold: { instance_id_out: (id) => received.push(id), max_hold_ms: 5000 } });

    expect(res.loaded_this_call).toBe(true);
    expect(res.unloaded).toBe(false);
    expect(res.held_instance_id).toBe(res.instance_id);
    expect(res.held_instance_id).toBeTruthy();
    expect(received).toEqual([res.instance_id]);
    // The mock's instance_id equals the model key; the instance is still resident.
    expect(h.loaded.has(OSS)).toBe(true);
    expect(h.counts.loads).toBe(1);
    expect(h.counts.unloads).toBe(0);
    await h.close();
  });

  it("hold: records a model_hold.start event carrying the advisory max_hold_ms", async () => {
    const h = await createSubAgentHarness();
    const res = await h.runAgent({ model_id: OSS, hold: { max_hold_ms: 5000 } });

    const holds = holdEvents(h);
    expect(holds).toHaveLength(1);
    expect(holds[0]!.payload.instance_id).toBe(res.held_instance_id);
    expect(holds[0]!.payload.max_hold_ms).toBe(5000);
    await h.close();
  });

  it("no hold: default teardown unchanged, no held_instance_id, no hold event", async () => {
    const h = await createSubAgentHarness();
    const res = await h.runAgent({ model_id: OSS });

    expect(res.unloaded).toBe(true);
    expect(res.held_instance_id).toBeUndefined();
    expect(h.counts.loads).toBe(1);
    expect(h.counts.unloads).toBe(1);
    expect(h.loaded.has(OSS)).toBe(false);
    expect(holdEvents(h)).toHaveLength(0);
    await h.close();
  });

  it("hold on an already-resident model has nothing to hand off", async () => {
    const h = await createSubAgentHarness({
      initiallyLoaded: [GEM],
      registry: [{ model_id: GEM, roles: ["summarizer"], scores: { summarizer: 80 }, best_params: {}, last_tested: null } as RegistryEntry],
    });
    const res = await h.runAgent({ roles: ["summarizer"], hold: {} });

    expect(res.loaded_this_call).toBe(false);
    expect(res.held_instance_id).toBeUndefined();
    expect(h.counts.loads).toBe(0);
    expect(h.counts.unloads).toBe(0);
    expect(h.loaded.has(GEM)).toBe(true); // stays resident either way
    expect(holdEvents(h)).toHaveLength(0);
    await h.close();
  });

  it("a later normal acquisition evicts the held instance as an ordinary occupant", async () => {
    const h = await createSubAgentHarness();
    const held = await h.runAgent({ model_id: OSS, hold: {} });
    expect(held.held_instance_id).toBeTruthy();
    expect(h.counts.unloads).toBe(0);

    // Sequential tier (vram 4): the next call needs the slot, so the held
    // instance is evicted exactly like any other idle occupant.
    const res = await h.runAgent({ model_id: QWEN });
    expect(res.evicted_instance_ids).toEqual([held.held_instance_id]);
    expect(res.loaded_this_call).toBe(true);
    expect(res.unloaded).toBe(true);
    expect(h.counts.unloads).toBe(2); // eviction of the held instance + teardown of QWEN
    expect(h.loaded.has(OSS)).toBe(false);
    await h.close();
  });

  it("hold on a failed call still keeps the instance resident and notifies the caller", async () => {
    const h = await createSubAgentHarness({ chatFail: true });
    const received: string[] = [];
    await rejection(() => h.runAgent({ model_id: OSS, hold: { instance_id_out: (id) => received.push(id) } }));

    // Ownership transferred even though the run failed: the holder (its own
    // finally) is responsible for the warm instance.
    expect(h.counts.loads).toBe(1);
    expect(h.counts.unloads).toBe(0);
    expect(h.loaded.has(OSS)).toBe(true);
    expect(received).toHaveLength(1);
    await h.close();
  });
});
