/**
 * Phase 32 gate (Phase H) — held-chat primitive (btw-spec-v2 §7). Each dashboard
 * turn chats the pinned `context_qa` model directly against its held instance
 * (never through run_sub_agent). An evicted/swept instance reloads silently on
 * the next turn. Idle teardown frees only the instance — the row + transcript
 * survive and the next message reacquires.
 */
import { describe, expect, it } from "vitest";
import { runBtwChatMessage } from "../../src/workflows/btwChat.js";
import { sweepIdleBtwChats } from "../../src/helpers/idleSweep.js";
import { clientForProfile } from "../../src/tools/deps.js";
import { CONTEXT_QA_ROLE } from "../../src/workflows/btwChat.js";
import { createBtwHarness, qaEntry, QA_MODEL } from "./helpers.js";

describe("Phase 32 gate — held chat turns", () => {
  it("answers against the held instance and appends faithful user+assistant turns", async () => {
    const h = await createBtwHarness({ registry: [qaEntry()] });
    try {
      h.seedChatRow(QA_MODEL); // held row with no live instance yet
      const loadsBefore = h.counts.loads;

      const first = await runBtwChatMessage(h.deps, "t", "What is the token budget?");
      expect(first.reply).toBe("done");
      expect(first.model_id).toBe(QA_MODEL);
      expect(first.reacquired).toBe(true); // nothing was held -> loaded this turn
      expect(h.loaded.has(QA_MODEL)).toBe(true);
      expect(h.counts.loads - loadsBefore).toBe(1);

      const rows = h.deps.btwChatMessages.list("t");
      expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);
      expect(rows[0]?.content).toBe("What is the token budget?");
      expect(rows[1]?.content).toBe("done");
      expect(rows.map((r) => r.turn_index)).toEqual([0, 1]);
      // Turn logged under the context_qa role for cost reporting.
      const qaRows = h.deps.callLogs.list("t").filter((x) => x.role === CONTEXT_QA_ROLE);
      expect(qaRows).toHaveLength(1);
      expect(qaRows[0]?.model_id).toBe(QA_MODEL);
    } finally {
      await h.close();
    }
  });

  it("reuses the resident instance on the next turn (no reload)", async () => {
    const h = await createBtwHarness({ registry: [qaEntry()] });
    try {
      h.seedChatRow(QA_MODEL);
      await runBtwChatMessage(h.deps, "t", "hello one");
      const loadsBefore = h.counts.loads;
      const second = await runBtwChatMessage(h.deps, "t", "hello two");
      expect(second.reacquired).toBe(false);
      expect(h.counts.loads - loadsBefore).toBe(0); // instance was already resident
      const rows = h.deps.btwChatMessages.list("t");
      expect(rows).toHaveLength(4);
      expect(rows[2]?.content).toBe("hello two");
      expect(rows[3]?.content).toBe("done");
    } finally {
      await h.close();
    }
  });

  it("an evicted instance is silently reacquired on the next turn (no error, one reload)", async () => {
    const h = await createBtwHarness({ registry: [qaEntry()] });
    try {
      h.seedChatRow(QA_MODEL);
      await runBtwChatMessage(h.deps, "t", "warm");
      expect(h.loaded.has(QA_MODEL)).toBe(true);

      // Simulate LM Studio dropping the instance under us while the row still
      // names it (crash/eviction) — unload it out from under the chat.
      const profile = h.deps.profiles.getProfile("t")!;
      await clientForProfile(profile).unloadModel({ instance_id: QA_MODEL });
      expect(h.loaded.has(QA_MODEL)).toBe(false);

      const loadsBefore = h.counts.loads;
      const next = await runBtwChatMessage(h.deps, "t", "are you still there?");
      expect(next.reply).toBe("done");
      expect(h.counts.loads - loadsBefore).toBe(1); // reloaded silently
      expect(h.loaded.has(QA_MODEL)).toBe(true);
      expect(h.deps.btwChat.get("t")?.status).toBe("ready");
    } finally {
      await h.close();
    }
  });

  it("idle teardown frees the instance but keeps the chat; next turn reacquires", async () => {
    const h = await createBtwHarness({ registry: [qaEntry()] });
    try {
      h.seedChatRow(QA_MODEL);
      await runBtwChatMessage(h.deps, "t", "idle test");
      expect(h.deps.btwChat.get("t")?.instance_id).toBe(QA_MODEL);

      // Backdate the activity so a zero-window sweep considers it idle.
      const chat = h.deps.btwChat.get("t")!;
      h.deps.btwChat.set({ ...chat, last_activity_at: new Date(Date.now() - 3_600_000).toISOString() });

      const sweep = await sweepIdleBtwChats(h.deps, "t", 0);
      expect(sweep.inspected).toBe(1);
      expect(sweep.unloaded).toBe(1);
      expect(h.deps.btwChat.get("t")?.instance_id).toBeNull(); // instance freed
      expect(h.loaded.has(QA_MODEL)).toBe(false);
      // The chat + its transcript survive the sweep.
      expect(h.deps.btwChat.get("t")).not.toBeNull();
      expect(h.deps.btwChatMessages.list("t")).toHaveLength(2);

      // Next message reacquires exactly like the eviction path.
      const loadsBefore = h.counts.loads;
      const next = await runBtwChatMessage(h.deps, "t", "still here");
      expect(next.reacquired).toBe(true);
      expect(h.counts.loads - loadsBefore).toBe(1);
      expect(h.deps.btwChat.get("t")?.instance_id).toBe(QA_MODEL);
      expect(h.deps.btwChatMessages.list("t")).toHaveLength(4);
    } finally {
      await h.close();
    }
  });
});
