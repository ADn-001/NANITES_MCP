/**
 * Phase 47 gate — cloud request correctness, pinned to the
 * live measurements recorded against this endpoint:
 *
 * - A reasoning model spends its whole budget on the reasoning field before
 *   emitting content, so the ceiling must be large enough to hold both.
 *   Measured: 4096 -> empty content + finish_reason "length" (qwen3-30b) or a
 *   truncated answer (gpt-oss-120b); 16384 -> finish_reason "stop" with content.
 *   The low tier therefore starts at 8192 — a cap is a stop, not a spend.
 * - Cloudflare accepts `reasoning_effort` and honours "low" by suppressing
 *   default-on thinking (reasoning field 7989 -> 90 chars on the same brief).
 * - `chat_template_kwargs.enable_thinking=false` measured unreliable (ignored
 *   by gpt-oss; empty content with finish_reason "stop" on qwen3) — we must
 *   never send it.
 * - `max_tokens` and `max_completion_tokens` behave identically on the current
 *   endpoint; Cloudflare gets the non-deprecated name.
 */
import { describe, expect, it } from "vitest";
import { buildCloudChatRequest, planCloudInference } from "../../src/providers/cloudPlanner.js";
import type { ChatMessage } from "../../src/providers/types.js";

const msgs: ChatMessage[] = [{ role: "user", content: "hi" }];

describe("Phase 47 — cloud budget ceiling", () => {
  it("gives every effort tier enough room for reasoning plus an answer", () => {
    expect(planCloudInference("low", "reviewer").max_output_tokens).toBe(12_288);
    expect(planCloudInference("medium", "reviewer").max_output_tokens).toBe(16_384);
    expect(planCloudInference("high", "reviewer").max_output_tokens).toBe(32_768);
  });

  it("never returns a budget the measured reasoning spend can exhaust", () => {
    // qwen3-30b burned a full 4096 on reasoning and returned empty content; at
    // 8192 it answered but consumed 7,601, leaving almost no headroom.
    for (const effort of ["low", "medium", "high"] as const) {
      expect(planCloudInference(effort, "reviewer").max_output_tokens).toBeGreaterThanOrEqual(12_288);
    }
  });
});

describe("Phase 47 — Cloudflare request shape", () => {
  it("sends max_completion_tokens, never the deprecated max_tokens", () => {
    const plan = planCloudInference("medium", "reviewer");
    const req = buildCloudChatRequest(plan, "cloudflare", "@cf/openai/gpt-oss-120b", msgs);
    expect(req.max_completion_tokens).toBe(16_384);
    expect(req.max_tokens).toBeUndefined();
  });

  it("always sends reasoning_effort, using low to suppress default-on thinking", () => {
    const off = buildCloudChatRequest(planCloudInference("low", "reviewer"), "cloudflare", "@cf/x", msgs);
    expect(off.reasoning_effort).toBe("low");

    const on = buildCloudChatRequest(planCloudInference("medium", "reviewer"), "cloudflare", "@cf/x", msgs);
    expect(on.reasoning_effort).toBe("medium");

    const high = buildCloudChatRequest(planCloudInference("high", "reviewer"), "cloudflare", "@cf/x", msgs);
    expect(high.reasoning_effort).toBe("high");
  });

  it("never sends chat_template_kwargs (measured unreliable)", () => {
    for (const effort of ["low", "medium", "high"] as const) {
      const req = buildCloudChatRequest(planCloudInference(effort, "reviewer"), "cloudflare", "@cf/x", msgs);
      expect(req.chat_template_kwargs).toBeUndefined();
    }
  });

  it("never sends the raw nanites reasoning string", () => {
    const req = buildCloudChatRequest(planCloudInference("medium", "reviewer"), "cloudflare", "@cf/x", msgs);
    expect(req.reasoning).toBeUndefined();
  });
});

describe("Phase 47 — other providers keep their own shape", () => {
  it("openrouter still sends the reasoning object and max_tokens", () => {
    const req = buildCloudChatRequest(planCloudInference("medium", "reviewer"), "openrouter", "m", msgs);
    expect(req.reasoning).toEqual({ effort: "medium" });
    expect(req.max_tokens).toBe(16_384);
    expect(req.max_completion_tokens).toBeUndefined();
    expect(req.reasoning_effort).toBeUndefined();
  });

  it("generic and omniroute still send reasoning_effort only when reasoning is on", () => {
    const on = buildCloudChatRequest(planCloudInference("medium", "reviewer"), "generic", "m", msgs);
    expect(on.reasoning_effort).toBe("medium");
    expect(on.max_tokens).toBe(16_384);

    const off = buildCloudChatRequest(planCloudInference("low", "reviewer"), "generic", "m", msgs);
    expect(off.reasoning_effort).toBeUndefined();
  });
});
