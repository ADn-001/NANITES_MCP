/**
 * Phase 16 — /nanites-dynamic-model slash command. Registered, names the
 * get_active_profile -> update_profile -> get_active_profile chain, and toggles
 * the active profile's dynamic_model.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createPhase11Harness, type Phase11Harness } from "../phase11/helpers.js";

describe("/nanites-dynamic-model", () => {
  let h: Phase11Harness;

  afterEach(async () => {
    await h?.close();
  });

  it("is registered alongside the other nanites commands", async () => {
    h = await createPhase11Harness();
    const prompts = await h.listPrompts();
    expect(prompts).toEqual(expect.arrayContaining(["nanites-dynamic-model", "nanites-effort"]));
  });

  it("names the resolve -> toggle -> confirm chain for off", async () => {
    h = await createPhase11Harness();
    const { text } = await h.getPrompt("nanites-dynamic-model", { mode: "off" });
    expect(text).toContain("get_active_profile");
    expect(text).toContain("update_profile");
    expect(text).toContain("dynamic_model = false");
    expect(text).toContain("confirm the toggle took effect");
  });

  it("sets dynamic_model true for mode on", async () => {
    h = await createPhase11Harness();
    const { text } = await h.getPrompt("nanites-dynamic-model", { mode: "on" });
    expect(text).toContain("dynamic_model = true");
  });
});
