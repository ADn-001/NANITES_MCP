/**
 * Phase 39 gate — cloud provider FS tool loop.
 * Validates:
 * 1. fsTools path confinement + allowlist + the five executors (unit, real disk)
 * 2. chat() parses OpenAI `tool_calls` into the ChatResponse (per provider client)
 * 3. runCloudToolLoop executes model-issued calls Nanites-side, re-injects
 *    `role:"tool"` results, and loops until the model answers (injected route)
 * 4. Round cap truncates a runaway tool-calling model
 * 5. Profile `tools.fs` grant round-trips create/get and passes the read zod
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import {
  buildFsToolDefs,
  executeFsTool,
  FS_TOOL_NAMES,
  resolveWithinRoot,
} from "../../src/providers/fsTools.js";
import { runCloudToolLoop } from "../../src/providers/cloudToolLoop.js";
import { buildCloudChatRequest, planCloudInference } from "../../src/providers/cloudPlanner.js";
import { GenericClient, serializeChatRequest } from "../../src/providers/client.js";
import type { RouterOptions, RouteResult } from "../../src/providers/router.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nanites-fs-"));
}

describe("fsTools confinement + allowlist", () => {
  it("resolveWithinRoot accepts descendants and refuses escapes", () => {
    const root = tmpRoot();
    try {
      expect(resolveWithinRoot(root, "a/b.txt").ok).toBe(true);
      expect(resolveWithinRoot(root, "./a.txt").ok).toBe(true);
      expect(resolveWithinRoot(root, path.join(root, "sub", "f.txt")).ok).toBe(true);
      const up = resolveWithinRoot(root, "../escape.txt");
      expect(up.ok).toBe(false);
      const absOut = resolveWithinRoot(root, path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nanites-out-")), "x"));
      expect(absOut.ok).toBe(false);
      const empty = resolveWithinRoot(root, "");
      expect(empty.ok).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("buildFsToolDefs defaults to the read-only set and filters by allowlist (H5)", () => {
    // write_file is no longer in the default set: a bare tools.fs: {} used
    // to hand a cloud sub-agent arbitrary write access to process.cwd().
    const defs = buildFsToolDefs(null);
    expect(defs).toHaveLength(FS_TOOL_NAMES.length - 1);
    expect(defs.map((d) => d.function.name)).not.toContain("write_file");
    const one = buildFsToolDefs({ allowed_tools: ["read_file"] });
    expect(one).toHaveLength(1);
    expect(one[0]!.function.name).toBe("read_file");
    // Invalid allowlist names are dropped; if nothing resolves, nothing is
    // advertised rather than falling back to the full set (H3).
    const junk = buildFsToolDefs({ allowed_tools: ["read_file", "rm_rf", "exec"] });
    expect(junk).toHaveLength(1);
    expect(buildFsToolDefs({ allowed_tools: ["rm_rf"] })).toHaveLength(0);
    // write_file is available when explicitly requested.
    const w = buildFsToolDefs({ allowed_tools: ["write_file"] });
    expect(w).toHaveLength(1);
  });

  it("executeFsTool refuses unknown + non-allowlisted tools", async () => {
    const root = tmpRoot();
    try {
      const unknown = await executeFsTool({ root }, "destroy_everything", {});
      expect(unknown.ok).toBe(false);
      expect(unknown.output).toContain("unknown tool");
      const denied = await executeFsTool({ root, allowed_tools: ["read_file"] }, "write_file", {});
      expect(denied.ok).toBe(false);
      expect(denied.output).toContain("not in the allowed set");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("write/read/list round-trip inside the root", async () => {
    const root = tmpRoot();
    try {
      fs.mkdirSync(path.join(root, "sub"));
      // write_file is opt-in.
      const grant = { root, allowed_tools: ["write_file", "read_file", "list_directory"] as const };
      const w = await executeFsTool(grant, "write_file", {
        path: "sub/note.txt",
        content: "hello world",
      });
      expect(w.ok).toBe(true);
      expect(w.output).toContain("wrote 11 bytes");

      const r = await executeFsTool(grant, "read_file", { path: "sub/note.txt" });
      expect(r.ok).toBe(true);
      expect(r.output).toContain("hello world");

      const l = await executeFsTool(grant, "list_directory", { path: "sub" });
      expect(l.ok).toBe(true);
      expect(l.output).toContain("note.txt");

      // Escape refused at execution, not only at resolve.
      const esc = await executeFsTool(grant, "read_file", { path: "../../etc/passwd" });
      expect(esc.ok).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("chat() parses OpenAI tool_calls", () => {
  it("GenericClient maps message.tool_calls into ChatResponse.tool_calls", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        id: "tool-1",
        choices: [
          {
            message: {
              role: "assistant",
              content: "Let me check the file.",
              tool_calls: [
                {
                  id: "call_abc",
                  type: "function",
                  function: { name: "read_file", arguments: '{"path":"seed.txt"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    })) as typeof fetch;

    try {
      const client = new GenericClient("http://127.0.0.1:1234/v1");
      const resp = await client.chat({ model: "m", messages: [{ role: "user", content: "read it" }] }, "k");
      expect(resp.content).toBe("Let me check the file.");
      expect(resp.tool_calls).toHaveLength(1);
      expect(resp.tool_calls![0]!.name).toBe("read_file");
      expect(resp.tool_calls![0]!.id).toBe("call_abc");
      expect(resp.tool_calls![0]!.arguments).toEqual({ path: "seed.txt" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("malformed tool-call arguments degrade to {} instead of crashing", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        choices: [
          {
            message: {
              role: "assistant",
              content: "oops",
              tool_calls: [
                { id: "c1", type: "function", function: { name: "read_file", arguments: "{not json" } },
              ],
            },
          },
        ],
      }),
    })) as typeof fetch;

    try {
      const client = new GenericClient("http://127.0.0.1:1234/v1");
      const resp = await client.chat({ model: "m", messages: [{ role: "user", content: "hi" }] }, "k");
      expect(resp.tool_calls).toHaveLength(1);
      expect(resp.tool_calls![0]!.arguments).toEqual({});
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("serializeChatRequest maps assistant tool_calls to OpenAI wire shape", () => {
    // Regression: Cloudflare's strict OpenAI-compat validator rejects the
    // replayed assistant turn unless tool_calls carry {id, type, function}.
    const out = serializeChatRequest({
      model: "m",
      messages: [
        { role: "system", content: "sys" },
        {
          role: "assistant",
          content: "Reading.",
          tool_calls: [{ id: "call_1", name: "read_file", arguments: { path: "seed.txt", limit: 10 } }],
        },
        { role: "tool", content: "file contents", tool_call_id: "call_1" },
        { role: "user", content: "thanks" },
      ],
    });
    const msgs = out.messages as Array<Record<string, unknown>>;
    const asst = msgs[1] as { tool_calls?: unknown[] };
    expect(asst.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "read_file", arguments: JSON.stringify({ path: "seed.txt", limit: 10 }) },
      },
    ]);
    // role:"tool" answer keeps its tool_call_id; plain messages pass through.
    expect(msgs[2]).toEqual({ role: "tool", content: "file contents", tool_call_id: "call_1" });
    expect(msgs[3]).toEqual({ role: "user", content: "thanks" });
  });
});

describe("runCloudToolLoop", () => {
  const homes: ToolDeps[] = [];
  afterEach(() => {
    for (const d of homes.splice(0)) {
      d.close();
      cleanup(d.home);
    }
  });
  afterAll(() => {
    for (const d of homes.splice(0)) {
      d.close();
      cleanup(d.home);
    }
  });

  function harness(): { deps: ToolDeps } {
    const deps = buildDeps(scratchHome());
    homes.push(deps);
    deps.profiles.createProfile({ name: "t", endpoint: { url: "http://127.0.0.1:1234" } });
    return { deps };
  }

  it("executes read_file, re-injects the tool result, and returns the final answer", async () => {
    const { deps } = harness();
    const profile = deps.profiles.getProfile("t")!;
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "seed.txt"), "hello from seed", "utf8");

    const seen: RouterOptions[] = [];
    const route = async (opts: RouterOptions): Promise<RouteResult> => {
      seen.push(opts);
      const round = seen.length;
      if (round === 1) {
        return {
          response: {
            content: "Reading the file now.",
            tool_calls: [{ id: "call_1", name: "read_file", arguments: { path: "seed.txt" } }],
          },
          provider: "generic",
          model_id: "g-model",
          call_uid: "uid-1",
          tokens_in: 10,
          tokens_out: 5,
          duration_ms: 100,
        };
      }
      return {
        response: { content: "The seed says: hello from seed" },
        provider: "generic",
        model_id: "g-model",
        call_uid: "uid-2",
        tokens_in: 30,
        tokens_out: 10,
        duration_ms: 200,
      };
    };

    const result = await runCloudToolLoop({
      profile,
      db: deps.db,
      provider: "generic",
      effort: "medium",
      role: "reviewer",
      brief: "Read seed.txt and summarize it.",
      fsGrant: { root, allowed_tools: ["read_file"] },
      route,
    });

    expect(result.reply).toBe("The seed says: hello from seed");
    expect(result.rounds).toBe(2);
    expect(result.tools_used).toEqual([{ tool: "read_file", output: expect.stringContaining("hello from seed") }]);
    expect(result.tokens_in).toBe(40);
    expect(result.tokens_out).toBe(15);
    expect(result.duration_ms).toBe(300);
    expect(result.truncated).toBeUndefined();

    // Round 2 carried a role:"tool" message answering call_1 with file contents.
    const r2 = seen[1]!;
    const toolMsg = r2.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.tool_call_id).toBe("call_1");
    expect(toolMsg!.content).toContain("hello from seed");
    // And the assistant turn that issued the call precedes it.
    expect(r2.messages.some((m) => m.role === "assistant" && m.tool_calls?.length === 1)).toBe(true);
    // Tools were advertised to the provider.
    expect(r2.tools).toBeDefined();
    expect(r2.tools!.some((t) => t.function.name === "read_file")).toBe(true);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("caps runaway tool loops and flags truncation", async () => {
    const { deps } = harness();
    const profile = deps.profiles.getProfile("t")!;
    const root = tmpRoot();

    let round = 0;
    const route = async (opts: RouterOptions): Promise<RouteResult> => {
      round += 1;
      return {
        response: {
          content: `round ${round}`,
          tool_calls: [{ id: `call_${round}`, name: "list_directory", arguments: { path: "." } }],
        },
        provider: "generic",
        model_id: "g-model",
        call_uid: `uid-${round}`,
        tokens_in: 1,
        tokens_out: 1,
        duration_ms: 1,
      };
    };

    const result = await runCloudToolLoop({
      profile,
      db: deps.db,
      provider: "generic",
      effort: "low",
      role: "summarizer",
      brief: "loop forever",
      fsGrant: { root },
      route,
    });

    expect(result.rounds).toBe(7); // 6 executed + 1 capped
    expect(result.tools_used).toHaveLength(6);
    expect(result.truncated).toContain("cap reached");
    expect(result.reply).toBe("round 7");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("profile tools.fs grant round-trips through create/get (zod accepts it)", () => {
    const { deps } = harness();
    const root = tmpRoot();
    deps.profiles.createProfile({
      name: "fs",
      tools: { enabled: true, integrations: [], fs: { root, allowed_tools: ["read_file"] } },
    });
    const p = deps.profiles.getProfile("fs")!;
    expect(p.tools?.enabled).toBe(true);
    expect(p.tools?.fs?.root).toBe(root);
    expect(p.tools?.fs?.allowed_tools).toEqual(["read_file"]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("cloud planner provider-native reasoning", () => {
  // Regression: run_sub_agent on openrouter failed with 400 "reasoning:
  // Invalid input: expected object, received string" — we sent the raw
  // Nanites reasoning flag. OpenRouter wants an effort object; OpenAI-compat
  // endpoints want a reasoning_effort string; Cloudflare gets reasoning_effort
  // unconditionally — "low" when we did not ask for
  // reasoning, which measurably suppresses default-on thinking.
  it("maps reasoning per provider", () => {
    const plan = planCloudInference("medium", "reviewer");
    const mk = (provider: "cloudflare" | "openrouter" | "generic") =>
      buildCloudChatRequest(plan, provider, "m", [{ role: "user", content: "hi" }]);

    expect((mk("openrouter").reasoning as { effort: string }).effort).toBe("medium");
    expect(mk("openrouter").reasoning_effort).toBeUndefined();

    expect(mk("generic").reasoning_effort).toBe("medium");
    expect(mk("generic").reasoning).toBeUndefined();

    const cf = mk("cloudflare");
    expect(cf.reasoning).toBeUndefined();
    expect(cf.reasoning_effort).toBe("medium");
    expect("reasoning" in cf).toBe(false);
    expect("chat_template_kwargs" in cf).toBe(false);
  });

  it("omits reasoning entirely at low effort", () => {
    const plan = planCloudInference("low", "reviewer");
    const req = buildCloudChatRequest(plan, "openrouter", "m", [{ role: "user", content: "hi" }]);
    expect("reasoning" in req).toBe(false);
    expect(req.reasoning_effort).toBeUndefined();
  });
});
