/**
 * Phase 34 gate (Phase G, G-2) — cross-profile duplicate-testing share. Two
 * profiles pointing at the SAME LM Studio instance (endpoint fingerprint =
 * normalized URL + auth presence) can opt into shared results via
 * share_test_results; different endpoints stay isolated. Only approved rows
 * travel — pending/staged/judged judgments stay with the profile that ran them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  endpointFingerprint,
  normalizeEndpointUrl,
  sameEndpoint,
} from "../../src/helpers/endpointFingerprint.js";
import { createHarness, type ToolHarness } from "../phase5/helpers.js";

describe("Phase 34 — endpoint fingerprint (pure)", () => {
  it("normalizes trailing slashes and case", () => {
    expect(normalizeEndpointUrl("http://LocalHost:1234///")).toBe("http://localhost:1234");
  });

  it("same URL + same auth presence -> same fingerprint", () => {
    expect(endpointFingerprint("http://localhost:1234", true)).toBe(endpointFingerprint("http://localhost:1234/", true));
    expect(sameEndpoint({ url: "http://localhost:1234", authPresent: false }, { url: "http://localhost:1234/", authPresent: false })).toBe(true);
  });

  it("auth presence is part of the fingerprint (never the token value)", () => {
    expect(endpointFingerprint("http://localhost:1234", true)).not.toBe(endpointFingerprint("http://localhost:1234", false));
  });

  it("different endpoints isolate", () => {
    expect(sameEndpoint({ url: "http://localhost:1234", authPresent: true }, { url: "http://localhost:4321", authPresent: true })).toBe(false);
  });

  it("the fingerprint leaks no machine-specific string or token", () => {
    const fp = endpointFingerprint("http://localhost:1234", true);
    expect(fp).toMatch(/^fp_[0-9a-f]{16}$/);
    expect(fp).not.toContain("localhost");
  });
});

describe("Phase 34 — share_test_results tool", () => {
  let h: ToolHarness;
  const SHARED_URL = "http://localhost:1234";

  beforeAll(async () => {
    h = await createHarness();
    // src + target point at the same instance (same auth presence); other does not.
    h.deps.profiles.createProfile({ name: "src", endpoint: { url: SHARED_URL } });
    h.deps.profiles.createProfile({ name: "target", endpoint: { url: `${SHARED_URL}/` } });
    h.deps.profiles.createProfile({ name: "other", endpoint: { url: "http://localhost:4321" } });

    // Approved evidence in src: one approved row (sharable) + one pending row
    // (must NOT cross — the run owner still owes the judgment).
    h.deps.testResults.insert({
      profile_name: "src", model_id: "m1", unit_id: "quality", status: "approved",
      candidate: "baseline", test_run: 1, score: 91, user_approved: true,
    });
    h.deps.testResults.insert({
      profile_name: "src", model_id: "m1", unit_id: "role-fitness", status: "pending",
      candidate: "baseline", test_run: 1, user_approved: false,
    });
  });
  afterAll(async () => {
    await h.close();
  });

  it("same endpoint fingerprint: opt-in share copies approved results only", async () => {
    const res = await h.callTool("share_test_results", { profile: "target", source_profile: "src" });
    expect(res.ok).toBe(true);
    const data = res.data as { copied: number; skipped: number; endpoint_fingerprint: string };
    expect(data.copied).toBe(1);
    expect(data.skipped).toBe(0);
    expect(data.endpoint_fingerprint).toMatch(/^fp_[0-9a-f]{16}$/);

    const targetRows = h.deps.testResults.list("target", "m1");
    expect(targetRows.some((r) => r.unit_id === "quality" && r.status === "approved" && r.score === 91)).toBe(true);
    // Pending stays in the run-owner's profile only.
    expect(targetRows.some((r) => r.unit_id === "role-fitness")).toBe(false);
  });

  it("re-sharing is idempotent: the same approved row is skipped, not duplicated", async () => {
    const res = await h.callTool("share_test_results", { profile: "target", source_profile: "src" });
    const data = res.data as { copied: number; skipped: number };
    expect(data.copied).toBe(0);
    expect(data.skipped).toBe(1);
    const rows = h.deps.testResults.list("target", "m1").filter((r) => r.unit_id === "quality" && r.status === "approved");
    expect(rows).toHaveLength(1);
  });

  it("different endpoint fingerprint: refused with a structured error, nothing copied", async () => {
    const res = await h.callTool("share_test_results", { profile: "other", source_profile: "src" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("endpoint_mismatch");
    expect(res.error?.message).toContain("endpoint");
    expect(h.deps.testResults.list("other", "m1")).toHaveLength(0);
  });

  it("sharing with yourself is refused", async () => {
    const res = await h.callTool("share_test_results", { profile: "src", source_profile: "src" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("share_self");
  });

  it("unknown profiles are refused with profile_not_found", async () => {
    const res = await h.callTool("share_test_results", { profile: "target", source_profile: "ghost" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("profile_not_found");
  });
});
