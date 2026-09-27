/**
 * Phase 56 gate — loop economics and observability.
 *
 * The 14-minute cloud run that motivated this phase could only be explained by
 * re-reading the database by hand: a round count tells a caller *that* something
 * was slow, not which round or what it was asked to do. These tests pin the
 * record that makes the next one diagnosable from its own output — which is what
 * the phase ended up being worth, its two "cheap levers" on the 860 s figure
 * having both been dropped on measurement.
 *
 * All of it runs through the injected router; no provider is contacted.
 */
import { afterAll, describe, expect, it } from "vitest";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { runCloudToolLoop } from "../../src/providers/cloudToolLoop.js";
import { runSubAgent } from "../../src/workflows/runSubAgent.js";
import type { RouteResult, RouterOptions } from "../../src/providers/router.js";
import type { ChatResponse } from "../../src/providers/types.js";
import type { Profile } from "../../src/storage/profileDefaults.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

const SCHEMA = {
  type: "object",
  properties: { findings: { type: "array" }, summary: { type: "string" } },
  required: ["findings", "summary"],
};
const VALID = JSON.stringify({ findings: [], summary: "ok" });

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
}

/** Router stand-in: replays a script, then repeats the last entry. Each round
 * reports a distinct duration and token count so sums can be checked against
 * the aggregates the loop computes. */
function scriptedRouter(script: Scripted[], seen: RouterOptions[]) {
  let i = 0;
  return async (opts: RouterOptions): Promise<RouteResult> => {
    seen.push(opts);
    const step = script[Math.min(i, script.length - 1)]!;
    i += 1;
    const response: ChatResponse = {
      content: step.content ?? "",
      finish_reason: step.calls ? "tool_calls" : "stop",
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
      tokens_in: 10 * i,
      tokens_out: 5 * i,
      duration_ms: 100 * i,
      finish_reason: response.finish_reason ?? null,
    };
  };
}

afterAll(() => {
  for (const d of depsList) d.close();
  cleanup(...scratchDirs);
});

describe("Phase 56 — loop economics and observability", () => {
  it("reports one round-detail entry per round, consistent with the totals", async () => {
    const { d, profile } = harness("d2-detail");
    const seen: RouterOptions[] = [];
    const res = await runCloudToolLoop({
      profile,
      db: d.db,
      provider: "cloudflare",
      modelId: "test/model",
      effort: "medium",
      role: "reviewer",
      brief: "review",
      fsGrant: { root: process.cwd() },
      route: scriptedRouter([{ calls: 2 }, { content: "done" }], seen),
    });

    expect(res.rounds).toBe(2);
    expect(res.rounds_detail).toHaveLength(2);
    expect(res.rounds_detail[0]).toMatchObject({ round: 0, tools_advertised: true, tokens_out: 5 });
    expect(res.rounds_detail[1]).toMatchObject({ round: 1, finish_reason: "stop", tokens_out: 10 });
    // The per-round numbers have to add up to the aggregate, or the detail is a
    // second, disagreeing source of truth.
    expect(res.rounds_detail.reduce((s, r) => s + r.infer_ms, 0)).toBe(res.duration_ms);
    expect(res.rounds_detail.reduce((s, r) => s + r.tokens_out, 0)).toBe(res.tokens_out);
  });

  it("records the finalize round as an entry of its own, with tools off", async () => {
    const { d, profile } = harness("d2-finalize-detail");
    const seen: RouterOptions[] = [];
    const res = await runCloudToolLoop({
      profile,
      db: d.db,
      provider: "cloudflare",
      modelId: "test/model",
      effort: "medium",
      role: "reviewer",
      brief: "review",
      fsGrant: { root: process.cwd() },
      outputSchema: SCHEMA,
      route: scriptedRouter([{ calls: 1 }, { content: "prose" }, { content: VALID }], seen),
    });

    expect(res.rounds).toBe(3);
    expect(res.rounds_detail.map((r) => r.tools_advertised)).toEqual([true, true, false]);
    expect(res.structured).toEqual({ valid: true, finalized: true, problems: [] });
  });

  it("carries the loop instruction only when tools are advertised", async () => {
    const { d, profile } = harness("d2-batching");
    const seen: RouterOptions[] = [];
    await runCloudToolLoop({
      profile,
      db: d.db,
      provider: "cloudflare",
      modelId: "test/model",
      effort: "medium",
      role: "reviewer",
      brief: "review",
      fsGrant: { root: process.cwd() },
      route: scriptedRouter([{ content: "done" }], seen),
    });
    expect(seen[0]!.systemPrompt).toMatch(/After you have read all necessary files/);

    // A tool-less cloud run has no loop to exit — the instruction would be noise
    // in the system prompt of every non-tool call.
    const { d: d2, profile: p2 } = harness("d2-batching-tool-less", false);
    const seen2: RouterOptions[] = [];
    await runSubAgent(d2, p2.name, "summarise this", {
      provider: "cloudflare",
      model_id: "@cf/test/model",
      route: scriptedRouter([{ content: "summary" }], seen2),
    });
    expect(seen2).toHaveLength(1);
    expect(seen2[0]!.systemPrompt ?? "").not.toMatch(/After you have read all necessary files/);
  });

  it("surfaces the round detail in metrics without dropping the existing keys", async () => {
    const { d, profile } = harness("d2-metrics");
    const seen: RouterOptions[] = [];
    const res = await runSubAgent(d, profile.name, "review these files", {
      provider: "cloudflare",
      model_id: "@cf/test/model",
      route: scriptedRouter([{ calls: 1 }, { content: "report" }], seen),
    });

    expect(res.metrics.rounds).toBe(2);
    expect(res.metrics.rounds_detail?.map((r) => r.round)).toEqual([0, 1]);
    expect(res.metrics.infer_ms).toBe(
      res.metrics.rounds_detail!.reduce((s, r) => s + r.infer_ms, 0),
    );
    // The five original keys are the contract callers already depend on.
    expect(typeof res.metrics.load_ms).toBe("number");
    expect(typeof res.metrics.ttft_ms).toBe("number");
    expect(typeof res.metrics.t_s).toBe("number");
    expect(res.tools_used).toHaveLength(1);
  });

  it("omits the round detail when the run was a single tool-less request", async () => {
    const { d, profile } = harness("d2-metrics-tool-less", false);
    const res = await runSubAgent(d, profile.name, "summarise this", {
      provider: "cloudflare",
      model_id: "@cf/test/model",
      route: scriptedRouter([{ content: "summary" }], []),
    });

    expect(res.metrics.rounds).toBeUndefined();
    expect(res.metrics.rounds_detail).toBeUndefined();
    expect(typeof res.metrics.infer_ms).toBe("number");
  });
});
