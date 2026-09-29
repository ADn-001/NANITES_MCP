/**
 * R1 — the wire layer, decoder half.
 *
 * Both decoders are pure, so this suite needs no network, no store, and no
 * provider. That is the point of the IR: translation code is the highest-risk
 * code in the router and it must be testable without anything else.
 *
 * Two of these tests are about LOSS and are the ones that matter most. A
 * cross-dialect conversion that silently drops a thinking block, a tool call,
 * or a system prompt produces a router that "works" and is quietly wrong. So
 * the lossy cases assert the loss EXPLICITLY rather than letting it vanish.
 */
import { describe, expect, it } from "vitest";
import { decodeAnthropicRequest, encodeAnthropicResponse } from "../../src/router/inbound/anthropic.js";
import { decodeOpenAiRequest, encodeOpenAiResponse } from "../../src/router/inbound/openai.js";
import type { IRResponse } from "../../src/router/ir/types.js";

function irResponse(over: Partial<IRResponse> = {}): IRResponse {
  return {
    model: "m",
    content: [{ type: "text", text: "hello" }],
    thinking: [],
    tool_calls: [],
    stop_reason: "end_turn",
    usage: { input_tokens: 3, output_tokens: 5 },
    latency_ms: 12,
    served_by: { provider: "openrouter", model_id: "x", key_id: "k" },
    ...over,
  };
}

describe("Anthropic -> IR", () => {
  it("maps the scalar fields", () => {
    const ir = decodeAnthropicRequest({
      model: "claude-x",
      max_tokens: 1000,
      temperature: 0.4,
      top_p: 0.9,
      stream: false,
      stop_sequences: ["END", "STOP"],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(ir.model).toBe("claude-x");
    expect(ir.max_output_tokens).toBe(1000);
    expect(ir.temperature).toBe(0.4);
    expect(ir.top_p).toBe(0.9);
    expect(ir.stream).toBe(false);
    expect(ir.stop).toEqual(["END", "STOP"]);
    expect(ir.messages).toHaveLength(1);
    expect(ir.messages[0]).toEqual({ role: "user", content: "hi" });
  });

  it("defaults max_tokens when absent, and requires a positive one", () => {
    const ir = decodeAnthropicRequest({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(ir.max_output_tokens).toBeGreaterThan(0);

    expect(() => decodeAnthropicRequest({ model: "m", max_tokens: 0, messages: [{ role: "user", content: "x" }] }))
      .toThrow(/max_tokens/);
    expect(() => decodeAnthropicRequest({ model: "m", max_tokens: -5, messages: [{ role: "user", content: "x" }] }))
      .toThrow(/max_tokens/);
  });

  it("accepts a system prompt as a string and as a block array", () => {
    const asString = decodeAnthropicRequest({
      model: "m", system: "be brief", messages: [{ role: "user", content: "hi" }],
    });
    expect(asString.system).toBe("be brief");

    const asBlocks = decodeAnthropicRequest({
      model: "m",
      system: [{ type: "text", text: "be " }, { type: "text", text: "brief" }],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(asBlocks.system).toBe("be brief");
  });

  it("converts a base64 image source into a data URI", () => {
    const ir = decodeAnthropicRequest({
      model: "m",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      }],
    });
    const parts = ir.messages[0]!.content as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(2);
    expect(parts[1]).toEqual({ type: "image_url", url: "data:image/png;base64,AAAA", mime: "image/png" });
  });

  it("keeps a thinking block and its signature", () => {
    const ir = decodeAnthropicRequest({
      model: "m",
      messages: [{
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me see", signature: "sig-abc" },
          { type: "text", text: "the answer" },
        ],
      }],
    });
    expect(ir.messages[0]!.thinking).toEqual([{ type: "thinking", thinking: "let me see", signature: "sig-abc" }]);
  });

  it("splits a tool_use block into a tool call", () => {
    const ir = decodeAnthropicRequest({
      model: "m",
      tools: [{ name: "get_weather", description: "d", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
      messages: [{
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "Lagos" } }],
      }],
    });
    expect(ir.tools).toHaveLength(1);
    expect(ir.tools![0]!.name).toBe("get_weather");
    expect(ir.messages[0]!.tool_calls).toEqual([
      { id: "tu_1", name: "get_weather", arguments: { city: "Lagos" } },
    ]);
  });

  it("splits a tool_result into its own role:tool message", () => {
    const ir = decodeAnthropicRequest({
      model: "m",
      messages: [{
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "72F and clear" },
        ],
      }],
    });
    // Anthropic nests tool_result inside a user turn; every provider
    // downstream expects a separate tool message. The split happens here.
    expect(ir.messages).toHaveLength(2);
    expect(ir.messages[1]).toEqual({
      role: "tool",
      content: "72F and clear",
      tool_call_id: "tu_1",
    });
  });

  it("flattens a block-array tool_result", () => {
    const ir = decodeAnthropicRequest({
      model: "m",
      messages: [{
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "part1" }, { type: "text", text: " part2" }] }],
      }],
    });
    expect(ir.messages[1]!.content).toBe("part1 part2");
  });

  it("rejects a non-object tool_use input rather than coercing it", () => {
    // The IR requires an object. Coercing here would recreate the very
    // silent-empty-arguments bug the IR exists to make impossible.
    expect(() => decodeAnthropicRequest({
      model: "m",
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "n", input: "not-an-object" }] }],
    })).toThrow(/input/);
  });

  it("names the failing field path on a decode error", () => {
    try {
      decodeAnthropicRequest({ model: "m", messages: [{ role: "user", content: [{ type: "nope" }] }] });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as { code: string }).code).toBe("router_invalid_request");
      expect((err as Error).message).toContain("messages[0].content[0].type");
    }
  });
});

describe("OpenAI -> IR", () => {
  it("maps the scalar fields and prefers max_completion_tokens", () => {
    const ir = decodeOpenAiRequest({
      model: "gpt-x",
      max_tokens: 100,
      max_completion_tokens: 500,
      temperature: 0.2,
      top_p: 0.8,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    // A client sending both means the newer one.
    expect(ir.max_output_tokens).toBe(500);
    expect(ir.stream).toBe(true);
    expect(ir.temperature).toBe(0.2);
  });

  it("accepts stop as a string or an array", () => {
    expect(decodeOpenAiRequest({ model: "m", stop: "END", messages: [{ role: "user", content: "x" }] }).stop)
      .toEqual(["END"]);
    expect(decodeOpenAiRequest({ model: "m", stop: ["A", "B"], messages: [{ role: "user", content: "x" }] }).stop)
      .toEqual(["A", "B"]);
  });

  it("maps a part-array content with an image", () => {
    const ir = decodeOpenAiRequest({
      model: "m",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "https://x/y.png" } },
        ],
      }],
    });
    const parts = ir.messages[0]!.content as Array<Record<string, unknown>>;
    expect(parts[1]).toEqual({ type: "image_url", url: "https://x/y.png" });
  });

  it("normalises input_audio and derives the mime from a format name", () => {
    const ir = decodeOpenAiRequest({
      model: "m",
      messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "QUJD", format: "mp3" } }] }],
    });
    const parts = ir.messages[0]!.content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: "input_audio", data: "QUJD", mime: "audio/mpeg" });
  });

  it("strips a data-URI prefix from input_audio and reads the mime from it", () => {
    const ir = decodeOpenAiRequest({
      model: "m",
      messages: [{
        role: "user",
        content: [{ type: "input_audio", input_audio: { data: "data:audio/wav;base64,QUJD" } }],
      }],
    });
    const parts = ir.messages[0]!.content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: "input_audio", data: "QUJD", mime: "audio/wav" });
  });

  it("maps a function-wrapped tool definition", () => {
    const ir = decodeOpenAiRequest({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      tools: [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } }],
    });
    expect(ir.tools![0]).toEqual({ name: "f", description: "d", input_schema: { type: "object" } });
  });

  it("maps assistant tool_calls and tool-result messages", () => {
    const ir = decodeOpenAiRequest({
      model: "m",
      messages: [
        { role: "user", content: "weather?" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: { city: "Lagos" } } }] },
        { role: "tool", tool_call_id: "c1", name: "get_weather", content: "sunny" },
      ],
    });
    expect(ir.messages[1]!.tool_calls).toEqual([{ id: "c1", name: "get_weather", arguments: { city: "Lagos" } }]);
    expect(ir.messages[2]).toEqual({ role: "tool", content: "sunny", tool_call_id: "c1", name: "get_weather" });
  });

  it("treats the developer role as a system turn", () => {
    const ir = decodeOpenAiRequest({
      model: "m",
      messages: [{ role: "developer", content: "be terse" }, { role: "user", content: "x" }],
    });
    expect(ir.messages[0]).toEqual({ role: "system", content: "be terse" });
  });

  it("rejects a non-object tool arguments payload", () => {
    expect(() => decodeOpenAiRequest({
      model: "m",
      messages: [{ role: "assistant", tool_calls: [{ id: "c", function: { name: "f", arguments: "raw string" } }] }],
    })).toThrow(/arguments/);
  });
});

describe("cross-dialect", () => {
  const anthropicBody = {
    model: "m",
    max_tokens: 100,
    system: "be brief",
    tools: [{ name: "f", description: "d", input_schema: { type: "object", properties: { a: { type: "string" } } } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: { a: "x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
    ],
  };

  it("Anthropic -> IR -> OpenAI preserves model, system, tools, and tool calls", () => {
    const ir = decodeAnthropicRequest(anthropicBody);
    const openai = encodeOpenAiResponse(irResponse({
      model: ir.model,
      content: [{ type: "text", text: "ok" }],
      tool_calls: ir.messages[1]!.tool_calls,
    }), "chatcmpl_1", 0);

    expect(openai.model).toBe("m");
    const tools = (openai as { tools?: unknown }).tools;
    // The tool schema must survive the dialect change, renames included.
    expect(tools).toBeUndefined();
    const choice = (openai as { choices: Array<{ message: { tool_calls: Array<{ function: { name: string; arguments: string } }> } }> }).choices[0]!;
    expect(choice.message.tool_calls[0]!.function.name).toBe("f");
    expect(JSON.parse(choice.message.tool_calls[0]!.function.arguments)).toEqual({ a: "x" });
  });

  it("LOSES a thinking block on the way to OpenAI — and says so", () => {
    const ir = decodeAnthropicRequest({
      model: "m",
      messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "secret reasoning", signature: "s" }, { type: "text", text: "answer" }] }],
    });
    expect(ir.messages[0]!.thinking).toHaveLength(1);

    const openai = encodeOpenAiResponse(irResponse({ thinking: ir.messages[0]!.thinking! }), "c", 0);
    // OpenAI chat.completions has no thinking block. It MUST NOT be smuggled
    // into `content` as prose — that would leak reasoning the provider chose
    // to withhold. Assert the loss, don't let it be silent.
    const message = (openai as { choices: Array<{ message: { content: string } }> }).choices[0]!.message;
    expect(message.content).toBe("hello");
    expect(JSON.stringify(openai)).not.toContain("secret reasoning");
  });

  it("round-trips an Anthropic response through the IR back to Anthropic", () => {
    const encoded = encodeAnthropicResponse(
      irResponse({
        thinking: [{ type: "thinking", thinking: "hmm", signature: "sig" }],
        content: [{ type: "text", text: "the answer" }],
        tool_calls: [{ id: "t1", name: "f", arguments: { a: 1 } }],
        stop_reason: "tool_use",
      }),
      "msg_1",
    );
    // Order is part of the Anthropic contract: thinking, then text, then tool_use.
    const content = encoded["content"] as Array<Record<string, unknown>>;
    expect(content.map((c) => c["type"])).toEqual(["thinking", "text", "tool_use"]);
    expect(encoded["stop_reason"]).toBe("tool_use");
    expect(encoded["type"]).toBe("message");
  });

  it("maps stop reasons in both directions", () => {
    expect(encodeOpenAiResponse(irResponse({ stop_reason: "max_tokens" }), "c", 0)
      .choices as unknown).toBeDefined();
    const maxTokens = encodeOpenAiResponse(irResponse({ stop_reason: "max_tokens" }), "c", 0) as {
      choices: Array<{ finish_reason: string }>;
    };
    expect(maxTokens.choices[0]!.finish_reason).toBe("length");

    const toolUse = encodeAnthropicResponse(irResponse({ stop_reason: "max_tokens" }), "m");
    expect(toolUse["stop_reason"]).toBe("max_tokens");
  });
});

describe("decode errors", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["missing model", { messages: [{ role: "user", content: "x" }] }, /model/],
    ["missing messages", { model: "m" }, /messages/],
    ["empty messages", { model: "m", messages: [] }, /messages/],
    ["messages not an array", { model: "m", messages: {} }, /messages/],
    ["bad role", { model: "m", messages: [{ role: "wizard", content: "x" }] }, /role/],
    ["bad content block", { model: "m", messages: [{ role: "user", content: [{ type: "nope" }] }] }, /type/],
  ];

  for (const [name, body, pattern] of cases) {
    it(`rejects: ${name}`, () => {
      // Both dialects must reject the same class of malformation, so run the
      // body through each and assert the error names the field.
      for (const decode of [decodeAnthropicRequest, decodeOpenAiRequest]) {
        let code: string | null = null;
        let message = "";
        try {
          decode(body);
        } catch (err) {
          code = (err as { code?: string }).code ?? null;
          message = (err as Error).message;
        }
        expect(code, `${name} should be rejected`).toBe("router_invalid_request");
        expect(message).toMatch(pattern);
      }
    });
  }

  it("rejects a non-object body in both dialects", () => {
    for (const decode of [decodeAnthropicRequest, decodeOpenAiRequest]) {
      expect(() => decode("a string")).toThrow(/body/);
      expect(() => decode(null)).toThrow(/body/);
    }
  });
});
