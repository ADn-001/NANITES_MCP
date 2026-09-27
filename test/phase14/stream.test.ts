/**
 * Phase 14 gate — SSE stream. Writes fake sub_agent_events rows and asserts a
 * connected client receives them in batched `data:` frames, and that a client
 * disconnect stops the poll loop.
 */
import http from "node:http";
import { describe, expect, it } from "vitest";
import { buildDeps } from "../../src/tools/deps.js";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface StreamClient {
  req: http.ClientRequest;
  buf: () => string;
  close: () => void;
}

function connect(port: number): StreamClient {
  const state = { text: "" };
  const req = http.get({ host: "127.0.0.1", port, path: "/api/stream" }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      state.text += chunk;
    });
  });
  return { req, buf: () => state.text, close: () => req.destroy() };
}

describe("GET /api/stream", () => {
  it("delivers inserted events in batched frames", async () => {
    const home = scratchHome();
    const deps = buildDeps(home);
    deps.profiles.createProfile({ name: "t" });
    deps.profiles.switchProfile("t");
    const ui: UiServer = await startUiServer(deps, { port: 0 });

    const client = connect(ui.port);
    await sleep(150); // allow the connection to settle

    deps.subAgentEvents.insert({ profile_name: "t", model_id: "m1", phase: "chat.start", payload: { tok_s: 40 } });
    deps.subAgentEvents.insert({ profile_name: "t", model_id: "m1", phase: "chat.end", payload: { ttft_ms: 200 } });
    await sleep(500); // poll interval is 200ms — give it a couple cycles

    const text = client.buf();
    expect(text).toContain("chat.start");
    expect(text).toContain("chat.end");
    expect(text).toContain("m1");
    expect(text).toContain('"tok_s":40');

    client.close();
    await sleep(50);
    await ui.close();
    deps.close();
    cleanup(home);
  });

  it("stops polling after the client disconnects", async () => {
    const home = scratchHome();
    const deps = buildDeps(home);
    deps.profiles.createProfile({ name: "t" });
    deps.profiles.switchProfile("t");
    const ui: UiServer = await startUiServer(deps, { port: 0 });

    const client = connect(ui.port);
    await sleep(150);

    // Deliver one event to confirm the stream is live, then disconnect.
    deps.subAgentEvents.insert({ profile_name: "t", model_id: "m1", phase: "chat.start", payload: {} });
    await sleep(400);
    expect(client.buf()).toContain("chat.start");

    client.close();
    await sleep(100);
    const before = client.buf().length;

    // A new event after disconnect must not be written to the (dead) stream.
    deps.subAgentEvents.insert({ profile_name: "t", model_id: "m1", phase: "chat.end", payload: {} });
    await sleep(500);
    expect(client.buf().length).toBe(before);

    await ui.close();
    deps.close();
    cleanup(home);
  });
});
