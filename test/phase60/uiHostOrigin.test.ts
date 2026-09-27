/**
 * Phase 60 gate — Host and Origin enforcement over real HTTP.
 *
 * These are the end-to-end cases: a request that arrives at a live server with
 * a hostile Host or a cross-site Origin must be refused *before* any route
 * runs, while the ordinary loopback traffic the dashboard and its 12 existing
 * test files depend on keeps working.
 */
import { describe, expect, it } from "vitest";
import net from "node:net";
import { buildDeps } from "../../src/tools/deps.js";
import { startUiServer } from "../../src/ui/server.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";
import { startMockLmStudio } from "../phase1/mockServer.js";
import { liveHandler } from "../phase11/helpers.js";

/**
 * Issue a request over a raw socket. `fetch` cannot be used to test the Host
 * guard: undici treats Host as a forbidden header and silently substitutes
 * its own, so a caller can never express the rebinding case through it —
 * which is exactly why the attack works in a browser but not in a test that
 * uses fetch. Origin IS settable, so those cases use fetch.
 */
function rawRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      const head = [
        method + " " + path + " HTTP/1.1",
        ...Object.entries(headers).map((kv) => kv[0] + ": " + kv[1]),
        "Connection: close",
      ]
        .concat(body === undefined ? [] : ["Content-Length: " + Buffer.byteLength(body)])
        .join("\r\n") + "\r\n\r\n" + (body ?? "");
      sock.write(head);
    });
    let buf = "";
    sock.on("data", (c) => (buf += c.toString()));
    sock.on("end", () => {
      const m = /^HTTP\/1\.1 (\d+)/.exec(buf);
      const sep = buf.indexOf("\r\n\r\n");
      resolve({ status: m ? Number(m[1]) : 0, text: sep >= 0 ? buf.slice(sep + 4) : "" });
    });
    sock.on("error", reject);
  });
}

interface Harness {
  deps: ReturnType<typeof buildDeps>;
  ui: Awaited<ReturnType<typeof startUiServer>>;
  mock: Awaited<ReturnType<typeof startMockLmStudio>>;
  base: string;
}

async function setup(): Promise<Harness> {
  const home = scratchHome();
  const deps = buildDeps(home, { healthDisk: { availableGb: 500 } });
  const mock = await startMockLmStudio(liveHandler);
  deps.profiles.createProfile({ name: "t", endpoint: { url: mock.url }, machine_specs: { vram_gb: 4 } });
  deps.profiles.switchProfile("t");
  const ui = await startUiServer(deps, { port: 0 });
  return { deps, ui, mock, base: `http://127.0.0.1:${ui.port}` };
}

async function teardown(h: Harness): Promise<void> {
  await h.ui.close();
  h.deps.close();
  await h.mock.close();
  cleanup(h.deps.home);
}

describe("Host header enforcement", () => {
  it("serves a normal loopback request (the 12 existing suites depend on this)", async () => {
    const h = await setup();
    const res = await fetch(`${h.base}/api/profiles`);
    expect(res.status).toBe(200);
    await teardown(h);
  });

  it("rejects a foreign Host on a read route — the DNS-rebinding path", async () => {
    const h = await setup();
    const res = await rawRequest(h.ui.port, "GET", "/api/profile?name=t", { Host: "evil.example" });
    expect(res.status).toBe(403);
    expect(res.text).toContain("forbidden_host");
    await teardown(h);
  });

  it("never returns a secret on a foreign Host", async () => {
    const h = await setup();
    h.deps.profiles.updateProfile("t", {
      endpoint: { url: "http://127.0.0.1:1", auth_token: "super-secret-value" },
    });
    const res = await rawRequest(h.ui.port, "GET", "/api/profile?name=t", { Host: "evil.example" });
    expect(res.status).toBe(403);
    expect(res.text).not.toContain("super-secret-value");
    await teardown(h);
  });

  it("rejects a foreign Host on a mutating route without performing the write", async () => {
    const h = await setup();
    h.deps.callLogs.insert({
      profile_name: "t", model_id: "m", role: "code", loaded: false,
      duration_ms: 1, tokens_in: 1, tokens_out: 1, cost_usd: 0,
    } as never);
    const res = await rawRequest(h.ui.port, "POST", "/api/settings/wipe", {
      Host: "evil.example",
      "Content-Type": "application/json",
    }, JSON.stringify({ all: true }));
    expect(res.status).toBe(403);
    // The call log survives, proving the route never ran.
    expect(h.deps.callLogs.list("t").length).toBe(1);
    await teardown(h);
  });

  it("answers 403 before dispatch, not 404 for an unknown path", async () => {
    // Proves the gate runs ahead of routing rather than inside a handler.
    const h = await setup();
    const res = await rawRequest(h.ui.port, "GET", "/api/does-not-exist", { Host: "evil.example" });
    expect(res.status).toBe(403);
    await teardown(h);
  });

  it("never serves a request that omits Host entirely", async () => {
    // Node enforces HTTP/1.1 and answers 400 itself before any application
    // code runs, so this case is closed a layer below the guard. Asserted so
    // a future HTTP/1.0-tolerant change cannot silently open it.
    const h = await setup();
    const res = await rawRequest(h.ui.port, "GET", "/api/profiles");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.text).not.toContain("profiles");
    await teardown(h);
  });
});

describe("Origin enforcement on mutations", () => {
  it("allows a mutation with no Origin (curl, MCP, scripts)", async () => {
    const h = await setup();
    const res = await fetch(`${h.base}/api/btw/clear`, { method: "POST" });
    expect(res.status).toBe(200);
    await teardown(h);
  });

  it("rejects a cross-origin mutation", async () => {
    const h = await setup();
    const res = await fetch(`${h.base}/api/settings/wipe`, {
      method: "POST",
      headers: { Origin: "http://evil.example", "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("forbidden_origin");
    await teardown(h);
  });

  it("rejects the literal Origin 'null' (sandboxed iframe, data: page)", async () => {
    const h = await setup();
    const res = await fetch(`${h.base}/api/settings/wipe`, {
      method: "POST",
      headers: { Origin: "null", "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    expect(res.status).toBe(403);
    await teardown(h);
  });

  it("allows a same-origin mutation", async () => {
    const h = await setup();
    const res = await fetch(`${h.base}/api/btw/clear`, {
      method: "POST",
      headers: { Origin: `http://127.0.0.1:${h.ui.port}` },
    });
    expect(res.status).toBe(200);
    await teardown(h);
  });

  it("does not apply the Origin check to reads", async () => {
    const h = await setup();
    const res = await fetch(`${h.base}/api/profiles`, { headers: { Origin: "http://evil.example" } });
    expect(res.status).toBe(200);
    await teardown(h);
  });
});
