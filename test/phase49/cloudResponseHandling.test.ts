/**
 * Phase 49 gate — the cloud router must never hand an empty
 * reply up the stack as if it were an answer.
 *
 * Detection is on **empty content**, not on `finish_reason`: measured live, an
 * empty reply arrives with `finish_reason: "stop"` as well as `"length"`
 * (qwen3 + chat_template_kwargs). A tool-calls-only turn is empty of text but
 * legitimate, so calls count as content.
 *
 * `usage.completion_tokens_details` and `cached_tokens` are always null/0 on
 * this endpoint, so there is no reasoning-token telemetry to assert on.
 */
import { describe, expect, it, vi } from "vitest";
import {
  chatWithBudgetRetry,
  doubleCloudBudget,
  isEmptyCloudReply,
  planCloudInference,
} from "../../src/providers/cloudPlanner.js";
import { parseChatResponse } from "../../src/providers/client.js";
import type { ChatResponse } from "../../src/providers/types.js";

const msgs = [{ role: "user" as const, content: "hi" }];

function reply(partial: Partial<ChatResponse>): ChatResponse {
  return { content: "", ...partial };
}

describe("Phase 49 — empty-reply detection", () => {
  it("treats empty content as a failure under either finish_reason", () => {
    expect(isEmptyCloudReply(reply({ content: "", finish_reason: "length" }))).toBe(true);
    expect(isEmptyCloudReply(reply({ content: "", finish_reason: "stop" }))).toBe(true);
    expect(isEmptyCloudReply(reply({ content: "   ", finish_reason: "stop" }))).toBe(true);
  });

  it("does not treat a tool-calls-only turn as empty", () => {
    const resp = reply({
      content: "",
      tool_calls: [{ id: "c1", name: "read_file", arguments: { path: "a" } }],
    });
    expect(isEmptyCloudReply(resp)).toBe(false);
  });

  it("accepts a normal answer", () => {
    expect(isEmptyCloudReply(reply({ content: "done" }))).toBe(false);
  });
});

describe("Phase 49 — budget retry", () => {
  it("retries exactly once at double the budget, then succeeds", async () => {
    const plan = planCloudInference("medium", "reviewer");
    const send = vi
      .fn<(req: { max_completion_tokens?: number }) => Promise<ChatResponse>>()
      .mockResolvedValueOnce(reply({ content: "", finish_reason: "length" }))
      .mockResolvedValueOnce(reply({ content: "answered", finish_reason: "stop" }));

    const resp = await chatWithBudgetRetry(send as never, plan, "cloudflare", "@cf/x", msgs);

    expect(resp.content).toBe("answered");
    expect(send).toHaveBeenCalledTimes(2);
    const [first, second] = send.mock.calls.map((c) => c[0].max_completion_tokens);
    expect(first).toBe(plan.max_output_tokens);
    expect(second).toBe(plan.max_output_tokens * 2);
  });

  it("raises provider_budget_exhausted when the doubled budget is also empty", async () => {
    const plan = planCloudInference("medium", "reviewer");
    const send = vi.fn().mockResolvedValue(reply({ content: "", finish_reason: "length" }));

    await expect(
      chatWithBudgetRetry(send as never, plan, "cloudflare", "@cf/qwen/qwen3-30b-a3b-fp8", msgs),
    ).rejects.toMatchObject({
      code: "provider_budget_exhausted",
      retryable: false,
      details: { model_id: "@cf/qwen/qwen3-30b-a3b-fp8", attempted_budget: plan.max_output_tokens * 2 },
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("raises on an empty reply that claims finish_reason stop", async () => {
    const plan = planCloudInference("low", "reviewer");
    const send = vi.fn().mockResolvedValue(reply({ content: "", finish_reason: "stop" }));

    await expect(
      chatWithBudgetRetry(send as never, plan, "cloudflare", "@cf/x", msgs),
    ).rejects.toMatchObject({ code: "provider_budget_exhausted" });
  });

  it("does not retry a healthy reply", async () => {
    const send = vi.fn().mockResolvedValue(reply({ content: "ok", finish_reason: "stop" }));
    const resp = await chatWithBudgetRetry(send as never, planCloudInference("low", "reviewer"), "cloudflare", "@cf/x", msgs);

    expect(resp.content).toBe("ok");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("doubles the budget without mutating the original plan", () => {
    const plan = planCloudInference("medium", "reviewer");
    const before = plan.max_output_tokens;
    expect(doubleCloudBudget(plan).max_output_tokens).toBe(before * 2);
    expect(plan.max_output_tokens).toBe(before);
  });
});

describe("Phase 49 — response parsing", () => {
  it("surfaces reasoning_content", () => {
    const resp = parseChatResponse({
      choices: [{ message: { content: "answer", reasoning_content: "thought" }, finish_reason: "stop" }],
    });
    expect(resp.reasoning_content).toBe("thought");
  });

  it("falls back to the reasoning field when reasoning_content is absent", () => {
    const resp = parseChatResponse({
      choices: [{ message: { content: "answer", reasoning: "thought" }, finish_reason: "stop" }],
    });
    expect(resp.reasoning_content).toBe("thought");
    expect(resp.reasoning).toBe("thought");
  });

  it("preserves finish_reason, which the router classifies on", () => {
    const resp = parseChatResponse({ choices: [{ message: { content: "" }, finish_reason: "length" }] });
    expect(resp.finish_reason).toBe("length");
  });

  it("survives a shape it does not recognise", () => {
    const resp = parseChatResponse({});
    expect(resp.content).toBe("");
    expect(resp.tool_calls).toBeUndefined();
  });
});
