/**
 * Phase 16 — dynamic_model profile field + /nanites-dynamic-model + run_sub_agent
 * param schema. Asserts the field defaults, persists, toggles, rejects bad
 * types, and that the slash command chain + new run_sub_agent params are wired.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type ToolHarness } from "../phase5/helpers.js";
import { DEFAULT_DYNAMIC_MODEL } from "../../src/storage/profileDefaults.js";

describe("dynamic_model profile field", () => {
  let h: ToolHarness;

  afterEach(async () => {
    await h?.close();
  });

  it("defaults to true", async () => {
    h = await createHarness();
    await h.callTool("create_profile", { name: "p" });
    const { profile } = await h.callTool("get_active_profile", {});
    expect(DEFAULT_DYNAMIC_MODEL).toBe(true);
    // create_profile does not switch; read the stored profile via list_profiles verbose
    const res = await h.callTool("list_profiles", { verbose: true });
    const p = (res.data!.profiles as Array<{ name: string; dynamic_model: boolean }>).find((x) => x.name === "p")!;
    expect(p.dynamic_model).toBe(true);
  });

  it("persists dynamic_model: false at create", async () => {
    h = await createHarness();
    await h.callTool("create_profile", { name: "p", dynamic_model: false });
    const res = await h.callTool("list_profiles", { verbose: true });
    const p = (res.data!.profiles as Array<{ name: string; dynamic_model: boolean }>).find((x) => x.name === "p")!;
    expect(p.dynamic_model).toBe(false);
  });

  it("update_profile toggles it on/off", async () => {
    h = await createHarness();
    await h.callTool("create_profile", { name: "p" });
    await h.callTool("update_profile", { profile: "p", dynamic_model: false });
    let res = await h.callTool("list_profiles", { verbose: true });
    let p = (res.data!.profiles as Array<{ name: string; dynamic_model: boolean }>).find((x) => x.name === "p")!;
    expect(p.dynamic_model).toBe(false);
    await h.callTool("update_profile", { profile: "p", dynamic_model: true });
    res = await h.callTool("list_profiles", { verbose: true });
    p = (res.data!.profiles as Array<{ name: string; dynamic_model: boolean }>).find((x) => x.name === "p")!;
    expect(p.dynamic_model).toBe(true);
  });

  it("rejects a non-boolean dynamic_model", async () => {
    h = await createHarness();
    const raw = await h.callToolRaw("create_profile", { name: "p", dynamic_model: "yes" });
    expect(raw.isError).toBe(true);
  });

  it("accepts inference.system_prompt on create and update", async () => {
    h = await createHarness();
    await h.callTool("create_profile", { name: "p", inference: { system_prompt: "You are a stern reviewer." } });
    let res = await h.callTool("list_profiles", { verbose: true });
    let p = (res.data!.profiles as Array<{ name: string; inference?: { system_prompt?: string } }>).find((x) => x.name === "p")!;
    expect(p.inference?.system_prompt).toBe("You are a stern reviewer.");
    await h.callTool("update_profile", { profile: "p", inference: { system_prompt: null } });
    res = await h.callTool("list_profiles", { verbose: true });
    p = (res.data!.profiles as Array<{ name: string; inference?: { system_prompt?: string | null } }>).find((x) => x.name === "p")!;
    expect(p.inference?.system_prompt).toBeNull();
  });
});

describe("run_sub_agent — new per-call params accepted; removed params still rejected", () => {
  let h: ToolHarness;

  afterEach(async () => {
    await h?.close();
  });

  it("accepts system_prompt_override", async () => {
    h = await createHarness();
    const res = await h.callTool("run_sub_agent", {
      profile: "t",
      model_id: "gemma-3-270m-it-qat",
      brief: "Summarize this.",
      system_prompt_override: "Answer in one word.",
    });
    expect(res.ok).toBe(true);
  });

  it("accepts reasoning_budget", async () => {
    h = await createHarness();
    const res = await h.callTool("run_sub_agent", {
      profile: "t",
      model_id: "gemma-3-270m-it-qat",
      brief: "Summarize this.",
      reasoning_budget: 500,
    });
    expect(res.ok).toBe(true);
  });

  it("rejects a non-positive reasoning_budget", async () => {
    h = await createHarness();
    const raw = await h.callToolRaw("run_sub_agent", {
      profile: "t",
      model_id: "gemma-3-270m-it-qat",
      brief: "Summarize this.",
      reasoning_budget: -5,
    });
    expect(raw.isError).toBe(true);
  });

  it("still rejects the removed reasoning param", async () => {
    h = await createHarness();
    const raw = await h.callToolRaw("run_sub_agent", {
      profile: "t",
      model_id: "gemma-3-270m-it-qat",
      brief: "x",
      reasoning: "on",
    });
    expect(raw.isError).toBe(true);
  });
});
