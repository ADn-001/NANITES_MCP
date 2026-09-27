/**
 * Phase 55 gate — structured output.
 *
 * Two concerns, both about a contract rather than a feature:
 *
 * 1. `runCloudToolLoop` must spend *at most one* extra round to get a
 *    schema-conforming answer, and that round must carry `response_format` with
 *    tools off. The wire shape is branched per provider because getting it wrong
 *    is silent — the provider ignores the field and answers in prose, which is
 *    exactly the failure (a five-file review returning prose) this phase
 *    fixes.
 * 2. A caller must never be told it got JSON when it did not. A non-conforming
 *    answer is returned with `validation.issues`. The local LM Studio path now
 *    sends `response_format` and validates the reply, matching the cloud path.
 *
 * The round policy is tested through the loop's injected `route` seam, so no
 * cloud provider is contacted. The local case drives `runSubAgent` against a
 * mock LM Studio endpoint.
 */
import { afterAll, describe, expect, it } from "vitest";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { runCloudToolLoop } from "../../src/providers/cloudToolLoop.js";
import { runSubAgent } from "../../src/workflows/runSubAgent.js";
import { responseFormatFor, parseStructured, extractJson } from "../../src/providers/outputSchema.js";
import type { RouteResult, RouterOptions } from "../../src/providers/router.js";
import { NanitesError } from "../../src/helpers/errors.js";
import type { ChatResponse } from "../../src/providers/types.js";
import type { Profile } from "../../src/storage/profileDefaults.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";
import { startMockLmStudio, sendJson, sendChatStream, wantsStream, type MockLmStudio } from "../phase1/mockServer.js";
import { chatResponseFixture } from "../phase1/fixtures.js";

const SCHEMA = {
  type: "object",
  properties: { findings: { type: "array", items: { type: "object" } }, summary: { type: "string" } },
  required: ["findings", "summary"],
};
const VALID = JSON.stringify({ findings: [{ file: "a.ts", line: 1 }], summary: "ok" });

const scratchDirs: string[] = [];
const depsList: ToolDeps[] = [];

function harness(name: string): { d: ToolDeps; profile: Profile } {
  const home = scratchHome();
  scratchDirs.push(home);
  const d = buildDeps(home);
  depsList.push(d);
  d.profiles.createProfile({ name });
  d.profiles.switchProfile(name);
  return { d, profile: d.profiles.getProfile(name)! };
}

interface Scripted {
  content?: string;
  calls?: number;
  finish_reason?: string;
  /** Fail this round with a structured error instead of answering. */
  fail?: string;
}

/** Router stand-in: replays a script, then repeats the last entry. */
function scriptedRouter(script: Scripted[], seen: RouterOptions[]) {
  let i = 0;
  return async (opts: RouterOptions): Promise<RouteResult> => {
    seen.push(opts);
    const step = script[Math.min(i, script.length - 1)]!;
    i += 1;
    if (step.fail) {
      throw new NanitesError({ code: step.fail, message: `scripted ${step.fail}`, retryable: true });
    }
    const response: ChatResponse = {
      content: step.content ?? "",
      finish_reason: step.finish_reason ?? "stop",
      ...(step.calls
        ? {
            tool_calls: Array.from({ length: step.calls }, (_, n) => ({
              id: `call_${i}_${n}`,
              name: "read_file",
              arguments: { path: "package.json" },
            })),
          }
        : {}),
    };
    return {
      response,
      provider: "cloudflare",
      model_id: "test/model",
      call_uid: `uid-${i}`,
      call_log_id: i,
      tokens_in: 10,
      tokens_out: 5,
      duration_ms: 100,
    };
  };
}

function loop(d: ToolDeps, profile: Profile, script: Scripted[], outputSchema?: Record<string, unknown>) {
  const seen: RouterOptions[] = [];
  const run = runCloudToolLoop({
    profile,
    db: d.db,
    provider: "cloudflare",
    modelId: "test/model",
    effort: "medium",
    role: "reviewer",
    brief: "review",
    fsGrant: { root: process.cwd() },
    ...(outputSchema ? { outputSchema } : {}),
    route: scriptedRouter(script, seen),
  });
  return { run, seen };
}

afterAll(() => {
  for (const d of depsList) d.close();
  cleanup(...scratchDirs);
});

describe("Phase 55 — structured output", () => {
  it("spends one finalize round when the answer is prose, schema attached and tools off", async () => {
    const { d, profile } = harness("d1-finalize");
    const { run, seen } = loop(
      d,
      profile,
      [{ calls: 1 }, { content: "Here is my review in prose." }, { content: VALID }],
      SCHEMA,
    );
    const res = await run;

    expect(res.rounds).toBe(3);
    expect(res.structured).toEqual({ valid: true, finalized: true, problems: [] });
    expect(JSON.parse(res.reply).summary).toBe("ok");

    const finalize = seen[2]!;
    expect(finalize.tools).toBeUndefined();
    // This is the Nanites-level intent; the provider wire shape is applied in
    // buildCloudChatRequest and asserted by the responseFormatFor test below
    // (nested for every provider — Cloudflare's documented flat form is the one
    // the live endpoint answers with HTTP 500 / code 3043).
    expect(finalize.responseFormat).toEqual({ type: "json_schema", schema: SCHEMA });
    const lastMessage = finalize.messages[finalize.messages.length - 1]!;
    expect(String(lastMessage.content)).toMatch(/single JSON value/);
    // The read rounds never carried a schema.
    expect(seen[0]!.responseFormat).toBeUndefined();
    expect(seen[1]!.responseFormat).toBeUndefined();
    expect(seen[0]!.tools?.length).toBeGreaterThan(0);
  });

  it("does not re-ask when the answer already conforms", async () => {
    const { d, profile } = harness("d1-clean");
    const { run, seen } = loop(d, profile, [{ content: VALID }], SCHEMA);
    const res = await run;

    expect(seen).toHaveLength(1);
    expect(res.rounds).toBe(1);
    expect(res.structured).toEqual({ valid: true, finalized: false, problems: [] });
    expect(res.reply).toBe(VALID);
  });

  it("finalizes at low effort under its own output ceiling, not the loop's", async () => {
    const { d, profile } = harness("d1-finalize-budget");
    const { run, seen } = loop(d, profile, [{ calls: 1 }, { content: "prose" }, { content: VALID }], SCHEMA);
    await run;

    // Only the finalize round is bounded, and it is pinned to low effort
    // whatever the caller requested — a reasoning burn on a reformat is what
    // cost the live D1 gate a completed run (205 s answer round, then a
    // finalize call that crossed the 240 s client timeout).
    expect(seen[2]!.effort).toBe("low");
    expect(seen[2]!.maxOutputTokens).toBe(4096);
    expect(seen[0]!.maxOutputTokens).toBeUndefined();
    expect(seen[1]!.maxOutputTokens).toBeUndefined();
  });

  it("never puts the finalize user turn straight after a tool result", async () => {
    const { d, profile } = harness("d1-alternation");
    const { run, seen } = loop(d, profile, [{ calls: 1 }, { content: "prose answer" }, { content: VALID }], SCHEMA);
    await run;

    // Cloudflare rejects `user` directly after `tool` (HTTP 400 / code 8007),
    // which is how the first live finalize round died. The assistant turn
    // carrying the answer being corrected is what makes the sequence legal.
    const msgs = seen[2]!.messages;
    const tail = msgs.slice(-3).map((m) => m.role);
    expect(tail).toEqual(["tool", "assistant", "user"]);
    expect(msgs[msgs.length - 2]!.content).toBe("prose answer");
    expect(seen[2]!.systemPrompt).not.toMatch(/single JSON value/);
  });

  it("delivers the finalize instruction as a document when the loop never spoke", async () => {
    const { d, profile } = harness("d1-alternation-silent");
    // Two rounds of tool calls and no text at all: there is nothing to correct
    // and no assistant message to invent. The finalize round is the only one
    // that answers, which is also how a run that never spoke avoids
    // `tool_loop_no_answer`.
    //
    // The old shape here — instruction in the system prompt with the
    // transcript still ending on `tool` — is the one measured at 0 content in 6
    // of 6 live attempts, so the finalize gets the same rebuilt transcript the
    // rescue does. Unchanged: it is still the only round that answers.
    const { run, seen } = loop(d, profile, [{ calls: 1 }, { calls: 1 }, { content: "" }, { content: VALID }], SCHEMA);
    const res = await run;

    expect(res.reply).toBe(VALID);

    const finalize = seen[3]!;
    expect(finalize.messages).toHaveLength(1);
    expect(finalize.messages[0]!.role).toBe("user");
    expect(String(finalize.messages[0]!.content)).toMatch(/single JSON value/);
    // Which is why the instruction is no longer in the system prompt.
    expect(finalize.systemPrompt ?? "").not.toMatch(/single JSON value/);
  });

  it("keeps the loop's answer when the finalize round fails outright", async () => {
    const { d, profile } = harness("d1-finalize-down");
    const { run } = loop(
      d,
      profile,
      [{ calls: 1 }, { content: "prose answer" }, { fail: "provider_timeout" }],
      SCHEMA,
    );
    const res = await run;

    expect(res.reply).toBe("prose answer");
    expect(res.structured).toEqual({
      valid: false,
      finalized: true,
      problems: ["finalize round failed: provider_timeout"],
    });
    // The failed round produced no result, so the returned call id stays the
    // one of the answer the caller actually got.
    expect(res.rounds).toBe(2);
  });

  it("flags a finalize round that still misses the schema, without throwing", async () => {
    const { d, profile } = harness("d1-invalid");
    const { run, seen } = loop(
      d,
      profile,
      [{ calls: 1 }, { content: "prose" }, { content: JSON.stringify({ summary: "no findings key" }) }],
      SCHEMA,
    );
    const res = await run;

    expect(res.structured?.valid).toBe(false);
    expect(res.structured?.problems.join(" ")).toMatch(/missing required key "findings"/);
    expect(res.reply).toContain("no findings key");
    expect(seen).toHaveLength(3);
  });

  it("keeps the loop's own answer when the finalize round comes back empty", async () => {
    const { d, profile } = harness("d1-empty");
    const { run } = loop(d, profile, [{ calls: 1 }, { content: "prose answer" }, { content: "" }], SCHEMA);
    const res = await run;

    expect(res.reply).toBe("prose answer");
    expect(res.structured?.finalized).toBe(true);
    expect(res.structured?.problems.join(" ")).toMatch(/no text/);
  });

  it("still raises tool_loop_no_answer when no round produced text at all", async () => {
    const { d, profile } = harness("d1-silent");
    const { run } = loop(d, profile, [{ calls: 1 }, { content: "" }], SCHEMA);
    await expect(run).rejects.toMatchObject({ code: "tool_loop_no_answer" });
  });

  it("sends response_format on the local LM Studio path and validates the reply", async () => {
    const home = scratchHome();
    const d = buildDeps(home);
    d.profiles.createProfile({ name: "d1-local", machine_specs: { vram_gb: 4 } });
    d.profiles.switchProfile("d1-local");

    let capturedBody: Record<string, unknown> | null = null;
    const mock: MockLmStudio = await startMockLmStudio((_req, res, body) => {
      const url = new URL(_req.url ?? "/", "http://mock");
      switch (url.pathname) {
        case "/api/v1/models":
          return sendJson(res, 200, { models: [{ key: "test-local", loaded_instances: [{ id: "inst-1", config: { context_length: 4096 } }] }] });
        case "/api/v1/models/load":
          return sendJson(res, 200, { type: "llm", instance_id: "inst-1", load_time_seconds: 0.1, status: "loaded" });
        case "/api/v1/chat":
          capturedBody = JSON.parse(body) as Record<string, unknown>;
          const response = {
            ...chatResponseFixture,
            output: [{ type: "message", content: VALID }],
          };
          if (wantsStream(body)) return sendChatStream(res, response);
          return sendJson(res, 200, response);
        default:
          return sendJson(res, 404, { error: `no mock route for ${url.pathname}` });
      }
    });

    try {
      d.profiles.updateProfile("d1-local", { endpoint: { url: mock.url } });
      d.registry.upsert("d1-local", { model_id: "test-local", roles: ["reviewer"], scores: {}, best_params: {}, last_tested: null });
      const result = await runSubAgent(d, "d1-local", "review this file for bugs", { outputSchema: SCHEMA });
      expect(result.validation.issues).toEqual([]);
      expect(capturedBody).not.toBeNull();
      const rf = capturedBody!.response_format;
      expect(rf).toBeDefined();
      expect((rf as { type: string }).type).toBe("json_schema");
    } finally {
      await mock.close();
      d.close();
      cleanup(home);
    }
  });

  it("flags a non-conforming local reply in validation.issues", async () => {
    const home = scratchHome();
    const d = buildDeps(home);
    d.profiles.createProfile({ name: "d1-local-bad", machine_specs: { vram_gb: 4 } });
    d.profiles.switchProfile("d1-local-bad");

    const mock: MockLmStudio = await startMockLmStudio((_req, res, body) => {
      const url = new URL(_req.url ?? "/", "http://mock");
      switch (url.pathname) {
        case "/api/v1/models":
          return sendJson(res, 200, { models: [{ key: "test-local", loaded_instances: [{ id: "inst-1", config: { context_length: 4096 } }] }] });
        case "/api/v1/models/load":
          return sendJson(res, 200, { type: "llm", instance_id: "inst-1", load_time_seconds: 0.1, status: "loaded" });
        case "/api/v1/chat":
          const response = {
            ...chatResponseFixture,
            output: [{ type: "message", content: "not json" }],
          };
          if (wantsStream(body)) return sendChatStream(res, response);
          return sendJson(res, 200, response);
        default:
          return sendJson(res, 404, { error: `no mock route for ${url.pathname}` });
      }
    });

    try {
      d.profiles.updateProfile("d1-local-bad", { endpoint: { url: mock.url } });
      d.registry.upsert("d1-local-bad", { model_id: "test-local", roles: ["reviewer"], scores: {}, best_params: {}, last_tested: null });
      const result = await runSubAgent(d, "d1-local-bad", "review this file for bugs", { outputSchema: SCHEMA });
      expect(result.validation.issues.some((i) => i.startsWith("output_schema_invalid:"))).toBe(true);
    } finally {
      await mock.close();
      d.close();
      cleanup(home);
    }
  });

  it("serialises the schema in the nested OpenAI shape for every provider", () => {
    const nested = { type: "json_schema", json_schema: { name: "nanites_output", schema: SCHEMA } };
    expect(responseFormatFor("cloudflare", { type: "json_schema", schema: SCHEMA })).toEqual(nested);
    expect(responseFormatFor("openrouter", { type: "json_schema", schema: SCHEMA, name: "review" })).toEqual({
      type: "json_schema",
      json_schema: { name: "review", schema: SCHEMA },
    });
    // The flat form Cloudflare's docs describe is what the live endpoint 500s on
    // — pinning its absence keeps the regression from reappearing.
    expect(JSON.stringify(responseFormatFor("cloudflare", { type: "json_schema", schema: SCHEMA }))).not.toBe(
      JSON.stringify({ type: "json_schema", schema: SCHEMA }),
    );
    expect(responseFormatFor("cloudflare", { type: "json_object" })).toEqual({ type: "json_object" });
  });

  it("parses a fenced or prose-wrapped JSON answer rather than discarding it", () => {
    expect(parseStructured("```json\n" + VALID + "\n```", SCHEMA).ok).toBe(true);
    expect(parseStructured(`Here is the report:\n${VALID}\n`, SCHEMA).ok).toBe(true);
    expect(extractJson("no json here")).toBe("no json here");
    const bad = parseStructured('{"summary":"x"}', SCHEMA);
    expect(bad.ok).toBe(false);
    expect(bad.problems).toContain('missing required key "findings"');
    expect(parseStructured("just prose", SCHEMA).problems[0]).toMatch(/not valid JSON/);
    expect(parseStructured("[1,2,3]", SCHEMA).problems[0]).toMatch(/wants an object/);
  });
});
