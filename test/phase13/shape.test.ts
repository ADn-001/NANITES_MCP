import { describe, expect, it } from "vitest";
import { createSubAgentHarness } from "../phase8/helpers.js";

const MODEL = "lmstudio-community/gemma-3-270m-it-qat";

describe("Phase 13 — run_sub_agent response shape", () => {
  it("returns the enriched metrics + performance_score with camelCase token_usage", async () => {
    const h = await createSubAgentHarness({
      vramGb: 4,
      initiallyLoaded: [MODEL],
      registry: [{ model_id: MODEL, roles: ["reviewer"], scores: { "task6-code-review-easy": 90 }, best_params: {}, last_tested: "x" }],
    });
    try {
      const res = await h.runAgent({ model_id: MODEL, roles: ["reviewer"] });
      expect(typeof res.reply).toBe("string");
      expect(res.reply.length).toBeGreaterThan(0);

      expect(typeof res.metrics.load_ms).toBe("number");
      expect(typeof res.metrics.infer_ms).toBe("number");
      expect(typeof res.metrics.ttft_ms).toBe("number");
      expect(typeof res.metrics.t_s).toBe("number");

      expect(typeof res.performance_score).toBe("number");
      expect(typeof res.token_usage.inputTokens).toBe("number");
      expect(typeof res.token_usage.outputTokens).toBe("number");
      expect(typeof res.token_usage.reasoningTokens).toBe("number");
    } finally {
      await h.close();
    }
  });

  it("payload delta from the pre-Phase-13 shape stays within the token budget", async () => {
    const h = await createSubAgentHarness({
      vramGb: 4,
      initiallyLoaded: [MODEL],
      registry: [{ model_id: MODEL, roles: ["reviewer"], scores: { "task6-code-review-easy": 90 }, best_params: {}, last_tested: "x" }],
    });
    try {
      const res = await h.runAgent({ model_id: MODEL, roles: ["reviewer"] });
      const full = JSON.stringify(res);
      const preShape = JSON.stringify({ ...res, metrics: undefined, performance_score: undefined });
      const deltaChars = full.length - preShape.length;
      // ~30 tokens at ~4 chars/token ≈ 120 chars ceiling.
      expect(deltaChars).toBeLessThanOrEqual(120);
    } finally {
      await h.close();
    }
  });
});
