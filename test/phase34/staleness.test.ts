/**
 * Phase 34 gate (Phase G, G-1) — staleness signal. Registry entries whose
 * `last_tested` is older than the threshold surface an informational flag on
 * the read_registry trimmed surface; fresh entries do not. Flag only — no
 * automatic re-test.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stalenessFor, STALE_AFTER_DAYS } from "../../src/helpers/staleness.js";
import { createHarness, type ToolHarness } from "../phase5/helpers.js";

const DAY_MS = 86_400_000;

describe("Phase 34 — stalenessFor (pure)", () => {
  it("an entry older than the threshold is stale, with a human note", () => {
    const now = Date.now();
    const old = stalenessFor(new Date(now - 40 * DAY_MS).toISOString(), now);
    expect(old.stale).toBe(true);
    expect(old.staleness_note).toContain(`${STALE_AFTER_DAYS}-day staleness threshold`);
    expect(old.staleness_note).toContain("40 days ago");
    expect(old.staleness_note).toMatch(/user decision/);
  });

  it("a fresh entry is not stale", () => {
    const now = Date.now();
    const fresh = stalenessFor(new Date(now - 1 * DAY_MS).toISOString(), now);
    expect(fresh.stale).toBe(false);
    expect(fresh.staleness_note).toBeNull();
  });

  it("an unset last_tested (never tested) is not treated as stale evidence", () => {
    expect(stalenessFor(null, Date.now())).toEqual({ stale: false, staleness_note: null });
  });

  it("the threshold is configurable", () => {
    const now = Date.now();
    const atSeven = stalenessFor(new Date(now - 7 * DAY_MS).toISOString(), now, 30);
    expect(atSeven.stale).toBe(false);
    const overSeven = stalenessFor(new Date(now - 8 * DAY_MS).toISOString(), now, 7);
    expect(overSeven.stale).toBe(true);
  });
});

describe("Phase 34 — read_registry surfaces the staleness signal", () => {
  let h: ToolHarness;

  beforeAll(async () => {
    h = await createHarness();
    const now = Date.now();
    // Fresh entry: tested yesterday.
    h.deps.registry.upsert("t", {
      model_id: "fresh-m",
      roles: ["code_writer"],
      scores: { quality: 80 },
      best_params: {},
      last_tested: new Date(now - 1 * DAY_MS).toISOString(),
    });
    // Stale entry: tested 40 days ago.
    h.deps.registry.upsert("t", {
      model_id: "old-m",
      roles: ["code_writer"],
      scores: { quality: 70 },
      best_params: {},
      last_tested: new Date(now - 40 * DAY_MS).toISOString(),
    });
  });
  afterAll(async () => {
    await h.close();
  });

  it("a fresh entry carries no staleness flag", async () => {
    const res = await h.callTool("read_registry", { profile: "t", model_id: "fresh-m" });
    expect(res.ok).toBe(true);
    const entry = (res.data as { entries: Array<Record<string, unknown>> }).entries[0]!;
    expect(entry.stale).toBe(false);
    expect(entry.staleness_note).toBeNull();
    expect(entry.last_tested).not.toBeNull();
  });

  it("an entry over the threshold is flagged with the informational note", async () => {
    const res = await h.callTool("read_registry", { profile: "t", model_id: "old-m" });
    expect(res.ok).toBe(true);
    const entry = (res.data as { entries: Array<Record<string, unknown>> }).entries[0]!;
    expect(entry.stale).toBe(true);
    expect(entry.staleness_note).toContain(`${STALE_AFTER_DAYS}-day staleness threshold`);
    expect(entry.model_id).toBe("old-m");
    // The entry still reads back intact (roles normalized by the lazy backfill
    // in this bare harness are not what the staleness flag tests).
    expect(entry.last_tested).not.toBeNull();
  });
});
