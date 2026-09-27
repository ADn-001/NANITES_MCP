/**
 * Phase 48 gate — tool-call protocol conformance for cloud
 * providers.
 *
 * Two things the wire transcript must get right, both verified against the
 * current endpoint:
 *
 * - `role:"tool"` messages carry the tool `name` next to `tool_call_id`.
 * - We echo the model's own `tool_calls[i].id`. We must never mint one: the
 *   provider pairs the answer to the call by id, so a fabricated id orphans it.
 *
 * `parallel_tool_calls` is sent explicitly when tools are advertised, so the
 * loop's N-calls-per-turn handling does not depend on a provider default.
 */
import { describe, expect, it } from "vitest";
import { serializeChatRequest } from "../../src/providers/client.js";
import { buildCloudChatRequest, planCloudInference } from "../../src/providers/cloudPlanner.js";
import type { ChatMessage, ChatToolCall, ProviderToolDef } from "../../src/providers/types.js";

const tool: ProviderToolDef = {
  type: "function",
  function: { name: "read_file", description: "read", parameters: { type: "object" } },
};

describe("Phase 48 — tool message wire shape", () => {
  it("carries name, tool_call_id and the matching output", () => {
    const msgs: ChatMessage[] = [
      { role: "assistant", content: "", tool_calls: [{ id: "call_a", name: "read_file", arguments: { path: "a.ts" } }] },
      { role: "tool", content: "contents of a", tool_call_id: "call_a", name: "read_file" },
    ];
    const wire = serializeChatRequest({ model: "m", messages: msgs }).messages as Array<Record<string, unknown>>;

    expect(wire[1]).toMatchObject({
      role: "tool",
      content: "contents of a",
      tool_call_id: "call_a",
      name: "read_file",
    });
  });

  it("omits name rather than emitting an empty one", () => {
    const msgs: ChatMessage[] = [{ role: "tool", content: "out", tool_call_id: "call_a" }];
    const wire = serializeChatRequest({ model: "m", messages: msgs }).messages as Array<Record<string, unknown>>;

    expect(wire[0]).not.toHaveProperty("name");
  });
});

describe("Phase 48 — parallel calls, ids echoed not minted", () => {
  it("keeps two parallel calls in order with their original ids", () => {
    const calls: ChatToolCall[] = [
      { id: "call_1", name: "read_file", arguments: { path: "a.ts" } },
      { id: "call_2", name: "read_file", arguments: { path: "b.ts" } },
    ];
    const msgs: ChatMessage[] = [
      { role: "assistant", content: "", tool_calls: calls },
      { role: "tool", content: "A", tool_call_id: "call_1", name: "read_file" },
      { role: "tool", content: "B", tool_call_id: "call_2", name: "read_file" },
    ];
    const wire = serializeChatRequest({ model: "m", messages: msgs }).messages as Array<Record<string, unknown>>;

    const replayed = wire[0]!.tool_calls as Array<{ id: string; type: string; function: { name: string } }>;
    expect(replayed.map((c) => c.id)).toEqual(["call_1", "call_2"]);
    expect(replayed.every((c) => c.type === "function")).toBe(true);
    expect(wire.slice(1).map((m) => m.tool_call_id)).toEqual(["call_1", "call_2"]);
    expect(wire.slice(1).map((m) => m.content)).toEqual(["A", "B"]);
  });

  it("serialises arguments as a JSON string, not an object", () => {
    const msgs: ChatMessage[] = [
      { role: "assistant", content: "", tool_calls: [{ id: "c", name: "read_file", arguments: { path: "x" } }] },
    ];
    const wire = serializeChatRequest({ model: "m", messages: msgs }).messages as Array<Record<string, unknown>>;
    const replayed = wire[0]!.tool_calls as Array<{ function: { arguments: unknown } }>;

    expect(typeof replayed[0]!.function.arguments).toBe("string");
    expect(JSON.parse(replayed[0]!.function.arguments as string)).toEqual({ path: "x" });
  });
});

describe("Phase 48 — parallel_tool_calls", () => {
  it("is sent explicitly when tools are advertised", () => {
    const req = buildCloudChatRequest(planCloudInference("medium", "reviewer"), "cloudflare", "@cf/x", [], undefined, [tool]);
    expect(req.parallel_tool_calls).toBe(true);
    expect(req.tools).toHaveLength(1);
  });

  it("is absent when no tools are advertised", () => {
    const req = buildCloudChatRequest(planCloudInference("medium", "reviewer"), "cloudflare", "@cf/x", []);
    expect(req.parallel_tool_calls).toBeUndefined();
    expect(req.tools).toBeUndefined();
  });
});
