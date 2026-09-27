import { describe, it, expect } from "vitest";
import { createContextHarness, detJsonUnit } from "./helpers.js";

const neverHasContextLength = (bodies: Array<Record<string, unknown>>): boolean =>
  bodies.every((b) => !("context_length" in b));

describe("phase36 regimen context acquisition (ascending + clamp + fail-loud)", () => {
  it("reloads upward only, never per chat, and never sends context_length on a chat body", async () => {
    const h = await createContextHarness({ models: [{ key: "m", max_context_length: 32768 }] });
    try {
      h.addUnit(detJsonUnit("ctxA4000", 4000, "produce {} for ctxA4000"));
      h.addUnit(detJsonUnit("ctxB16000", 16000, "produce {} for ctxB16000"));
      const summary = await h.runRegimen("m");

      expect(summary.deterministic_scored).toBe(2);
      expect(summary.failed_empty_units).toEqual([]);
      expect(summary.clamped_units).toEqual([]);
      // Load once at the first unit's context, then UPWARD once for the 16K unit.
      expect(h.counts.loads).toBe(2);
      expect(h.counts.unloads).toBe(2);
      expect(h.counts.loadCtxs).toEqual([4000, 16000]);
      // baseline + variant per unit = 4 chats, none carrying context_length.
      expect(h.counts.chats).toBe(4);
      expect(neverHasContextLength(h.counts.chatBodies)).toBe(true);
      expect(h.deps.registry.get("t", "m")).not.toBeNull();
    } finally {
      await h.close();
    }
  });

  it("reuses a user-loaded resident whose context already covers every unit — zero loads, zero unloads", async () => {
    const h = await createContextHarness({
      models: [{ key: "m", max_context_length: 32768, resident_ctx: 16000 }],
    });
    try {
      h.addUnit(detJsonUnit("u4000", 4000, "produce {} for u4000"));
      h.addUnit(detJsonUnit("u8000", 8000, "produce {} for u8000"));
      const summary = await h.runRegimen("m");

      expect(summary.deterministic_scored).toBe(2);
      expect(h.counts.loads).toBe(0);
      expect(h.counts.unloads).toBe(0);
      expect(h.counts.chats).toBe(4);
      // The resident survives untouched (never torn down).
      expect(h.loadedNow()).toEqual([{ model: "m", id: "m-resident", ctx: 16000 }]);
    } finally {
      await h.close();
    }
  });

  it("clamps an over-recommended context to the model ceiling and surfaces it in the attempt detail", async () => {
    const h = await createContextHarness({ models: [{ key: "m", max_context_length: 1024 }] });
    try {
      h.addUnit(detJsonUnit("u2000", 2000, "produce {} for u2000"));
      const summary = await h.runRegimen("m");

      expect(summary.deterministic_scored).toBe(1);
      expect(h.counts.loads).toBe(1);
      expect(h.counts.unloads).toBe(1);
      expect(h.counts.loadCtxs).toEqual([1024]);
      expect(summary.clamped_units).toEqual([{ unit_id: "u2000", requested: 2000, used: 1024 }]);
      const rows = h.deps.paramSearch.list("t", "m");
      expect(rows.filter((r) => r.unit_id === "u2000").length).toBe(2);
      for (const r of rows.filter((row) => row.unit_id === "u2000")) {
        expect(r.detail).toContain("clamped_context:2000->1024");
      }
      expect(neverHasContextLength(h.counts.chatBodies)).toBe(true);
    } finally {
      await h.close();
    }
  });

  it("empty-after-retry unit is marked failed — no approved row, EMPTY_OUTPUT logged, not a silent 0", async () => {
    const h = await createContextHarness({
      models: [{ key: "m", max_context_length: 32768 }],
      reply: (prompt) => (prompt.includes("uempty") ? "" : '{"ok":true}'),
    });
    try {
      h.addUnit(detJsonUnit("uok", 4000, "produce {} for uok"));
      h.addUnit(detJsonUnit("uempty", 4000, "produce {} for uempty"));
      const summary = await h.runRegimen("m");

      // Good unit scored; empty unit left untested (never approved as 0).
      expect(summary.deterministic_scored).toBe(1);
      expect(summary.failed_empty_units).toEqual(["uempty"]);
      // 2 candidates for uok (1 chat each) + 2 candidates for uempty (initial + retry).
      expect(h.counts.chats).toBe(2 + 2 * 2);
      expect(h.deps.testResults.list("t", "m").filter((r) => r.unit_id === "uempty")).toEqual([]);
      expect(h.deps.testResults.list("t", "m").filter((r) => r.unit_id === "uok")).toHaveLength(1);
      const rows = h.deps.paramSearch.list("t", "m");
      const emptyAttempts = rows.filter((r) => r.unit_id === "uempty");
      expect(emptyAttempts.length).toBe(2);
      for (const r of emptyAttempts) expect(r.detail.startsWith("EMPTY_OUTPUT")).toBe(true);
    } finally {
      await h.close();
    }
  });

  it("all-output-empty run aborts with all_output_empty and never touches the registry", async () => {
    const h = await createContextHarness({
      models: [{ key: "m", max_context_length: 32768 }],
      reply: () => "",
    });
    try {
      h.addUnit(detJsonUnit("uonly", 4000, "produce {} for uonly"));
      await expect(h.runRegimen("m")).rejects.toMatchObject({
        code: "all_output_empty",
        retryable: true,
      });
      // Nothing scored, nothing recorded, nothing finalized — but the load
      // it made is torn down exactly once.
      expect(h.counts.loads).toBe(1);
      expect(h.counts.unloads).toBe(1);
      expect(h.deps.registry.get("t", "m")).toBeNull();
      expect(h.deps.testResults.list("t", "m")).toEqual([]);
      expect(h.loadedNow()).toEqual([]);
    } finally {
      await h.close();
    }
  });
});
