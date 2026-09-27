import { describe, expect, it } from "vitest";
import { buildProbeBody, captureAttempt, readSettings } from "../../scripts/cf-gw-probe.js";

describe("Gateway capture probe", () => {
  it("builds the production answer-round wire shape with synthetic tool results", () => {
    const body = buildProbeBody();
    const messages = body.messages as Array<Record<string, any>>;
    expect(body).toMatchObject({ model: "@cf/openai/gpt-oss-120b", max_completion_tokens: 16384, reasoning_effort: "medium", temperature: 0.3 });
    expect(body).not.toHaveProperty("tools");
    expect(messages.at(-1)).toMatchObject({ role: "tool", name: "read_file", tool_call_id: "probe_8" });
    expect(messages.at(-2)?.tool_calls[0]).toMatchObject({ id: "probe_8", type: "function", function: { name: "read_file", arguments: '{"path":"fixture-8.txt"}' } });
  });

  it("requires explicit credentials and a valid gateway ID", () => {
    expect(() => readSettings({})).toThrow("CF_ACCOUNT_ID");
    expect(() => readSettings({ CF_ACCOUNT_ID: "../account", CF_API_TOKEN: "secret", CF_GATEWAY_ID: "probe" })).toThrow("CF_ACCOUNT_ID");
    expect(() => readSettings({ CF_ACCOUNT_ID: "a".repeat(32), CF_API_TOKEN: "secret", CF_GATEWAY_ID: "../probe" })).toThrow("CF_GATEWAY_ID");
  });

  it("uses identical bodies and the documented gateway header without following redirects", async () => {
    const settings = readSettings({ CF_ACCOUNT_ID: "a".repeat(32), CF_API_TOKEN: "secret", CF_GATEWAY_ID: "nanites-probe" });
    const body = buildProbeBody();
    const sent: Request[] = [];
    const transport = async (input: string, init: RequestInit) => {
      sent.push(new Request(input, init));
      return new Response('{"choices":[{"message":{"content":""},"finish_reason":"stop"}]}', { headers: { "cf-ray": "ray-1", "cf-aig-log-id": "log-1", "set-cookie": "private" } });
    };
    const direct = await captureAttempt(settings, body, "direct", transport);
    const gateway = await captureAttempt(settings, body, "gateway", transport);
    expect(await sent[0]!.text()).toBe(await sent[1]!.text());
    expect(sent[0]!.headers.has("cf-aig-gateway-id")).toBe(false);
    expect(sent[1]!.headers.get("cf-aig-gateway-id")).toBe("nanites-probe");
    expect(sent[1]!.headers.get("cf-aig-skip-cache")).toBe("true");
    expect(sent[1]!.headers.get("cf-aig-collect-log-payload")).toBe("true");
    expect(sent[1]!.redirect).toBe("error");
    expect(gateway.headers).toMatchObject({ "cf-ray": "ray-1", "cf-aig-log-id": "log-1" });
    expect(gateway.headers).not.toHaveProperty("set-cookie");
    expect(gateway.raw_body).toBe(direct.raw_body);
    expect(JSON.stringify(gateway)).not.toContain("secret");
  });

  it("preserves non-JSON HTTP errors and never retries", async () => {
    const settings = readSettings({ CF_ACCOUNT_ID: "a".repeat(32), CF_API_TOKEN: "secret", CF_GATEWAY_ID: "probe" });
    let calls = 0;
    const result = await captureAttempt(settings, buildProbeBody(), "gateway", async () => {
      calls++;
      return new Response("upstream failed", { status: 500 });
    });
    expect(result).toMatchObject({ status: 500, raw_body: "upstream failed" });
    expect(calls).toBe(1);
  });

  it("redacts known credentials if the service echoes them", async () => {
    const settings = readSettings({ CF_ACCOUNT_ID: "a".repeat(32), CF_API_TOKEN: "provider-secret", CF_GATEWAY_ID: "probe", CF_AIG_AUTH_TOKEN: "gateway-secret" });
    const result = await captureAttempt(settings, buildProbeBody(), "gateway", async () => new Response("provider-secret gateway-secret " + "a".repeat(32)));
    expect(result.raw_body).toBe("[REDACTED] [REDACTED] [REDACTED]");
    expect(result.redacted).toBe(true);
  });

  it("records transport failure without leaking error text", async () => {
    const settings = readSettings({ CF_ACCOUNT_ID: "a".repeat(32), CF_API_TOKEN: "secret", CF_GATEWAY_ID: "probe" });
    const result = await captureAttempt(settings, buildProbeBody(), "gateway", async () => { throw new Error("secret"); });
    expect(result.status).toBe(null);
    expect(result.transport_error).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
