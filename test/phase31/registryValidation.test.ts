/**
 * Phase 31 (E gate) — item 6: write_registry_entry validation (E5-side). The
 * write path is the one way to bypass finalize, so it must reject unit-keyed
 * scores, unknown role keys, and out-of-range values with a structured
 * registry_entry_invalid error — and accept role-keyed entries, including roles
 * a profile's registered custom units added to the vocabulary (never a hard
 * close to the ten built-ins).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type CallResult, type ToolHarness } from "../phase5/helpers.js";
import { judgedUnit } from "./helpers.js";

function expectInvalid(res: CallResult): void {
  expect(res.ok).toBe(false);
  expect(res.error?.code).toBe("registry_entry_invalid");
}

describe("Phase 31 — write_registry_entry role-vocabulary validation", () => {
  let h: ToolHarness;

  beforeAll(async () => {
    h = await createHarness();
    // Add a custom role to the profile's vocabulary via a registered test unit.
    h.deps.testUnits.register("t", judgedUnit({ id: "sweeper-u", applicable_roles: ["sweeper"] }));
  });
  afterAll(async () => {
    await h.close();
  });

  it("accepts role-keyed entries, including roles added by registered custom units", async () => {
    const res = await h.callTool("write_registry_entry", {
      profile: "t",
      model_id: "m-sweep",
      entry: { roles: ["sweeper"], scores: { sweeper: 88 } },
    });
    expect(res.ok).toBe(true);
    const stored = h.deps.registry.get("t", "m-sweep");
    expect(stored?.roles).toEqual(["sweeper"]);
    expect(stored?.scores.sweeper).toBe(88);
    expect(stored?.score_minima?.sweeper).toBe(88); // single-sample floor auto-filled
    // A valid entry reads back unchanged — the lazy backfill is a no-op.
    const read = await h.callTool("read_registry", { profile: "t", model_id: "m-sweep" });
    expect((read.data as { entries: Array<Record<string, unknown>> }).entries[0]!.roles).toEqual(["sweeper"]);
  });

  it("rejects unit-keyed scores (a unit id is not a role)", async () => {
    const res = await h.callTool("write_registry_entry", {
      profile: "t",
      model_id: "m-x",
      entry: { roles: ["reviewer"], scores: { reviewer: 80, "task2-extraction-easy": 70 } },
    });
    expectInvalid(res);
    expect(res.error!.message).toMatch(/unknown role\/unit key/);
    expect(h.deps.registry.get("t", "m-x")).toBeNull();
  });

  it("rejects unknown role keys in roles", async () => {
    const res = await h.callTool("write_registry_entry", {
      profile: "t",
      model_id: "m-x",
      entry: { roles: ["reviewer", "nonexistent"], scores: { reviewer: 60 } },
    });
    expectInvalid(res);
    expect(res.error!.message).toMatch(/not a role/);
  });

  it("rejects out-of-range scores and score_minima values", async () => {
    const over = await h.callTool("write_registry_entry", {
      profile: "t",
      model_id: "m-x",
      entry: { roles: ["reviewer"], scores: { reviewer: 150 } },
    });
    expectInvalid(over);
    expect(over.error!.message).toMatch(/0-100/);

    const under = await h.callTool("write_registry_entry", {
      profile: "t",
      model_id: "m-x",
      entry: { roles: ["reviewer"], scores: { reviewer: 60 }, score_minima: { reviewer: -1 } },
    });
    expectInvalid(under);
  });
});
