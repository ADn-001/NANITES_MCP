/**
 * Phase 35 — Vox-Terminus recency replay. The /api/stream replay must surface
 * only in-window (≤15 min) events for the active profile on connect, and old
 * rows must not leak back through the first poll. Store seam
 * (`listSinceByTime` + `maxId`) is asserted directly; one SSE-level test proves
 * the wire behavior.
 */
import http from "node:http";
import { describe, expect, it } from "vitest";
import { buildDeps } from "../../src/tools/deps.js";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function connect(port: number): { req: http.ClientRequest; buf: () => string; close: () => void } {
  const state = { text: "" };
  const req = http.get({ host: "127.0.0.1", port, path: "/api/stream" }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      state.text += chunk;
    });
  });
  return { req, buf: () => state.text, close: () => req.destroy() };
}

describe("SubAgentEventStore recency seams", () => {
  it("listSinceByTime returns only rows at/after the instant, capped by limit", () => {
    const home = scratchHome();
    const deps = buildDeps(home);
    try {
      deps.subAgentEvents.insert({ profile_name: "t", model_id: "m", phase: "old.1", payload: {}, created_at: iso(HOUR) });
      deps.subAgentEvents.insert({ profile_name: "t", model_id: "m", phase: "fresh.1", payload: {}, created_at: iso(1) });
      deps.subAgentEvents.insert({ profile_name: "t", model_id: "m", phase: "fresh.2", payload: {}, created_at: iso(MINUTE) });

      const within = deps.subAgentEvents.listSinceByTime("t", iso(15 * MINUTE));
      const phases = within.map((e) => e.phase);
      expect(phases).toContain("fresh.1");
      expect(phases).toContain("fresh.2");
      expect(phases).not.toContain("old.1");

      expect(deps.subAgentEvents.listSinceByTime("t", iso(5 * MINUTE), 1)).toHaveLength(1);
    } finally {
      deps.close();
      cleanup(home);
    }
  });

  it("maxId is the highest id per profile (0 when empty)", () => {
    const home = scratchHome();
    const deps = buildDeps(home);
    try {
      expect(deps.subAgentEvents.maxId("t")).toBe(0);
      const id1 = deps.subAgentEvents.insert({ profile_name: "t", model_id: "m", phase: "a", payload: {} });
      const id2 = deps.subAgentEvents.insert({ profile_name: "t", model_id: "m", phase: "b", payload: {} });
      expect(deps.subAgentEvents.maxId("t")).toBe(Math.max(id1, id2));
    } finally {
      deps.close();
      cleanup(home);
    }
  });
});

describe("GET /api/stream replay recency", () => {
  it("does not replay rows older than 15 min, but still streams new events", async () => {
    const home = scratchHome();
    const deps = buildDeps(home);
    deps.profiles.createProfile({ name: "t" });
    deps.profiles.switchProfile("t");

    // Stale history exists BEFORE the client connects (the bug scenario).
    deps.subAgentEvents.insert({ profile_name: "t", model_id: "m", phase: "stale.old", payload: {}, created_at: iso(HOUR) });

    const ui: UiServer = await startUiServer(deps, { port: 0 });
    const client = connect(ui.port);
    await sleep(300); // replay + a poll cycle — stale row must stay absent

    expect(client.buf()).not.toContain("stale.old");

    deps.subAgentEvents.insert({ profile_name: "t", model_id: "m", phase: "brand.new", payload: {} });
    await sleep(500);
    expect(client.buf()).toContain("brand.new");
    expect(client.buf()).not.toContain("stale.old");

    client.close();
    await sleep(50);
    await ui.close();
    deps.close();
    cleanup(home);
  });

  it("replays in-window history on connect", async () => {
    const home = scratchHome();
    const deps = buildDeps(home);
    deps.profiles.createProfile({ name: "t" });
    deps.profiles.switchProfile("t");

    deps.subAgentEvents.insert({ profile_name: "t", model_id: "m", phase: "recentish", payload: {}, created_at: iso(2 * MINUTE) });

    const ui: UiServer = await startUiServer(deps, { port: 0 });
    const client = connect(ui.port);
    await sleep(250);

    expect(client.buf()).toContain("recentish");

    client.close();
    await sleep(50);
    await ui.close();
    deps.close();
    cleanup(home);
  });
});
