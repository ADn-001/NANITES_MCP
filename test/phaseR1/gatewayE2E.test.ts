/**
 * R1 — the wire layer, gateway half.
 *
 * Full path: a real HTTP request hits the router, is decoded, resolved to a
 * provider, dispatched through the EXISTING provider client (stubbed at
 * `fetch`), and encoded back in the caller's dialect.
 *
 * The fetch stub must expose a real `ReadableStream` with `getReader()` — the
 * provider clients drive `readSseLines`, and a hand-rolled `json()`-only stub
 * blows up on `line.slice`. That is a lesson from `phase70/genericEndpoints`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { startRouter, type StartedRouter } from "../../src/router/deps.js";
import { ProviderKeyStore } from "../../src/storage/providerKeyStore.js";
import { ProviderModelStore } from "../../src/storage/providerModelStore.js";
import { scratchHome, cleanup, TEST_PROFILE, writeActiveProfile } from "../phase3/helpers.js";

const homes: string[] = [];
const servers: StartedRouter[] = [];
let restoreFetch: (() => void) | null = null;

interface WireCall {
  url: string;
  model: string;
  auth: string;
  body: Record<string, unknown>;
}

interface StubOptions {
  content?: string;
  finish_reason?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
  status?: number;
  errorBody?: string;
}

function stubProvider(calls: WireCall[], opts: StubOptions = {}): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    // Pass loopback through untouched. The test's OWN request to the router
    // goes through globalThis.fetch too — without this guard the stub answers
    // the router's own caller with a provider payload, and every assertion
    // downstream is testing the wrong thing.
    const href = String(url);
    if (href.includes("127.0.0.1") || href.includes("localhost")) {
      return original(url as string, init);
    }

    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({
      url: String(url),
      model: String(body["model"] ?? ""),
      auth: String((init?.headers as Record<string, string>)?.["Authorization"] ?? "").replace("Bearer ", ""),
      body,
    });

    if (opts.status && opts.status >= 400) {
      const text = opts.errorBody ?? JSON.stringify({ error: { message: "upstream said no" } });
      return {
        ok: false,
        status: opts.status,
        headers: new Headers(),
        json: async () => JSON.parse(text),
        text: async () => text,
        body: null,
      } as unknown as Response;
    }

    const payload = JSON.stringify({
      id: "upstream-1",
      choices: [{
        message: {
          role: "assistant",
          content: opts.content ?? "the answer",
          ...(opts.toolCalls
            ? { tool_calls: opts.toolCalls.map((c) => ({
                id: c.id, type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.arguments) },
              })) }
            : {}),
        },
        finish_reason: opts.finish_reason ?? "stop",
      }],
      usage: opts.usage ?? { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    });

    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => JSON.parse(payload),
      text: async () => payload,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`));
          controller.close();
        },
      }),
    } as unknown as Response;
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = original;
    restoreFetch = null;
  };
}

interface Harness {
  handle: StartedRouter;
  key: string;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
}

async function harness(opts: StubOptions = {}): Promise<Harness & { calls: WireCall[] }> {
  const h = scratchHome();
  writeActiveProfile(h);
  homes.push(h);
  const handle = await startRouter({ home: h, port: 0, bind: "127.0.0.1", env: {} });
  servers.push(handle);
  const key = handle.deps.generatedKey!;

  const keyStore = new ProviderKeyStore(handle.deps.db);
  keyStore.addKey(TEST_PROFILE, "openrouter", "sk-test-key", { accountId: null });

  const modelStore = new ProviderModelStore(handle.deps.db);
  modelStore.registerModel(TEST_PROFILE, "openrouter", "qwen/qwen3-8b");

  const calls: WireCall[] = [];
  stubProvider(calls, opts);

  return {
    handle,
    key,
    calls,
    post: (path, body, headers = {}) =>
      fetch(`http://127.0.0.1:${handle.port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...headers },
        body: JSON.stringify(body),
      }),
  };
}

afterEach(async () => {
  restoreFetch?.();
  while (servers.length) {
    const s = servers.pop()!;
    await s.close();
    s.deps.close();
  }
  while (homes.length) cleanup(homes.pop()!);
});

describe("R1 — gateway end to end", () => {
  it("serves an OpenAI request and returns an OpenAI response", async () => {
    const h = await harness();
    const res = await h.post("/v1/chat/completions", {
      model: "qwen/qwen3-8b",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["object"]).toBe("chat.completion");
    expect(body["model"]).toBe("qwen/qwen3-8b");
    const choice = (body["choices"] as Array<{ message: { content: string }; finish_reason: string }>)[0]!;
    expect(choice.message.content).toBe("the answer");
    expect(choice.finish_reason).toBe("stop");
    expect(body["usage"]).toMatchObject({ prompt_tokens: 11, completion_tokens: 7 });
  });

  it("sends the BARE model id upstream, not the namespaced one", async () => {
    const h = await harness();
    await h.post("/v1/chat/completions", {
      model: "openrouter:qwen/qwen3-8b",
      messages: [{ role: "user", content: "hi" }],
    });
    // The provider only knows its own model name. This is the strip that
    // chatWithBudgetRetry owns, and asserting it here is what proves the
    // router did not double-prefix or forget it.
    expect(h.calls[0]!.model).toBe("qwen/qwen3-8b");
    expect(h.calls[0]!.auth).toBe("sk-test-key");
    expect(h.calls[0]!.url).toContain("openrouter.ai");
  });

  it("strips a DOUBLE-namespaced id, which a naive single-prefix strip would not", async () => {
    const h = await harness();
    // A router that strips once at its own call site and once again in
    // chatWithBudgetRetry would leave "qwen/qwen3-8b" here, which happens to
    // be correct — so that case proves nothing. This one does: a model id
    // that ITSELF begins with a provider-like segment.
    const keyStore = new ProviderKeyStore(h.handle.deps.db);
    keyStore.addKey(TEST_PROFILE, "generic", "sk-generic", {
      gatewayUrl: "https://gw.test/v1", nickname: "gw",
    });
    const modelStore = new ProviderModelStore(h.handle.deps.db);
    modelStore.registerModel(TEST_PROFILE, "generic", "openrouter:inner-model");

    const res = await h.post("/v1/chat/completions", {
      model: "generic:gw:openrouter:inner-model",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    // Exactly one strip: the endpoint namespace goes, the model keeps its own
    // colon. A regex that strips any leading `word:` would eat "openrouter:"
    // too and send "inner-model" — the wrong model to the wrong gateway.
    expect(h.calls[0]!.model).toBe("openrouter:inner-model");
    expect(h.calls[0]!.url).toContain("gw.test");
  });

  it("serves an Anthropic request and returns an Anthropic response", async () => {
    const h = await harness();
    const res = await h.post("/v1/messages", {
      model: "qwen/qwen3-8b",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["type"]).toBe("message");
    expect(body["role"]).toBe("assistant");
    expect(String(body["id"]).startsWith("msg_")).toBe(true);
    expect(body["stop_reason"]).toBe("end_turn");
    expect(body["usage"]).toMatchObject({ input_tokens: 11, output_tokens: 7 });
    const content = body["content"] as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "text", text: "the answer" });
  });

  it("does NOT ship Nanites' internal call_uid to the provider", async () => {
    const h = await harness();
    await h.post("/v1/chat/completions", {
      model: "qwen/qwen3-8b",
      messages: [{ role: "user", content: "hi" }],
    });
    // The MCP server's cloud tool loop correlates turns with a call-log row
    // using an [INTERNAL_CALL_UID: ...] system message. The gateway's caller
    // is a third-party harness with its own ids, so shipping ours leaks
    // internal bookkeeping AND costs tokens on every single request.
    //
    // This was found by running the router against a real socket and reading
    // what the upstream actually received — no stub asserted on it.
    const sent = JSON.stringify(h.calls[0]!.body);
    expect(sent).not.toContain("INTERNAL_CALL_UID");
  });

  it("still lets the caller's own system prompt through", async () => {
    const h = await harness();
    await h.post("/v1/messages", {
      model: "qwen/qwen3-8b",
      max_tokens: 50,
      system: "be brief",
      messages: [{ role: "user", content: "hi" }],
    });
    // The counter-test for the one above: suppressing our marker must not
    // suppress the caller's prompt.
    const messages = h.calls[0]!.body["messages"] as Array<{ role: string; content: string }>;
    expect(messages.some((m) => m.role === "system" && m.content === "be brief")).toBe(true);
  });

  it("carries the caller's max_tokens to the provider", async () => {
    const h = await harness();
    await h.post("/v1/chat/completions", {
      model: "qwen/qwen3-8b",
      max_tokens: 321,
      messages: [{ role: "user", content: "hi" }],
    });
    // The planner's default is 16k; a gateway caller states its own ceiling
    // and the provider must see THAT number.
    expect(h.calls[0]!.body["max_tokens"]).toBe(321);
  });

  it("maps a tool call into the caller's dialect", async () => {
    const h = await harness({
      content: "",
      finish_reason: "tool_calls",
      toolCalls: [{ id: "call_1", name: "get_weather", arguments: { city: "Lagos" } }],
    });
    const res = await h.post("/v1/chat/completions", {
      model: "qwen/qwen3-8b",
      messages: [{ role: "user", content: "weather?" }],
      tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
    });
    const body = (await res.json()) as { choices: Array<{ message: { tool_calls: Array<{ function: { arguments: string } }> }; finish_reason: string }> };
    expect(body.choices[0]!.finish_reason).toBe("tool_calls");
    const call = body.choices[0]!.message.tool_calls[0]!;
    expect(JSON.parse(call.function.arguments)).toEqual({ city: "Lagos" });
    // The tool schema must reach the provider in the OpenAI wire shape.
    const sent = h.calls[0]!.body["tools"] as Array<{ function: { name: string; parameters: unknown } }>;
    expect(sent[0]!.function.name).toBe("get_weather");
  });

  it("maps a tool call into the Anthropic shape", async () => {
    const h = await harness({
      content: "",
      finish_reason: "tool_calls",
      toolCalls: [{ id: "call_1", name: "get_weather", arguments: { city: "Lagos" } }],
    });
    const res = await h.post("/v1/messages", {
      model: "qwen/qwen3-8b",
      max_tokens: 100,
      messages: [{ role: "user", content: "weather?" }],
      tools: [{ name: "get_weather", input_schema: { type: "object" } }],
    });
    const body = (await res.json()) as { stop_reason: string; content: Array<Record<string, unknown>> };
    expect(body.stop_reason).toBe("tool_use");
    expect(body.content[0]).toEqual({
      type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Lagos" },
    });
  });

  it("maps max_tokens to stop_reason max_tokens in both dialects", async () => {
    const h = await harness({ finish_reason: "length" });
    const openai = await (await h.post("/v1/chat/completions", {
      model: "qwen/qwen3-8b", messages: [{ role: "user", content: "x" }],
    })).json() as { choices: Array<{ finish_reason: string }> };
    expect(openai.choices[0]!.finish_reason).toBe("length");

    const anthropic = await (await h.post("/v1/messages", {
      model: "qwen/qwen3-8b", max_tokens: 10, messages: [{ role: "user", content: "x" }],
    })).json() as { stop_reason: string };
    expect(anthropic.stop_reason).toBe("max_tokens");
  });

  it("rejects an AMBIGUOUS bare model id, naming the candidates", async () => {
    const h = await harness();
    // A second provider serving the same bare id is the exact ambiguity that
    // made the MCP server's cloud routing wrong. It must NOT pick the first.
    const keyStore = new ProviderKeyStore(h.handle.deps.db);
    keyStore.addKey(TEST_PROFILE, "generic", "sk-generic", {
      gatewayUrl: "https://gw.test/v1", nickname: "gw",
    });
    const modelStore = new ProviderModelStore(h.handle.deps.db);
    modelStore.registerModel(TEST_PROFILE, "generic", "qwen/qwen3-8b");

    const res = await h.post("/v1/chat/completions", {
      model: "qwen/qwen3-8b",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("alias_unknown");
    expect(body.error.message).toContain("openrouter");
    expect(body.error.message).toContain("generic");
    // And nothing was dispatched.
    expect(h.calls).toHaveLength(0);
  });

  it("resolves a unique bare id to its single provider", async () => {
    const h = await harness();
    const res = await h.post("/v1/chat/completions", {
      model: "qwen/qwen3-8b",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    expect(h.calls[0]!.url).toContain("openrouter.ai");
  });

  it("surfaces a provider failure in the caller's dialect, keeping the reason", async () => {
    const h = await harness({ status: 429, errorBody: JSON.stringify({ error: { message: "rate limited" } }) });
    const res = await h.post("/v1/chat/completions", {
      model: "qwen/qwen3-8b",
      messages: [{ role: "user", content: "hi" }],
    });
    // R3 changed this deliberately. A key-scoped failure now retires the key
    // and, with no other key left, the request fails as all_keys_exhausted —
    // the per-key reasons are in `details.reasons` so a harness can still see
    // that the cause was a rate limit rather than an auth problem.
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("all_keys_exhausted");
    expect(body.error.message).toContain("openrouter");
  });

  it("returns the Anthropic error envelope for an Anthropic caller", async () => {
    const h = await harness({ status: 429, errorBody: JSON.stringify({ error: { message: "rate limited" } }) });
    const res = await h.post("/v1/messages", {
      model: "qwen/qwen3-8b",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    }, { "anthropic-version": "2023-06-01" });
    const body = (await res.json()) as { type: string; error: { type: string } };
    // Anthropic clients parse `type:"error"` at the top level.
    expect(body.type).toBe("error");
  });

  it("rejects a decode error before contacting any provider", async () => {
    const h = await harness();
    const res = await h.post("/v1/chat/completions", { model: "qwen/qwen3-8b", messages: [] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("router_invalid_request");
    expect(body.error.message).toContain("messages");
    expect(h.calls).toHaveLength(0);
  });

  it("rejects a body that is not JSON", async () => {
    const h = await harness();
    const res = await fetch(`http://127.0.0.1:${h.handle.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.key}` },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });

  it("honours a streaming request now that R2 shipped", async () => {
    const h = await harness();
    const res = await h.post("/v1/chat/completions", {
      model: "qwen/qwen3-8b",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    // R1 refused streams explicitly so a caller asking for one never got a
    // non-streaming body back and hung. R2 implements them; this asserts the
    // refusal is GONE, and the real contract is covered in phaseR2.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });

  it("requires the virtual key on the inference path too", async () => {
    const h = await harness();
    const res = await fetch(`http://127.0.0.1:${h.handle.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen/qwen3-8b", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(401);
    expect(h.calls).toHaveLength(0);
  });

  it("never echoes the virtual key in an error body", async () => {
    const h = await harness({ status: 500, errorBody: "{}" });
    const res = await h.post("/v1/chat/completions", {
      model: "no-such-model-anywhere",
      messages: [{ role: "user", content: "hi" }],
    });
    const text = await res.text();
    expect(text).not.toContain(h.key);
  });
});
