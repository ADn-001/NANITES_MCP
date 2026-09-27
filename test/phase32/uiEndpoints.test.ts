/**
 * Phase 32 gate (Phase H) — dashboard REST surface (btw-spec-v2 §8) + the
 * client-side deep link (spec §5) and the H4 front-end chat-mode artifact.
 * GET /api/btw/state is the pollable snapshot (no instance ids exposed); POST
 * /api/btw/message appends a turn and answers through the held instance with
 * structured HTTP errors for the no-chat / no-model / malformed cases.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import { btwDeepLinkUrl } from "../../src/workflows/startBtwChat.js";
import { runBtwChatMessage } from "../../src/workflows/btwChat.js";
import { createBtwHarness, qaEntry, QA_MODEL } from "./helpers.js";

interface UiHarness {
  h: Awaited<ReturnType<typeof createBtwHarness>>;
  ui: UiServer;
  base: string;
}

async function setup(): Promise<UiHarness> {
  const h = await createBtwHarness({ registry: [qaEntry()] });
  h.deps.profiles.switchProfile("t");
  h.seedChatRow(QA_MODEL);
  const ui = await startUiServer(h.deps, { port: 0 });
  return { h, ui, base: `http://127.0.0.1:${ui.port}` };
}

async function teardown(u: UiHarness): Promise<void> {
  await u.ui.close();
  await u.h.close();
}

describe("Phase 32 gate — /nanites-btw REST endpoints", () => {
  it("GET /api/btw/state snapshots the chat without exposing instance ids", async () => {
    const u = await setup();
    try {
      const res = await fetch(`${u.base}/api/btw/state`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { chat: Record<string, unknown> | null; messages: unknown[]; compact: unknown };
      expect(body.chat?.status).toBe("ready");
      expect(body.chat?.model_id).toBe(QA_MODEL);
      expect(body.messages).toEqual([]);
      expect(body.compact).toBeNull();
      // No instance ids cross the wire (§6).
      expect("instance_id" in (body.chat ?? {})).toBe(false);
    } finally {
      await teardown(u);
    }
  });

  it("POST /api/btw/message round-trips against the held instance", async () => {
    const u = await setup();
    try {
      const first = (await (await fetch(`${u.base}/api/btw/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "what did we decide about the retry policy?" }),
      })).json()) as { reply: string; model_id: string; reacquired: boolean };
      expect(first.reply).toBe("done");
      expect(first.model_id).toBe(QA_MODEL);
      expect(first.reacquired).toBe(true); // nothing was resident yet

      const state1 = (await (await fetch(`${u.base}/api/btw/state`)).json()) as {
        chat: { status: string };
        messages: Array<{ turn_index: number; role: string; content: string }>;
      };
      expect(state1.chat.status).toBe("ready");
      expect(state1.messages).toEqual([
        { turn_index: 0, role: "user", content: "what did we decide about the retry policy?" },
        { turn_index: 1, role: "assistant", content: "done" },
      ]);

      // Second turn: the instance is now held — no reacquire.
      const second = (await (await fetch(`${u.base}/api/btw/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "and the fallback?" }),
      })).json()) as { reply: string; reacquired: boolean };
      expect(second.reply).toBe("done");
      expect(second.reacquired).toBe(false);
      const state2 = (await (await fetch(`${u.base}/api/btw/state`)).json()) as { messages: unknown[] };
      expect(state2.messages).toHaveLength(4);
    } finally {
      await teardown(u);
    }
  });

  it("malformed body is 400; a missing chat row is a structured 409", async () => {
    const u = await setup();
    try {
      const bad = await fetch(`${u.base}/api/btw/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(bad.status).toBe(400);
      const badBody = (await bad.json()) as { code: string };
      expect(badBody.code).toBe("bad_request");

      // Remove the chat row entirely; POST must surface btw_chat_not_found (409),
      // never a raw throw or stack trace.
      u.h.deps.btwChat.deleteAll("t");
      const missing = await fetch(`${u.base}/api/btw/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "ping" }),
      });
      expect(missing.status).toBe(409);
      const missingBody = (await missing.json()) as { code: string; message: string; retryable: boolean };
      expect(missingBody.code).toBe("btw_chat_not_found");
      expect(missingBody.retryable).toBe(false);
      expect(missingBody.message).toMatch(/start one first/i);
    } finally {
      await teardown(u);
    }
  });

  it("POST /api/settings/wipe clears the chat, messages, chunks, and caches", async () => {
    const u = await setup();
    try {
      await runBtwChatMessage(u.h.deps, "t", "wipe me");
      u.h.deps.contextCache.setSummary("t", { summary: "kept profile", summary_tokens: 4 });
      u.h.deps.chunkEmbeddings.replaceChunks("t", [{ chunk_id: "c0", summary: "doc", msg_start: 0, msg_end: 0 }]);

      const res = await fetch(`${u.base}/api/settings/wipe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { deleted: Record<string, number> };
      expect(body.deleted.btw_chat).toBe(1);
      expect(body.deleted.btw_chat_messages).toBe(2);
      expect(body.deleted.btw_chunks).toBe(1);
      expect(body.deleted.context_caches).toBeGreaterThanOrEqual(1);

      const state = (await (await fetch(`${u.base}/api/btw/state`)).json()) as {
        chat: null | unknown;
        messages: unknown[];
        compact: unknown;
      };
      expect(state.chat).toBeNull();
      expect(state.messages).toEqual([]);
      expect(state.compact).toBeNull();
    } finally {
      await teardown(u);
    }
  });
});

describe("Phase 32 gate — dashboard chat-mode artifact + deep link (H4)", () => {
  it("the deep link encodes the UI port and an initial question", async () => {
    const prev = process.env.NANITES_UI_PORT;
    process.env.NANITES_UI_PORT = "47777";
    try {
      expect(btwDeepLinkUrl()).toBe("http://127.0.0.1:47777/#/vox-terminus?mode=btw&maximize=1");
      expect(btwDeepLinkUrl("why did the build break?")).toBe(
        "http://127.0.0.1:47777/#/vox-terminus?mode=btw&maximize=1&q=why%20did%20the%20build%20break%3F",
      );
    } finally {
      if (prev === undefined) delete process.env.NANITES_UI_PORT;
      else process.env.NANITES_UI_PORT = prev;
    }
  });

  it("the served dashboard HTML ships the btw chat mode (DOM, router, endpoints)", () => {
    const html = readFileSync("frontend/nanites-dashboard.html", "utf8");
    // DOM + control ids for the chat-mode surface.
    for (const id of ["btwChat", "btwHeadLabel", "btwExit", "btwChatScroll", "btwChatInput", "btwChatSend"]) {
      expect(html).toContain(`id="${id}"`);
    }
    // URL-state router + live-event wiring the SSE handler needs.
    expect(html).toContain("#/vox-terminus?mode=btw&maximize=1");
    expect(html).toContain("function applyHashRoute");
    expect(html).toContain("function btwStreamEvent");
    expect(html).toContain("function setBtwMode");
    expect(html).toContain("/api/btw/state");
    expect(html).toContain("/api/btw/message");
  });
});
