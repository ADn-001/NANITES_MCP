/**
 * Phase 58 gate — queue recovery at boot. A process that dies
 * mid-run leaves `running` rows the runner will never look at again, and a
 * queue left by a long-dead session must not be drained as if it were current
 * work. The sweep must also stay safe with several MCP processes on one DB:
 * only rows whose owner stopped heartbeating are reclaimable.
 */
import { describe, expect, it } from "vitest";
import { buildDeps } from "../../src/tools/deps.js";
import { QUEUE_TTL_MS, sweepOrphanedJobs } from "../../src/workflows/jobRecovery.js";
import { createSubAgentHarness } from "../phase8/helpers.js";
import { getRunner, getSubAgentJobStatus, startSubAgentJob } from "../../src/workflows/jobRunner.js";
import { waitFor } from "../phase29/helpers.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

const HOUR_MS = 60 * 60 * 1000;

function errorCode(deps: ReturnType<typeof buildDeps>, id: number): string | null {
  return deps.jobs.get(id)!.error_code;
}

describe("Phase 58 gate — boot queue recovery", () => {
  it("reclaims a running job whose owner stopped heartbeating", () => {
    const home = scratchHome();
    const deps = buildDeps(home);
    try {
      const id = deps.jobs.create({ profile_name: "t", kind: "sub_agent", payload: {} });
      deps.jobs.markRunning(id, "dead-owner");

      // Two hours later: the heartbeat is far past the staleness window.
      const result = sweepOrphanedJobs(deps, { now: new Date(Date.now() + 2 * HOUR_MS) });

      expect(result.orphaned).toBe(1);
      const row = deps.jobs.get(id)!;
      expect(row.status).toBe("error");
      expect(row.error_code).toBe("job_orphaned");
    } finally {
      deps.close();
      cleanup(home);
    }
  });

  it("leaves a fresh other-owner run and this owner's own run alone", () => {
    const home = scratchHome();
    const deps = buildDeps(home);
    try {
      const live = deps.jobs.create({ profile_name: "t", kind: "sub_agent", payload: {} });
      deps.jobs.markRunning(live, "other-process");
      const mine = deps.jobs.create({ profile_name: "t", kind: "sub_agent", payload: {} });
      deps.jobs.markRunning(mine, "me");

      expect(sweepOrphanedJobs(deps, { ownerId: "me" })).toEqual({ orphaned: 0, expired: 0 });
      expect(deps.jobs.get(live)!.status).toBe("running");
      expect(deps.jobs.get(mine)!.status).toBe("running");
    } finally {
      deps.close();
      cleanup(home);
    }
  });

  it("keeps this owner's own stale run — it is still alive", () => {
    const home = scratchHome();
    const deps = buildDeps(home);
    try {
      const mine = deps.jobs.create({ profile_name: "t", kind: "sub_agent", payload: {} });
      deps.jobs.markRunning(mine, "me");

      const result = sweepOrphanedJobs(deps, { ownerId: "me", now: new Date(Date.now() + 2 * HOUR_MS) });

      expect(result.orphaned).toBe(0);
      expect(deps.jobs.get(mine)!.status).toBe("running");
    } finally {
      deps.close();
      cleanup(home);
    }
  });

  it("expires a queued job past the TTL and resumes a recent one", () => {
    const home = scratchHome();
    const deps = buildDeps(home);
    try {
      const stale = deps.jobs.create({
        profile_name: "t",
        kind: "sub_agent",
        payload: {},
        created_at: new Date(Date.now() - QUEUE_TTL_MS - HOUR_MS).toISOString(),
      });
      const recent = deps.jobs.create({ profile_name: "t", kind: "sub_agent", payload: {} });

      const result = sweepOrphanedJobs(deps);

      expect(result.expired).toBe(1);
      const row = deps.jobs.get(stale)!;
      expect(row.status).toBe("error");
      expect(row.error_code).toBe("job_expired");
      expect(errorCode(deps, recent)).toBeNull();
      expect(deps.jobs.get(recent)!.status).toBe("queued");
    } finally {
      deps.close();
      cleanup(home);
    }
  });

  it("a runner built with a queued row present does not start it on its own", async () => {
    const h = await createSubAgentHarness();
    try {
      // A row left behind by another session, with no runner in this process
      // yet — constructing one is exactly the old "resume on construction" path.
      const left = h.deps.jobs.create({ profile_name: "t", kind: "sub_agent", payload: { brief: "yesterday" } });
      getRunner(h.deps);
      await new Promise((r) => setTimeout(r, 30));

      expect(h.deps.jobs.get(left)!.status).toBe("queued");
      expect(h.counts.chats).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("an expired queue never runs, while a fresh enqueue does", async () => {
    const h = await createSubAgentHarness();
    try {
      const old = h.deps.jobs.create({
        profile_name: "t",
        kind: "sub_agent",
        payload: { brief: "yesterday" },
        created_at: new Date(Date.now() - QUEUE_TTL_MS - HOUR_MS).toISOString(),
      });
      sweepOrphanedJobs(h.deps, { ownerId: "" });

      const fresh = startSubAgentJob(h.deps, { brief: "today", profile: "t", model_id: "openai/gpt-oss-20b" });
      await waitFor(`job ${fresh} done`, () => {
        const s = getSubAgentJobStatus(h.deps, fresh);
        return s.status === "done" ? s : null;
      });

      expect(h.counts.chats).toBe(1);
      expect(h.deps.jobs.get(old)!.error_code).toBe("job_expired");
      expect(h.deps.jobs.get(fresh)!.owner_id).not.toBeNull();
      expect(h.deps.jobs.get(fresh)!.heartbeat_at).not.toBeNull();
    } finally {
      await h.close();
    }
  });

  it("migration 22 adds the ownership columns idempotently", () => {
    const home = scratchHome();
    try {
      buildDeps(home).close();
      const deps = buildDeps(home); // second run re-applies the migration loop
      try {
        const cols = (deps.db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>).map((c) => c.name);
        expect(cols).toContain("owner_id");
        expect(cols).toContain("heartbeat_at");
        const index = deps.db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_jobs_status_heartbeat'")
          .get();
        expect(index).toBeDefined();
      } finally {
        deps.close();
      }
    } finally {
      cleanup(home);
    }
  });
});
