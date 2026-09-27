/**
 * Phase 58 gate — the empty answer round discards a completed tool run.
 *
 * Reproduced live on `@cf/openai/gpt-oss-120b` 4 runs in 6: the loop
 * reads files across the tool rounds, then makes the one round that runs with
 * no tools on the wire, at the requested effort — and the model emits a few
 * dozen characters of reasoning and stops. `chatWithBudgetRetry` retries once
 * at double budget, gets the identical empty answer, and throws; the throw
 * escaped `runCloudToolLoop` uncaught, so every file the run had read was
 * thrown away with it.
 *
 * The first fix (an instruction folded into the SYSTEM PROMPT, transcript still
 * ending on `role:"tool"`) was measured at 0 content in 6 of 6 attempts.
 * What replaced it is a rebuilt transcript: one `user` message carrying the
 * brief and the tool results, with no tool continuation
 * for the model to bail out of. These tests pin that shape, its gate, and — the
 * point of the whole fix — that a run which did work reports that work even
 * when the rescue also fails.
 *
 * The second half of the same defect is the cap: the audit brief names eight
 * files, the model reads one per round, and a fixed cap of six cut it off mid-read and
 * then asked it to answer. The cap is now planned from the brief and extended
 * while the model is still finding new files.
 *
 * A refused leaked call reaches the same dead end by a second
 * trigger — the model writes its call into `content` in a dialect Nanites will
 * not execute, the loop refuses rather than answering with markup, and the run
 * ends holding every file it read. That path arms the same rescue; the gate is
 * still the transcript, so a leak on a run that read nothing is refused as
 * before.
 */
import { afterAll, describe, expect, it } from "vitest";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import {
  buildRescueDocument,
  namedFileCount,
  plannedToolRounds,
  runCloudToolLoop,
  stableToolKey,
  TOOL_ROUND_CEILING,
  TOOL_ROUND_FLOOR,
} from "../../src/providers/cloudToolLoop.js";
import { runSubAgent } from "../../src/workflows/runSubAgent.js";
import type { RouteResult, RouterOptions } from "../../src/providers/router.js";
import type { ChatResponse } from "../../src/providers/types.js";
import type { Profile } from "../../src/storage/profileDefaults.js";
import { NanitesError } from "../../src/helpers/errors.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

const SCHEMA = {
  type: "object",
  properties: { findings: { type: "array" }, summary: { type: "string" } },
  required: ["findings", "summary"],
};
const VALID = JSON.stringify({ findings: [], summary: "ok" });

/** Names no allowlisted path, so the cap is the floor — see `plannedToolRounds`. */
const PLAIN_BRIEF = "review the files";
/** The live audit's shape: eight files named, one read per round. */
const EIGHT_FILES = [
  "src/index.ts",
  "src/server/buildServer.ts",
  "src/server/prompts.ts",
  "src/server/commandsManifest.ts",
  "src/tools/toolkit.ts",
  "src/tools/deps.ts",
  "src/tools/responses.ts",
  "src/tools/providers.ts",
].join("\n");

const scratchDirs: string[] = [];
const depsList: ToolDeps[] = [];

function harness(name: string, tools = true): { d: ToolDeps; profile: Profile } {
  const home = scratchHome();
  scratchDirs.push(home);
  const d = buildDeps(home);
  depsList.push(d);
  d.profiles.createProfile({
    name,
    ...(tools ? { tools: { enabled: true, integrations: [], fs: { root: process.cwd() } } } : {}),
  });
  d.profiles.switchProfile(name);
  return { d, profile: d.profiles.getProfile(name)! };
}

interface Scripted {
  content?: string;
  calls?: number;
  /** Path for each generated `read_file` call — distinct paths are progress. */
  path?: string;
  /** Fail this round instead of answering. */
  fail?: string;
  /** `details` carried on that error — the merge path is asserted against it. */
  failDetails?: Record<string, unknown>;
}

/** `n` scripted rounds, each reading a different file. */
const distinctReads = (n: number): Scripted[] =>
  Array.from({ length: n }, (_, i) => ({ calls: 1, path: `file${i}.ts` }) satisfies Scripted);

/** Router stand-in: replays a script, then repeats the last entry. */
function scriptedRouter(
  script: Scripted[],
  seen: RouterOptions[],
  pins: Array<string | undefined> = [],
) {
  let i = 0;
  return async (opts: RouterOptions, _provider?: unknown, modelId?: string): Promise<RouteResult> => {
    seen.push(opts);
    pins.push(modelId);
    const step = script[Math.min(i, script.length - 1)]!;
    i += 1;
    if (step.fail) {
      throw new NanitesError({
        code: step.fail,
        message: `scripted ${step.fail}`,
        retryable: true,
        ...(step.failDetails ? { details: step.failDetails } : {}),
      });
    }
    const response: ChatResponse = {
      content: step.content ?? "",
      finish_reason: step.calls ? "tool_calls" : "stop",
      ...(step.calls
        ? {
            tool_calls: Array.from({ length: step.calls }, (_, n) => ({
              id: `call_${i}_${n}`,
              name: "read_file",
              arguments: { path: step.path ?? "package.json" },
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

/**
 * Every tool round the floor allows, so round `TOOL_ROUND_FLOOR` is the answer
 * round. The calls repeat the same path, so no extension fires — the loop in
 * this script is deliberately not making progress.
 */
const FULL_READ = Array.from(
  { length: TOOL_ROUND_FLOOR },
  () => ({ calls: 1 }) satisfies Scripted,
);

const BUDGET_FAIL: Scripted = {
  fail: "provider_budget_exhausted",
  failDetails: { model_id: "test/model", finish_reason: "stop", attempted_budget: 32768 },
};

function loop(
  d: ToolDeps,
  profile: Profile,
  script: Scripted[],
  outputSchema?: Record<string, unknown>,
  brief = PLAIN_BRIEF,
) {
  const seen: RouterOptions[] = [];
  const pins: Array<string | undefined> = [];
  const run = runCloudToolLoop({
    profile,
    db: d.db,
    provider: "cloudflare",
    modelId: "test/model",
    effort: "medium",
    role: "reviewer",
    brief,
    fsGrant: { root: process.cwd() },
    ...(outputSchema ? { outputSchema } : {}),
    route: scriptedRouter(script, seen, pins),
  });
  return { run, seen, pins };
}

/** The rescue is the only round whose transcript is a rebuilt document. */
const isRescue = (opts: RouterOptions): boolean =>
  opts.messages.length === 1 &&
  opts.messages[0]!.role === "user" &&
  /answer the original request/i.test(String(opts.messages[0]!.content ?? ""));

const documentOf = (opts: RouterOptions): string => String(opts.messages.at(-1)?.content ?? "");

afterAll(() => {
  for (const d of depsList) d.close();
  cleanup(...scratchDirs);
});

describe("Phase 58 — F6 answer-round rescue", () => {
  it("rescues a run whose answer round threw, keeping the tool work", async () => {
    const { d, profile } = harness("f6-thrown");
    const { run } = loop(d, profile, [...FULL_READ, BUDGET_FAIL, { content: "final report" }]);
    const res = await run;

    expect(res.reply).toBe("final report");
    // Six tool rounds plus the rescue — the thrown round produces no RouteResult.
    expect(res.rounds).toBe(7);
    expect(res.rounds_detail.at(-1)).toMatchObject({ round: 6, tools_advertised: false });
    expect(res.tools_used).toHaveLength(TOOL_ROUND_FLOOR);
    expect(res.tools_used[0]!.tool).toBe("read_file");
    expect(res.issues).toContain("answer_round_rescued");
  });

  it("rescues a run whose answer round returned empty", async () => {
    const { d, profile } = harness("f6-empty");
    const { run } = loop(d, profile, [...FULL_READ, { content: "" }, { content: "rescued report" }]);
    const res = await run;

    expect(res.reply).toBe("rescued report");
    expect(res.issues).toContain("answer_round_rescued");
  });

  it("answers the rescue round from a rebuilt document, not a tool transcript", async () => {
    const { d, profile } = harness("f6-shape");
    const { run, seen, pins } = loop(d, profile, [
      ...FULL_READ,
      BUDGET_FAIL,
      { content: "final report" },
    ]);
    await run;

    const rescue = seen.at(-1)!;
    // Tools off — the whole point is that the model stops reaching for files.
    expect(rescue.tools).toBeUndefined();
    expect(rescue.effort).toBe("low");
    // Cloudflare rejects a `user` turn directly after `role:"tool"` (HTTP 400 /
    // code 8007), and a transcript ending on `tool` is the shape measured at 0
    // content in 6 of 6 — so the rescue carries a document instead: exactly one
    // message, a `user` turn, with no assistant turn and no tool results.
    expect(rescue.messages).toHaveLength(1);
    expect(rescue.messages[0]!.role).toBe("user");
    expect(rescue.messages.some((m) => m.role === "tool")).toBe(false);
    expect(rescue.messages.some((m) => m.role === "assistant")).toBe(false);
    const doc = documentOf(rescue);
    expect(doc).toContain(PLAIN_BRIEF);
    expect(doc).toContain("read_file");
    expect(doc).toContain("package.json");
    expect(doc).toContain("answer the original request");
    // The loop's own instruction is addressed to a model that is still reading;
    // carrying it into a document-answer turn is half of what broke the v1 fix.
    expect(rescue.systemPrompt ?? "").not.toMatch(/produce your final report/i);
    // Pinned to the model the answer round already failed on, rather than
    // re-walking the registry at every other model's expense.
    expect(pins.at(-1)).toBe("test/model");
  });

  it("does not rescue a run that executed no tools", async () => {
    const { d, profile } = harness("f6-no-tools");

    const thrown = loop(d, profile, [BUDGET_FAIL]);
    await expect(thrown.run).rejects.toMatchObject({ code: "provider_budget_exhausted" });
    expect(thrown.seen).toHaveLength(1);

    const empty = loop(d, profile, [{ content: "" }]);
    await expect(empty.run).rejects.toMatchObject({ code: "tool_loop_no_answer" });
    expect(empty.seen).toHaveLength(1);
  });

  it("still fails when the rescue round is empty too, and says what the run read", async () => {
    const { d, profile } = harness("f6-rescue-empty");
    const { run, seen } = loop(d, profile, [...FULL_READ, BUDGET_FAIL, { content: "" }]);

    await expect(run).rejects.toMatchObject({
      code: "provider_budget_exhausted",
      retryable: false,
      details: {
        tools_executed: ["read_file"],
        rescue_attempted: true,
        rescued: false,
        // The original error's own details survive the merge.
        model_id: "test/model",
        finish_reason: "stop",
        attempted_budget: 32768,
      },
    });
    // Two document-shaped rounds: the final answer round (now itself
    // a document) plus exactly one rescue, which failed. The fix must not turn a
    // failed run into a retry loop that spends provider calls on a model that is
    // not answering.
    expect(seen.filter(isRescue)).toHaveLength(2);
  });

  it("hands a schema run the same document instead of rescuing twice", async () => {
    const { d, profile } = harness("f6-schema");
    const { run, seen } = loop(
      d,
      profile,
      [...FULL_READ, BUDGET_FAIL, { content: VALID }],
      SCHEMA,
    );
    const res = await run;

    expect(res.structured).toEqual({ valid: true, finalized: true, problems: [] });
    expect(JSON.parse(res.reply).summary).toBe("ok");
    // Six tool rounds plus the finalize; the finalize IS the rescue here.
    expect(res.rounds).toBe(7);
    expect(res.issues ?? []).not.toContain("answer_round_rescued");
    // The final answer round is now itself a document and matches
    // `isRescue`; the finalize does not (its instruction is /single JSON
    // value/). Exactly one doc-shaped round = the final round, no extra rescue.
    expect(seen.filter(isRescue)).toHaveLength(1);
    expect(seen.at(-1)!.responseFormat).toBeDefined();
    // The finalize round gets the document shape for the same reason the rescue
    // does: no assistant turn exists to carry the instruction, and the old
    // system-prompt-with-tool-tail fallback is the measured 0/6 shape.
    expect(seen.at(-1)!.messages).toHaveLength(1);
    expect(seen.at(-1)!.messages[0]!.role).toBe("user");
    expect(documentOf(seen.at(-1)!)).toMatch(/single JSON value/);
  });

  it("keeps the system-prompt fallback for a schema run with no transcript", async () => {
    const { d, profile } = harness("f6-schema-no-tools");
    const { run, seen } = loop(d, profile, [{ content: "" }, { content: VALID }], SCHEMA);
    const res = await run;

    expect(res.structured).toMatchObject({ valid: true, finalized: true });
    expect(seen.at(-1)!.messages.at(-1)!.role).toBe("user");
    expect(seen.at(-1)!.systemPrompt ?? "").toMatch(/single JSON value/);
  });

  it("carries the rescue marker into validation.issues end to end", async () => {
    const { d, profile } = harness("f6-e2e");
    const seen: RouterOptions[] = [];
    const res = await runSubAgent(d, profile.name, PLAIN_BRIEF, {
      provider: "cloudflare",
      model_id: "@cf/test/model",
      route: scriptedRouter([...FULL_READ, BUDGET_FAIL, { content: "final report" }], seen),
    });

    expect(res.reply).toBe("final report");
    expect(res.validation.issues).toContain("answer_round_rescued");
  });

  it("leaves the capped and the unreadable-leak outcomes unchanged", async () => {
    const { d, profile } = harness("f6-unchanged");

    const capped = loop(d, profile, [{ calls: 1 }]);
    await expect(capped.run).rejects.toMatchObject({
      code: "tool_loop_no_answer",
      details: { rounds: 7, truncated: expect.stringContaining("cap reached") },
    });

    // A leak on the first round, before any tool work: there is no reading to
    // rescue, so the refusal still stands on its own. The rescue needs a
    // transcript, and this run has none.
    const leak = loop(d, profile, [{ content: UNADVERTISED_LEAK }]);
    await expect(leak.run).rejects.toMatchObject({
      code: "tool_loop_no_answer",
      details: { leaked_tool_call: true, leak_parsed: false },
    });
    expect(leak.seen).toHaveLength(1);
  });
});

/**
 * The second trigger for the same rescue. A refused leaked call
 * leaves the loop with `answered === false` and work in the transcript, exactly
 * like a dead answer round — and it was the last Shape A measured live, so it
 * gets the same document.
 */
const UNADVERTISED_LEAK =
  '<|start|>assistantcommentary to=functions.delete_everything {"path":"/"}<|call|>';

describe("Phase 58 — F6 refused-leak rescue", () => {
  it("rescues a run whose leaked call was refused, keeping what it read", async () => {
    const { d, profile } = harness("f6-leak-rescue");
    // Round 0 reads a file; round 1 writes an unadvertisable call into `content`
    // instead of `tool_calls`. Nanites refuses to execute it and refuses to
    // answer with the markup — before this the run died still holding the file
    // it had read.
    const { run, seen } = loop(d, profile, [
      { calls: 1, path: "package.json" },
      { content: UNADVERTISED_LEAK },
      { content: "rescued report" },
    ]);
    const res = await run;

    expect(res.reply).toBe("rescued report");
    expect(res.issues).toEqual(["tool_call_leak_detected", "answer_round_rescued"]);
    expect(res.tools_used).toHaveLength(1);
    // Same document shape as the answer-round rescue, carrying the read the
    // refused round was about to abandon.
    const rescue = seen.at(-1)!;
    expect(isRescue(rescue)).toBe(true);
    expect(rescue.tools).toBeUndefined();
    expect(documentOf(rescue)).toContain("package.json");
    expect(seen).toHaveLength(3);
  });

  it("sends a schema run's refused leak to the finalize document, not the rescue", async () => {
    const { d, profile } = harness("f6-leak-schema");
    const { run, seen } = loop(
      d,
      profile,
      [{ calls: 1, path: "package.json" }, { content: UNADVERTISED_LEAK }, { content: VALID }],
      SCHEMA,
    );
    const res = await run;

    expect(res.structured).toEqual({ valid: true, finalized: true, problems: [] });
    expect(res.issues ?? []).toContain("tool_call_leak_detected");
    // A schema caller already pays for the D1 finalize; it must not pay twice.
    expect(res.issues ?? []).not.toContain("answer_round_rescued");
    expect(seen.filter(isRescue)).toHaveLength(0);
    expect(seen.at(-1)!.responseFormat).toBeDefined();
    expect(seen.at(-1)!.messages).toHaveLength(1);
    expect(seen.at(-1)!.messages[0]!.role).toBe("user");
    expect(documentOf(seen.at(-1)!)).toContain("package.json");
  });
});

describe("Phase 58 — F6 adaptive round cap", () => {
  it("counts the files a brief names", () => {
    expect(namedFileCount(PLAIN_BRIEF)).toBe(0);
    expect(namedFileCount("Read seed.txt and summarize it.")).toBe(1);
    expect(namedFileCount(EIGHT_FILES)).toBe(8);
    // Not files: an extension-less word, a bare dotted word, a non-code suffix.
    expect(namedFileCount("check src/index and the api.v2 release notes")).toBe(0);
  });

  it("plans the cap from the brief, clamped to floor and ceiling", () => {
    // No signal: the old fixed value, so a caller that says nothing sees nothing new.
    expect(plannedToolRounds(PLAIN_BRIEF)).toBe(TOOL_ROUND_FLOOR);
    expect(plannedToolRounds("Read seed.txt and summarize it.")).toBe(TOOL_ROUND_FLOOR);
    // The live audit brief: eight files, one read per round, plus slack for the
    // listings — which lands on the ceiling rather than 11.
    expect(plannedToolRounds(EIGHT_FILES)).toBe(TOOL_ROUND_CEILING);
    // A brief naming more files than the ceiling allows still stops at it.
    expect(plannedToolRounds(distinctReads(30).map((s) => s.path).join(" "))).toBe(TOOL_ROUND_CEILING);
  });

  it("identifies a tool call regardless of argument key order", () => {
    expect(stableToolKey("read_file", { path: "a.ts", offset: 1 })).toBe(
      stableToolKey("read_file", { offset: 1, path: "a.ts" }),
    );
    expect(stableToolKey("read_file", { path: "a.ts" })).not.toBe(
      stableToolKey("read_file", { path: "b.ts" }),
    );
    expect(stableToolKey("list_directory", ".")).not.toBe(stableToolKey("read_file", "."));
  });

  it("sizes the cap to the brief and says so when it stops", async () => {
    const { d, profile } = harness("f6-cap-sizes");
    // Four named files plan a cap of seven instead of the floor of six, and
    // every round here repeats one read, so no extension muddies the count.
    const brief = "audit a.ts b.ts c.ts d.ts and report";
    const { run } = loop(d, profile, [{ calls: 1 }], undefined, brief);
    await expect(run).rejects.toMatchObject({
      code: "tool_loop_no_answer",
      details: {
        rounds: 8,
        truncated: expect.stringContaining("planned 7 from 4 file(s) named in the brief"),
      },
    });
  });

  it("keeps the planned cap when every round repeats the same read", async () => {
    const { d, profile } = harness("f6-cap-repeats");
    // Eight files named would plan 10, but the model re-reads one file forever:
    // repeats are not progress, so the cap stays where the brief put it.
    const { run, seen } = loop(d, profile, [{ calls: 1 }], undefined, EIGHT_FILES);
    await expect(run).rejects.toMatchObject({
      code: "tool_loop_no_answer",
      details: { rounds: 11, truncated: expect.stringContaining("cap reached") },
    });
    // Ten tool rounds executed before the tool-less round: the planned ceiling.
    expect(seen).toHaveLength(11);
  });

  it("buys a round when the model is still finding new files", async () => {
    const { d, profile } = harness("f6-cap-extends");
    // Six distinct reads from a brief that named nothing: at the floor the sixth
    // round would be the tool-less answer round, so reaching a seventh round
    // with tools still advertised is the extension doing its job.
    const { run } = loop(d, profile, [...distinctReads(TOOL_ROUND_FLOOR), { content: "done" }]);
    const res = await run;

    expect(res.reply).toBe("done");
    expect(res.rounds).toBe(7);
    expect(res.rounds_detail.at(-1)).toMatchObject({ round: 6, tools_advertised: true });
    expect(res.tools_used).toHaveLength(TOOL_ROUND_FLOOR);
  });

  it("does not extend past the ceiling", async () => {
    const { d, profile } = harness("f6-cap-ceiling");
    const { run, seen } = loop(d, profile, distinctReads(TOOL_ROUND_CEILING + 2));
    await expect(run).rejects.toMatchObject({
      code: "tool_loop_no_answer",
      details: { rounds: TOOL_ROUND_CEILING + 1, truncated: expect.stringContaining("cap reached") },
    });
    expect(seen).toHaveLength(TOOL_ROUND_CEILING + 1);
  });

  it("counts a leaked-call round as a round, and lets it extend", async () => {
    const { d, profile } = harness("f6-cap-leak");
    // Round 0 reads a file, round 1 writes its call into `content` instead of
    // `tool_calls`. That round is still work, so it must buy a round — visible
    // in the cap-reached message, which reports the extension.
    const { run } = loop(d, profile, [
      { calls: 1, path: "a.ts" },
      { content: '<|start|>assistantcommentary to=functions.read_file {"path":"b.ts"}<|call|>' },
      { calls: 1, path: "b.ts" },
    ]);
    await expect(run).rejects.toMatchObject({
      code: "tool_loop_no_answer",
      details: {
        rounds: 8,
        truncated: expect.stringContaining("extended 1 time(s) on progress"),
      },
    });
    const err = await run.catch((e: unknown) => e as NanitesError);
    const details = err.details as { tools_executed: string[] };
    // Seven executions: the direct read, the leaked read, and five repeats — so
    // the leaked round both counted and bought its extension.
    expect(details.tools_executed).toHaveLength(7);
  });
});

describe("Phase 58 — F6 rescue document", () => {
  it("is one user turn carrying the brief, each tool, its args and its output", () => {
    const doc = buildRescueDocument("summarize the repo", [
      { tool: "list_directory", args: { path: "." }, output: "a.ts\nb.ts" },
      { tool: "read_file", args: { path: "a.ts" }, output: "export const a = 1;" },
    ]);

    expect(doc).toHaveLength(1);
    expect(doc[0]!.role).toBe("user");
    const text = String(doc[0]!.content);
    expect(text).toContain("summarize the repo");
    expect(text).toContain("### 1. list_directory");
    expect(text).toContain('{"path":"a.ts"}');
    expect(text).toContain("export const a = 1;");
    expect(text).toContain("answer the original request");
  });

  it("omits the middle on overflow, keeping the first and the newest result", () => {
    const transcript = Array.from({ length: 20 }, (_, i) => {
      const n = i + 1;
      // The newest result is short so it survives clipping; the rest are sized
      // to overflow the document on their own.
      const pad = n === 20 ? "y".repeat(200) : "x".repeat(5_000);
      return { tool: `tool_${n}`, args: { n }, output: `FILE_${n}_START${pad}FILE_${n}_END` };
    });
    const text = String(buildRescueDocument("audit everything", transcript)[0]!.content);

    expect(text).toContain("tool result(s) omitted to cap this document at");
    expect(text).toContain("tool_1");
    expect(text).toContain("FILE_1_START");
    expect(text).toContain("FILE_20_END");
    // The middle is what went, and every entry was clipped before counting.
    expect(text).not.toContain("FILE_10_START");
    expect(text).toContain("[truncated:");
  });

  it("clips a single oversized result", () => {
    const text = String(
      buildRescueDocument("read it", [
        { tool: "read_file", args: { path: "big.ts" }, output: "y".repeat(9_000) },
      ])[0]!.content,
    );
    expect(text).toContain("[truncated:");
    expect(text.length).toBeLessThan(9_000);
  });
});

describe("Phase 58 — winning-shape final round", () => {
  it("A: sends the final answer round as a rebuilt document, not the tool transcript", async () => {
    const { d, profile } = harness("f6-doc-final");
    const { run, seen } = loop(d, profile, [...FULL_READ, { content: "final report" }]);
    const res = await run;
    expect(res.reply).toBe("final report");
    const last = seen.at(-1)!;
    // The final round must present the gathered results as one user document —
    // the shape proven to answer — not replay the tool-terminal transcript that
    // empties on gpt-oss-120b.
    expect(isRescue(last)).toBe(true);
    expect(last.messages.some((m) => m.role === "tool")).toBe(false);
    expect(last.messages.some((m) => m.role === "assistant")).toBe(false);
  });

  it("A: answers on the document round in one call, no rescue", async () => {
    const { d, profile } = harness("f6-doc-clean");
    const { run, seen } = loop(d, profile, [...FULL_READ, { content: "final report" }]);
    const res = await run;
    expect(res.reply).toBe("final report");
    expect(res.issues ?? []).not.toContain("answer_round_rescued");
    expect(seen).toHaveLength(TOOL_ROUND_FLOOR + 1);
  });

  it("B: rejects a runaway single-token blob instead of answering with it", async () => {
    const { d, profile } = harness("f6-runaway");
    const blob = "a".repeat(8000); // no whitespace: a loop/blob reply, not prose
    const { run } = loop(d, profile, [...FULL_READ, { content: blob }, { content: "clean rescue" }]);
    const res = await run;
    expect(res.reply).toBe("clean rescue");
    expect(res.reply).not.toBe(blob);
    expect(res.issues ?? []).toContain("answer_round_rescued");
  });
});
