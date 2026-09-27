/**
 * Phase 35 — toolkit dashboard decoration. With a `uiController` present,
 * mapped tool results carry `dashboard_url` + `dashboard_action` inside the
 * `{ ok, data }` envelope: run/read tools once per kind, mutations on every
 * call with a reload nonce. Without a controller (the default, incl. every
 * other suite) no decoration and no start happens.
 */
import { describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../../src/server/buildServer.js";
import { resetOpenState } from "../../src/ui/openSession.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

function parseData(result: { content: Array<{ type: string; text: string }> }): { data: Record<string, unknown> } {
  const text = result.content.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text);
}

describe("toolkit dashboard decoration", () => {
  it("decorates once-per-kind reads and every mutation call, and never without a controller", async () => {
    resetOpenState();
    const home = scratchHome();
    const fakeStart = vi.fn(async () => ({ url: "http://127.0.0.1:4700", started: true, enabled: true }));
    const uiController = { start: fakeStart };

    const server = buildServer({ home, uiController });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-harness", version: "0.0.1" });
    await server.server.connect(serverT);
    await client.connect(clientT);

    try {
      // read: first call carries dashboard_url -> settings (once per kind).
      const firstList = await client.callTool({ name: "list_profiles", arguments: {} });
      let body = parseData(firstList as never);
      expect((body.data as Record<string, unknown>).dashboard_url).toContain("/#/settings");
      expect((body.data as Record<string, unknown>).dashboard_action).toBe("navigate");
      expect(fakeStart).toHaveBeenCalledTimes(1);

      // read: second call is silent.
      const secondList = await client.callTool({ name: "list_profiles", arguments: {} });
      body = parseData(secondList as never);
      expect((body.data as Record<string, unknown>).dashboard_url).toBeUndefined();
      expect(fakeStart).toHaveBeenCalledTimes(1);

      // mutation: every call navigates + reloads.
      await client.callTool({ name: "create_profile", arguments: { name: "alpha" } });
      const mutationA = await client.callTool({ name: "create_profile", arguments: { name: "beta" } });
      body = parseData(mutationA as never);
      const data = body.data as Record<string, unknown>;
      expect(data.dashboard_url).toContain("/#/settings?r=");
      expect(data.dashboard_action).toBe("navigate+reload");
      expect(fakeStart).toHaveBeenCalledTimes(3); // list once + both mutations
    } finally {
      await client.close();
      await server.close();
      cleanup(home);
    }
  });

  it("never decorates when no uiController is wired (default)", async () => {
    resetOpenState();
    const home = scratchHome();
    const server = buildServer({ home });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-harness", version: "0.0.1" });
    await server.server.connect(serverT);
    await client.connect(clientT);

    try {
      const result = await client.callTool({ name: "list_profiles", arguments: {} });
      const body = parseData(result as never);
      expect((body.data as Record<string, unknown>).dashboard_url).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
      cleanup(home);
    }
  });
});
