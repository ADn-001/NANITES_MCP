import { describe, it, expect } from "vitest";
import { createContextHarness, detJsonUnit, waitFor } from "./helpers.js";

const at = (h: { pushes: Array<{ body: string }> }, i: number): string => h.pushes[i]!.body;

describe("phase36 auto-ntfy workflow pushes", () => {
  it("topic-null profile never touches the network (fire-and-forget short circuit)", async () => {
    const h = await createContextHarness({
      models: [{ key: "m", max_context_length: 32768 }],
      ntfy: { topic: null },
    });
    try {
      h.addUnit(detJsonUnit("uok", 4000, "produce {} for uok"));
      await h.runRegimen("m");
      // Let any hypothetical (buggy) push land before asserting zero.
      await new Promise((r) => setTimeout(r, 300));
      expect(h.pushes).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it("a regimen on a configured topic pushes regimen.start then regimen.end in order", async () => {
    const h = await createContextHarness({
      models: [{ key: "m", max_context_length: 32768 }],
      ntfy: { topic: "nanites-test" },
    });
    try {
      h.addUnit(detJsonUnit("uok", 4000, "produce {} for uok"));
      await h.runRegimen("m");
      await waitFor(() => h.pushes.length >= 2);
      expect(h.pushes).toHaveLength(2);
      expect(at(h, 0)).toContain("testing m");
      expect(at(h, 1)).toContain("m regimen done");
    } finally {
      await h.close();
    }
  });

  it("run_untested_sweep pushes sprint.start before the per-model regimen notifs and sprint.end last", async () => {
    const h = await createContextHarness({
      models: [
        { key: "m1", max_context_length: 32768, size_bytes: 1_000_000_000 },
        { key: "m2", max_context_length: 32768, size_bytes: 2_000_000_000 },
      ],
      ntfy: { topic: "nanites-test" },
    });
    try {
      // One shared unit so each model's regimen is a quick single-unit run
      // (and the default 10-unit regimen never auto-registers).
      h.addUnit(detJsonUnit("g", 4000, "produce {} for g"));
      const result = await h.runSweep();
      expect(result.summaries).toHaveLength(2);
      expect(result.failures).toEqual([]);
      await waitFor(() => h.pushes.length >= 6);

      const bodies = h.pushes.map((p) => p.body);
      const find = (needle: string, from = 0): number => bodies.findIndex((b, i) => i >= from && b.includes(needle));
      const iStart = find("untested sweep starting");
      const iM1Start = find("testing m1", iStart);
      const iM1End = find("m1 regimen done", iM1Start);
      const iM2Start = find("testing m2", iM1End);
      const iM2End = find("m2 regimen done", iM2Start);
      const iDone = find("untested sweep done", iM2End);
      expect(iStart).toBeGreaterThanOrEqual(0);
      expect(iM1Start).toBeGreaterThan(iStart);
      expect(iM1End).toBeGreaterThan(iM1Start);
      expect(iM2Start).toBeGreaterThan(iM1End);
      expect(iM2End).toBeGreaterThan(iM2Start);
      expect(iDone).toBeGreaterThan(iM2End);
      expect(iDone).toBe(bodies.length - 1);
    } finally {
      await h.close();
    }
  });
});
