/**
 * Phase 33 gate (Phase F, D8) — command drift-guard. The 9 command sheets under
 * plugin/nanites/commands are prose guidance, not generated copies of the
 * prompt bodies, so a declared manifest + a deterministic check keeps them
 * honest: every sheet is declared, every registered prompt is declared
 * (paired or sheetless), every tool a sheet names resolves in toolkit.ts, and a
 * paired sheet's first step matches its prompt's first tool call. The guard is
 * proven to detect drift by seeding artificial cases — then removing them
 * (synthetic inputs to the pure check, never edits to the real files).
 */
import { describe, expect, it } from "vitest";
import {
  checkNanitesSurface,
  COMMAND_SHEETS,
  PROMPT_ONLY_SHEETLESS,
  sheetArgumentHint,
  surfaceProblems,
  toolMentions,
  type SurfaceReportInput,
} from "../../src/server/commandsManifest.js";

function baseInput(): SurfaceReportInput {
  const sheetText = new Map<string, string>();
  for (const s of COMMAND_SHEETS) {
    sheetText.set(s.command, `---\ndescription: x\nargument-hint: "${s.argumentHint}"\n---\n\n1. Call \`get_active_profile\`.\n`);
  }
  const registeredTools = new Set(["get_active_profile", "get_cost_saved_report", "list_profiles"]);
  return {
    diskCommands: COMMAND_SHEETS.map((s) => s.command),
    registeredPrompts: [...COMMAND_SHEETS.flatMap((s) => (s.prompt ? [s.prompt!] : [])), ...PROMPT_ONLY_SHEETLESS],
    registeredTools,
    sheetText,
    promptFirstTool: new Map([["nanites-cost-saved", "get_active_profile"]]),
  };
}

describe("Phase 33 gate — drift-guard parser primitives", () => {
  it("toolMentions finds call targets including an 'and x' chain", () => {
    expect(toolMentions("1. Call `list_profiles` and `get_active_profile` on the MCP server.")).toEqual([
      "list_profiles",
      "get_active_profile",
    ]);
    // "per-call `effort`"-style prose is a directive, not a tool mention.
    expect(toolMentions("...versus per-call `effort` overrides on `run_sub_agent`.")).toEqual([]);
  });

  it("sheetArgumentHint reads the frontmatter hint", () => {
    expect(sheetArgumentHint('---\ndescription: d\nargument-hint: "[all|day|week|month]"\n---\nbody')).toBe("[all|day|week|month]");
    expect(sheetArgumentHint("no frontmatter")).toBe("");
  });
});

describe("Phase 33 gate — the guard passes on the real repo", () => {
  it("no drift across sheets, prompts, tools, and the cost-saved fix", () => {
    expect(checkNanitesSurface()).toEqual([]);
  });
});

describe("Phase 33 gate — the guard detects drift (seeded, then removed)", () => {
  it("a command naming an unregistered tool is flagged", () => {
    const input = baseInput();
    input.sheetText.set("nanites-cost-saved", "1. Call `no_such_tool` on the Nanites MCP server.");
    const problems = surfaceProblems(input);
    expect(problems).toContain("nanites-cost-saved: names unregistered tool `no_such_tool`");
  });

  it("a registered prompt with no manifest entry (paired or sheetless) is flagged", () => {
    const input = baseInput();
    input.registeredPrompts.push("nanites-ghost");
    const problems = surfaceProblems(input);
    expect(problems).toContain("registered prompt has no manifest entry (sheet or sheetless): nanites-ghost");
  });

  it("the pre-fix cost-saved sheet (no get_active_profile step) is flagged by first-tool parity", () => {
    const input = baseInput();
    // The stale sheet jumped straight to the report; its prompt resolves the
    // active profile first. The guard must catch the dropped resolution step.
    input.sheetText.set(
      "nanites-cost-saved",
      '---\ndescription: d\nargument-hint: "[all|day|week|month]"\n---\n1. Call `get_cost_saved_report` with the period from the arguments.',
    );
    const problems = surfaceProblems(input);
    expect(problems).toContain(
      "nanites-cost-saved: first step `get_cost_saved_report` != its prompt's first tool `get_active_profile`",
    );
  });

  it("a stale argument-hint (the old 7d|30d|all) is flagged against the tool enum", () => {
    const input = baseInput();
    input.sheetText.set(
      "nanites-cost-saved",
      '---\ndescription: d\nargument-hint: "[7d|30d|all]"\n---\n1. Call `get_active_profile`.\n2. Call `get_cost_saved_report`.',
    );
    const problems = surfaceProblems(input);
    expect(problems).toContain('nanites-cost-saved: argument-hint "[7d|30d|all]" != declared "[all|day|week|month]"');
  });

  it("an undocumented command sheet is flagged", () => {
    const input = baseInput();
    input.diskCommands.push("nanites-rogue");
    input.sheetText.set("nanites-rogue", "1. Call `list_profiles`.");
    const problems = surfaceProblems(input);
    expect(problems).toContain("undocumented command sheet: nanites-rogue (add to COMMAND_SHEETS)");
  });
});
