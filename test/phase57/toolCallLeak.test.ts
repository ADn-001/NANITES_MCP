/**
 * Phase 57 gate — a leaked tool call must never be returned as an
 * answer. Two dialects are covered: the gpt-oss harmony form observed live in
 * a live role probe, and the `<tool_call>` form from the leaked job
 * samples. Parsing is strict: a malformed leak yields null, which the loop
 * turns into `tool_loop_no_answer` rather than an answer.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import {
  leakedToolCallDialect,
  looksLikeLeakedToolCall,
  parseLeakedToolCalls,
} from "../../src/helpers/toolCallLeak.js";
import { runCloudToolLoop } from "../../src/providers/cloudToolLoop.js";
import type { RouterOptions, RouteResult } from "../../src/providers/router.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

/** Verbatim from the live probe: the tool-call-leak defect as it happened. */
const HARMONY_LEAK =
  'analysis: need to read file.<|end|><|start|>assistantcommentary to=functions.read_file {"path":" src/providers/fsTools.ts"," limit":4000}<|call|>';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nanites-leak-"));
}

describe("Phase 57 — leaked tool-call detection", () => {
  it("detects and parses the gpt-oss harmony leak seen live", () => {
    expect(looksLikeLeakedToolCall(HARMONY_LEAK)).toBe(true);
    expect(leakedToolCallDialect(HARMONY_LEAK)).toBe("harmony");
    // Keys/values verbatim, stray leading spaces and all — the model wrote
    // `" limit"`, so the executor sees exactly what it asked for.
    expect(parseLeakedToolCalls(HARMONY_LEAK)).toEqual([
      { id: "call_leak_1", name: "read_file", arguments: { path: " src/providers/fsTools.ts", " limit": 4000 } },
    ]);
  });

  it("parses the canonical harmony form with channel + message tokens", () => {
    const text =
      '<|start|>assistant<|channel|>commentary to=functions.list_directory<|constrain|>json<|message|>{"path":"src"}<|call|>';
    expect(parseLeakedToolCalls(text)).toEqual([
      { id: "call_leak_1", name: "list_directory", arguments: { path: "src" } },
    ]);
  });

  it("parses the <tool_call> JSON and tag-attribute forms", () => {
    const json = '<tool_call>\n{"name": "read_file", "arguments": {"path": "src/a.ts"}}\n</tool_call>';
    expect(leakedToolCallDialect(json)).toBe("tool_call");
    expect(parseLeakedToolCalls(json)).toEqual([
      { id: "call_leak_1", name: "read_file", arguments: { path: "src/a.ts" } },
    ]);

    const tagged =
      "<tool_call>\n<function=read_file>\n<parameter=path>src/b.ts</parameter>\n</function>\n</tool_call>";
    expect(parseLeakedToolCalls(tagged)).toEqual([
      { id: "call_leak_1", name: "read_file", arguments: { path: "src/b.ts" } },
    ]);
  });

  it("returns null for an unbalanced arg_key/arg_value leak", () => {
    const malformed =
      "<tool_call>\n<function=read_file>\n<arg_key>path</arg_key>\n<arg_key>limit</arg_key>\n<arg_value>a.ts</arg_value>\n</function>\n</tool_call>";
    expect(looksLikeLeakedToolCall(malformed)).toBe(true);
    expect(parseLeakedToolCalls(malformed)).toBeNull();
  });

  it("is not fooled by prose, JSON answers, or an unterminated harmony fragment", () => {
    expect(looksLikeLeakedToolCall("Read src/helpers/cleaner.ts, then report the bug.")).toBe(false);
    expect(looksLikeLeakedToolCall('{"name":"nanites","version":"0.0.1"}')).toBe(false);
    expect(looksLikeLeakedToolCall("Call to=functions.read_file when you need a file.")).toBe(false);
    // No <|call|> terminator: the loop cannot know where the arguments end.
    expect(looksLikeLeakedToolCall('<|start|>assistant to=functions.read_file {"path":"a"}')).toBe(false);
    expect(parseLeakedToolCalls("plain prose")).toBeNull();
  });
});

describe("Phase 57 — the loop runs a read leak and refuses an unreadable one", () => {
  function harness(): { deps: ToolDeps; home: string } {
    const home = scratchHome();
    const deps = buildDeps(home);
    deps.profiles.createProfile({ name: "t", endpoint: { url: "http://127.0.0.1:1234" } });
    return { deps, home };
  }

  it("executes a leaked call and returns the model's real answer", async () => {
    const { deps, home } = harness();
    const profile = deps.profiles.getProfile("t")!;
    const root = tmpRoot();
    try {
      fs.writeFileSync(path.join(root, "seed.txt"), "hello from seed", "utf8");
      const seen: RouterOptions[] = [];
      const route = async (opts: RouterOptions): Promise<RouteResult> => {
        seen.push(opts);
        if (seen.length === 1) {
          // The exact F3 shape: content carries the call, tool_calls is empty.
          return {
            response: {
              content:
                '<|start|>assistantcommentary to=functions.read_file {"path":"seed.txt"}<|call|>',
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
      expect(result.tools_used).toEqual([{ tool: "read_file", output: expect.stringContaining("hello from seed") }]);
      expect(result.issues).toEqual(["tool_call_leak_parsed"]);
      // The second round carried the tool result, so the leak was really executed.
      expect(seen[1]!.messages.some((m) => m.role === "tool" && m.tool_call_id === "call_leak_1")).toBe(true);
    } finally {
      deps.close();
      cleanup(home, root);
    }
  });

  it("fails tool_loop_no_answer instead of answering with an unreadable leak", async () => {
    const { deps, home } = harness();
    const profile = deps.profiles.getProfile("t")!;
    const root = tmpRoot();
    try {
      const route = async (): Promise<RouteResult> => ({
        response: {
          // Names a tool Nanites never advertised: nothing safe to execute.
          content: '<|start|>assistantcommentary to=functions.delete_everything {"path":"/"}<|call|>',
        },
        provider: "generic",
        model_id: "g-model",
        call_uid: "uid-1",
        tokens_in: 10,
        tokens_out: 5,
        duration_ms: 100,
      });

      await expect(
        runCloudToolLoop({
          profile,
          db: deps.db,
          provider: "generic",
          effort: "medium",
          role: "reviewer",
          brief: "do something",
          fsGrant: { root, allowed_tools: ["read_file"] },
          route,
        }),
      ).rejects.toMatchObject({
        code: "tool_loop_no_answer",
        details: { leaked_tool_call: true, leak_parsed: false },
      });
    } finally {
      deps.close();
      cleanup(home, root);
    }
  });
});
