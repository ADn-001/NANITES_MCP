/**
 * Phase 11 gate — first-run flow + the four /nanites-... slash commands.
 *
 * Each slash command is an MCP prompt whose single user message names the
 * exact tool chain, in order. The gate verifies by call assertions, not just
 * final state: for each prompt, the tool names named in the returned text
 * must equal the expected chain, and then executing that chain must record
 * exactly those calls.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPhase11Harness, type Phase11Harness } from "./helpers.js";

/** The `call \`tool\`` directives a prompt message names, in order. */
function chainFromPrompt(text: string): string[] {
  return [...text.matchAll(/call `([a-z_]+)`/g)].map((m) => m[1]!);
}

describe("Phase 11 gate — slash commands", () => {
  let h: Phase11Harness;

  beforeEach(async () => {
    h = await createPhase11Harness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("registers all four slash commands as prompts", async () => {
    const prompts = await h.listPrompts();
    expect(prompts).toEqual(
      expect.arrayContaining(["nanites-new-profile", "nanites-switch-profile", "nanites-profiles", "nanites-cost-saved"]),
    );
  });

  it("nanites-new-profile names the create -> switch -> confirm chain", async () => {
    const { text } = await h.getPrompt("nanites-new-profile", { name: "alpha", use_case: "code-review" });
    expect(chainFromPrompt(text)).toEqual(["create_profile", "switch_profile", "get_active_profile"]);
    // The prompt must pass the user's fields through, not invent defaults.
    expect(text).toContain('"alpha"');
    expect(text).toContain('"code-review"');
    expect(text).not.toMatch(/machine_specs\s*=\s*{[^}]*cpu/); // no invented specs
  });

  it("nanites-new-profile chain, executed, creates and activates the profile", async () => {
    const { text } = await h.getPrompt("nanites-new-profile", { name: "alpha" });
    const [create, sw, confirm] = chainFromPrompt(text);
    const created = await h.callTool(create!, { name: "alpha", use_case: "code-review" });
    expect(created.ok).toBe(true);
    expect(await h.callTool(sw!, { name: "alpha" })).toMatchObject({ ok: true });
    const active = await h.callTool(confirm!, {});
    expect((active.data as { profile: { name: string } }).profile.name).toBe("alpha");
    expect(h.calls.map((c) => c.name)).toEqual(["create_profile", "switch_profile", "get_active_profile"]);
  });

  it("nanites-switch-profile names switch -> confirm and switches", async () => {
    h.deps.profiles.createProfile({ name: "beta" });
    const { text } = await h.getPrompt("nanites-switch-profile", { name: "beta" });
    expect(chainFromPrompt(text)).toEqual(["switch_profile", "get_active_profile"]);
    expect(await h.callTool("switch_profile", { name: "beta" })).toMatchObject({ ok: true });
    const active = await h.callTool("get_active_profile", {});
    expect((active.data as { profile: { name: string } }).profile.name).toBe("beta");
    expect(h.calls.map((c) => c.name)).toEqual(["switch_profile", "get_active_profile"]);
  });

  it("nanites-profiles names list -> active and lists with the active marked", async () => {
    const { text } = await h.getPrompt("nanites-profiles");
    expect(chainFromPrompt(text)).toEqual(["list_profiles", "get_active_profile"]);
    const listed = await h.callTool("list_profiles", {});
    expect((listed.data as { profiles: string[] }).profiles).toContain("t");
    const active = await h.callTool("get_active_profile", {});
    expect((active.data as { profile: { name: string } }).profile.name).toBe("t");
    expect(h.calls.map((c) => c.name)).toEqual(["list_profiles", "get_active_profile"]);
  });

  it("nanites-cost-saved names active -> report and produces a report for the active profile", async () => {
    h.deps.callLogs.insert({ profile_name: "t", model_id: "m1", tokens_in: 100, tokens_out: 50, duration_ms: 10 });
    const { text } = await h.getPrompt("nanites-cost-saved", { period: "week" });
    expect(chainFromPrompt(text)).toEqual(["get_active_profile", "get_cost_saved_report"]);
    expect(text).toContain('"week"');
    const active = await h.callTool("get_active_profile", {});
    const report = await h.callTool("get_cost_saved_report", { profile: "t", period: "week" });
    expect(report.ok).toBe(true);
    expect((report.data as { calls: number }).calls).toBe(1);
    expect(h.calls.map((c) => c.name)).toEqual(["get_active_profile", "get_cost_saved_report"]);
  });
});

describe("Phase 11 gate — first-run flow", () => {
  let h: Phase11Harness;

  beforeEach(async () => {
    h = await createPhase11Harness({ createProfile: false });
  });
  afterEach(async () => {
    await h.close();
  });

  it("zero profiles: get_first_run_status reports needs_first_run", async () => {
    const res = await h.callTool("get_first_run_status", {});
    expect(res.ok).toBe(true);
    const data = res.data as { needs_first_run: boolean; profile_count: number };
    expect(data.needs_first_run).toBe(true);
    expect(data.profile_count).toBe(0);
  });

  it("first-run flow matches /nanites-new-profile field-for-field and ends with an active profile", async () => {
    // The skill routes a zero-profile session into the same prompt as the
    // slash command; first-run status flips only after the chain runs.
    const { text } = await h.getPrompt("nanites-new-profile", { name: "first" });
    expect(chainFromPrompt(text)).toEqual(["create_profile", "switch_profile", "get_active_profile"]);

    expect(await h.callTool("create_profile", { name: "first" })).toMatchObject({ ok: true });
    expect(await h.callTool("switch_profile", { name: "first" })).toMatchObject({ ok: true });
    const active = await h.callTool("get_active_profile", {});
    expect((active.data as { profile: { name: string } }).profile.name).toBe("first");

    const again = await h.callTool("get_first_run_status", {});
    expect((again.data as { needs_first_run: boolean }).needs_first_run).toBe(false);

    expect(h.calls.map((c) => c.name)).toEqual([
      "create_profile", "switch_profile", "get_active_profile", "get_first_run_status",
    ]);
  });

  it("a profile existing means needs_first_run is false", async () => {
    h.deps.profiles.createProfile({ name: "pre" });
    const res = await h.callTool("get_first_run_status", {});
    expect((res.data as { needs_first_run: boolean; profile_count: number }).needs_first_run).toBe(false);
    expect((res.data as { profile_count: number }).profile_count).toBe(1);
  });
});
