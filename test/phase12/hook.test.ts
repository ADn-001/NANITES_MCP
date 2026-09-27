import { describe, expect, it } from "vitest";
import { createSubAgentHarness } from "../phase8/helpers.js";

const MODEL = "lmstudio-community/gemma-3-270m-it-qat";

describe("Phase 12 hook — runSubAgent telemetry + performance scorer", () => {
  it("successful run writes telemetry and recomputes performance_score", async () => {
    const h = await createSubAgentHarness({
      vramGb: 4,
      initiallyLoaded: [MODEL],
      registry: [{ model_id: MODEL, roles: ["reviewer"], scores: { "task6-code-review-easy": 90 }, best_params: {}, last_tested: "x" }],
    });
    try {
      const res = await h.runAgent({ model_id: MODEL, roles: ["reviewer"] });
      expect(res.performance_score).toBeGreaterThanOrEqual(1);
      expect(res.performance_score).toBeLessThanOrEqual(100);

      const entry = h.deps.registry.get("t", MODEL);
      expect(typeof entry!.performance_score).toBe("number");

      const calls = h.deps.callLogs.list("t", 10);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.error_code).toBeNull();
      expect(calls[0]!.ttft_ms).toBe(814); // fixture time_to_first_token_seconds = 0.814s
    } finally {
      await h.close();
    }
  });

  it("failed chat logs error_code and does not rewrite the score", async () => {
    const h = await createSubAgentHarness({
      vramGb: 4,
      initiallyLoaded: [MODEL],
      chatFail: true,
      registry: [{ model_id: MODEL, roles: ["reviewer"], scores: { "task6-code-review-easy": 90 }, best_params: {}, last_tested: "x", performance_score: 77 }],
    });
    try {
      await expect(h.runAgent({ model_id: MODEL, roles: ["reviewer"] })).rejects.toThrow();

      const entry = h.deps.registry.get("t", MODEL);
      expect(entry!.performance_score).toBe(77); // unchanged — no rewrite on failure

      const calls = h.deps.callLogs.list("t", 10);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.error_code).toBeTruthy();
    } finally {
      await h.close();
    }
  });
});
