/**
 * Effort-triad sprint — profile-level inference resolution + partial patch.
 * Asserts the effort/ceiling defaults resolve correctly and that an update
 * patch merges into the existing inference block without wiping the ceiling.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type ToolHarness } from "../phase5/helpers.js";

describe("profile inference effort + ceiling", () => {
  let h: ToolHarness;

  afterEach(async () => {
    await h?.close();
  });

  it("defaults to medium effort / 8192 ceiling when inference omitted", async () => {
    h = await createHarness();
    const p = h.deps.profiles.getProfile("t")!;
    expect(p.inference?.effort).toBe("medium");
    expect(p.inference?.output_token_ceiling).toBe(8192);
  });

  it("create honors explicit effort and keeps the ceiling default", async () => {
    h = await createHarness();
    h.deps.profiles.createProfile({ name: "hi", inference: { effort: "high" } });
    const p = h.deps.profiles.getProfile("hi")!;
    expect(p.inference?.effort).toBe("high");
    expect(p.inference?.output_token_ceiling).toBe(8192);
  });

  it("update_profile effort patch merges without wiping the ceiling", async () => {
    h = await createHarness();
    h.deps.profiles.createProfile({ name: "hi", inference: { effort: "high", output_token_ceiling: 16000 } });
    const updated = h.deps.profiles.updateProfile("hi", { inference: { effort: "low" } });
    expect(updated.inference?.effort).toBe("low");
    expect(updated.inference?.output_token_ceiling).toBe(16000);
  });

  it("update_profile rejects an invalid effort value via the tool schema", async () => {
    h = await createHarness();
    const raw = await h.callToolRaw("update_profile", {
      profile: "t",
      inference: { effort: "extreme" },
    });
    expect(raw.isError).toBe(true);
  });
});
