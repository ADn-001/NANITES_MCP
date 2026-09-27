/**
 * Phase 50 gate. No path through the cloud tool loop may
 * return `reply: ""`.
 *
 * The old loop set `truncated` and returned an empty string, which left the
 * caller with nothing to show and no error to react to. It now raises
 * `tool_loop_no_answer` instead. Asserted exhaustively over the stub router's
 * outcome space: the model always answers, answers late, never answers, or
 * stops calling tools on the final round.
 *
 * Also pinned here: per-round effort. Rounds that advertise tools run at `low`
 * effort (routing a tool call is cheap thinking); the final, tool-less round
 * hands the gathered results as a document and runs at `low` effort
 * — the measured shape that answers, where the requested effort on a
 * tool-terminal transcript is the empty-answer shape on gpt-oss-120b. Cost is
 * governed by `reasoning_effort`, not by the token ceiling.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { runCloudToolLoop } from "../../src/providers/cloudToolLoop.js";
import type { RouteResult, RouterOptions } from "../../src/providers/router.js";

const TEMP_DIRS: string[] = [];

function scratchHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nanites-p50-"));
  TEMP_DIRS.push(dir);
  return dir;
}

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nanites-p50-root-"));
  TEMP_DIRS.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of TEMP_DIRS.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
afterAll(() => {
  for (const d of TEMP_DIRS.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function harness(): ToolDeps {
  const deps = buildDeps(scratchHome());
  deps.profiles.createProfile({ name: "t", endpoint: { url: "http://127.0.0.1:1234" } });
  return deps;
}

function result(content: string, calls: Array<{ id: string; name: string }> = []): RouteResult {
  return {
    response: {
      content,
      ...(calls.length > 0
        ? { tool_calls: calls.map((c) => ({ id: c.id, name: c.name, arguments: { path: "." } })) }
        : {}),
    },
    provider: "generic",
    model_id: "g-model",
    call_uid: "uid",
    tokens_in: 1,
    tokens_out: 1,
    duration_ms: 1,
  };
}

const readCall = [{ id: "c1", name: "read_file" }];

describe("Phase 50 — the loop never returns an empty reply", () => {
  it("answers on the first round when the model needs no tools", async () => {
    const deps = harness();
    const route = async (): Promise<RouteResult> => result("direct answer");

    const out = await runCloudToolLoop({
      profile: deps.profiles.getProfile("t")!,
      db: deps.db,
      provider: "generic",
      effort: "medium",
      role: "reviewer",
      brief: "answer me",
      fsGrant: { root: tmpRoot() },
      route,
    });

    expect(out.reply).toBe("direct answer");
    expect(out.rounds).toBe(1);
    expect(out.truncated).toBeUndefined();
    deps.close();
  });

  it("raises tool_loop_no_answer when the model calls tools forever without ever speaking", async () => {
    const deps = harness();
    let n = 0;
    const route = async (): Promise<RouteResult> => {
      n += 1;
      return result("", [{ id: `c${n}`, name: "list_directory" }]);
    };

    await expect(
      runCloudToolLoop({
        profile: deps.profiles.getProfile("t")!,
        db: deps.db,
        provider: "generic",
        effort: "medium",
        role: "reviewer",
        brief: "loop forever",
        fsGrant: { root: tmpRoot() },
        route,
      }),
    ).rejects.toMatchObject({
      code: "tool_loop_no_answer",
      retryable: false,
      details: { rounds: 7, truncated: expect.stringContaining("cap reached") },
    });
    deps.close();
  });

  it("keeps an early answer even when later rounds emit no text", async () => {
    const deps = harness();
    let n = 0;
    const route = async (): Promise<RouteResult> => {
      n += 1;
      // Round 1 speaks and asks for a tool; every later round is tool-only.
      return result(n === 1 ? "partial answer" : "", [readCall[0]!]);
    };

    const out = await runCloudToolLoop({
      profile: deps.profiles.getProfile("t")!,
      db: deps.db,
      provider: "generic",
      effort: "medium",
      role: "reviewer",
      brief: "read and answer",
      fsGrant: { root: tmpRoot() },
      route,
    });

    expect(out.reply).toBe("partial answer");
    deps.close();
  });

  it("answers on the final tool-less round and flags nothing", async () => {
    const deps = harness();
    const seen: Array<{ round: number; toolsAdvertised: boolean }> = [];
    let n = 0;
    const route = async (opts: RouterOptions): Promise<RouteResult> => {
      n += 1;
      seen.push({ round: n, toolsAdvertised: opts.tools !== undefined });
      // Calls tools until tools stop being advertised, then answers.
      return opts.tools !== undefined ? result("", [readCall[0]!]) : result("final report");
    };

    const out = await runCloudToolLoop({
      profile: deps.profiles.getProfile("t")!,
      db: deps.db,
      provider: "generic",
      effort: "medium",
      role: "reviewer",
      brief: "read then answer",
      fsGrant: { root: tmpRoot() },
      route,
    });

    expect(out.reply).toBe("final report");
    expect(out.truncated).toBeUndefined();
    // Six tool rounds, then a tool-less answer round.
    expect(out.rounds).toBe(7);
    expect(seen.filter((s) => s.toolsAdvertised)).toHaveLength(6);
    expect(seen.at(-1)!.toolsAdvertised).toBe(false);
    deps.close();
  });
});

describe("Phase 50 — per-round effort", () => {
  it("uses low effort on tool rounds and low effort on the document answer round", async () => {
    const deps = harness();
    const efforts: string[] = [];
    const route = async (opts: RouterOptions): Promise<RouteResult> => {
      efforts.push(opts.effort);
      return opts.tools !== undefined ? result("", [readCall[0]!]) : result("done");
    };

    await runCloudToolLoop({
      profile: deps.profiles.getProfile("t")!,
      db: deps.db,
      provider: "generic",
      effort: "high",
      role: "reviewer",
      brief: "brief",
      fsGrant: { root: tmpRoot() },
      route,
    });

    expect(efforts.slice(0, -1).every((e) => e === "low")).toBe(true);
    // The last round (a rebuilt document, not the tool transcript) is also low.
    expect(efforts.at(-1)).toBe("low");
    deps.close();
  });

  it("keeps the requested effort throughout when no tools are granted", async () => {
    const deps = harness();
    const efforts: string[] = [];
    const route = async (opts: RouterOptions): Promise<RouteResult> => {
      efforts.push(opts.effort);
      return result("tool-less answer");
    };

    await runCloudToolLoop({
      profile: deps.profiles.getProfile("t")!,
      db: deps.db,
      provider: "generic",
      effort: "high",
      role: "reviewer",
      brief: "brief",
      fsGrant: null,
      route,
    });

    expect(efforts).toEqual(["high"]);
    deps.close();
  });
});
