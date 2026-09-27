/**
 * Phase 29 gate (Phase C) — the jobs table is real persistence, not an
 * in-memory queue: rows survive a store reopen, status transitions are guarded,
 * and wipe (deleteAll / deleteBefore) clears them with the ephemeral buckets.
 */
import { describe, expect, it } from "vitest";
import { buildDeps } from "../../src/tools/deps.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

describe("Phase 29 gate — job persistence + wipe scope", () => {
  it("a job row survives a store reopen with its payload, status, owner and heartbeat", async () => {
    const home = scratchHome();
    let deps = buildDeps(home);
    const id = deps.jobs.create({ profile_name: "t", kind: "sub_agent", payload: { brief: "x" } });
    expect(deps.jobs.markRunning(id, "owner-a")).toBe(true);
    deps.close();

    // Reopen the same NANITES_HOME.
    deps = buildDeps(home);
    try {
      const row = deps.jobs.get(id);
      expect(row).not.toBeNull();
      expect(row!.status).toBe("running");
      expect(row!.kind).toBe("sub_agent");
      expect((row!.payload as { brief: string }).brief).toBe("x");
      expect(row!.owner_id).toBe("owner-a");
      expect(row!.heartbeat_at).not.toBeNull();
    } finally {
      deps.close();
      cleanup(home);
    }
  });

  it("markRunning is guarded: an already-claimed job cannot be claimed twice", () => {
    const home = scratchHome();
    const deps = buildDeps(home);
    try {
      const id = deps.jobs.create({ profile_name: "t", kind: "sub_agent", payload: {} });
      expect(deps.jobs.markRunning(id, "owner-a")).toBe(true);
      expect(deps.jobs.markRunning(id, "owner-b")).toBe(false);
      expect(deps.jobs.get(id)!.owner_id).toBe("owner-a");
    } finally {
      deps.close();
      cleanup(home);
    }
  });

  it("touchRunning refreshes only this owner's running rows", () => {
    const home = scratchHome();
    const deps = buildDeps(home);
    try {
      const mine = deps.jobs.create({ profile_name: "t", kind: "sub_agent", payload: {} });
      const other = deps.jobs.create({ profile_name: "t", kind: "sub_agent", payload: {} });
      const waiting = deps.jobs.create({ profile_name: "t", kind: "sub_agent", payload: {} });
      deps.jobs.markRunning(mine, "owner-a");
      deps.jobs.markRunning(other, "owner-b");

      const before = deps.jobs.get(other)!.heartbeat_at;
      expect(deps.jobs.touchRunning("owner-a")).toBe(1);
      expect(deps.jobs.get(other)!.heartbeat_at).toBe(before);
      expect(deps.jobs.get(waiting)!.heartbeat_at).toBeNull();
      expect(deps.jobs.listRunning().map((j) => j.id)).toEqual([mine, other]);
    } finally {
      deps.close();
      cleanup(home);
    }
  });

  it("wipe scopes: deleteBefore removes only older rows, deleteAll clears", () => {
    const home = scratchHome();
    const deps = buildDeps(home);
    try {
      const DAY_MS = 86_400_000;
      const old = new Date(Date.now() - 10 * DAY_MS).toISOString();
      const oldId = deps.jobs.create({ profile_name: "t", kind: "sub_agent", payload: {}, created_at: old });
      const recentId = deps.jobs.create({ profile_name: "t", kind: "sub_agent", payload: {} });
      const cutoff = new Date(Date.now() - 5 * DAY_MS).toISOString();

      expect(deps.jobs.deleteBefore("t", cutoff)).toBe(1);
      expect(deps.jobs.get(oldId)).toBeNull();
      expect(deps.jobs.get(recentId)).not.toBeNull();

      expect(deps.jobs.deleteAll("t")).toBe(1);
      expect(deps.jobs.get(recentId)).toBeNull();
    } finally {
      deps.close();
      cleanup(home);
    }
  });
});
