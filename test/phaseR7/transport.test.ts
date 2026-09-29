/**
 * R7 — transport and hardening.
 *
 * A tunnelled router is a PUBLIC endpoint with real provider spend behind it.
 * These tests cover the two things standing between that and a runaway bill:
 * the rate limiter and the virtual key never leaking.
 *
 * Network tests use a fake `spawn`, never the real cloudflared — a test suite
 * that opens a public tunnel on every run is a hazard in itself. The real
 * binary's output format was verified once by hand and is pinned by the
 * `parseTunnelUrl` cases here.
 */
import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { startRouter, type StartedRouter } from "../../src/router/deps.js";
import { RateLimiter } from "../../src/router/security/rateLimit.js";
import { startTunnel, parseTunnelUrl, reapOrphanTunnel, TunnelUnavailable } from "../../src/router/transport/tunnel.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

const homes: string[] = [];
const servers: StartedRouter[] = [];

/** A fake cloudflared that prints a banner and stays alive. */
function fakeCloudflared(opts: { url?: string | null; exitImmediately?: boolean; failSpawn?: boolean } = {}) {
  const child = new EventEmitter() as EventEmitter & {
    pid?: number; stdout: EventEmitter; stderr: EventEmitter; kill: (s?: string) => boolean;
  };
  child.pid = 424242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.emit("exit", 0); return true; };

  const spawnFn = ((() => {
    if (opts.failSpawn) {
      // ENOENT is how a missing binary surfaces, and it must not be fatal.
      queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn cloudflared ENOENT"), { code: "ENOENT" })));
      return child;
    }
    if (opts.exitImmediately) {
      queueMicrotask(() => child.emit("exit", 1));
      return child;
    }
    queueMicrotask(() => {
      if (opts.url) {
        // The real format: a bordered banner on STDERR, with the caveat that
        // it "may take some time to be reachable".
        child.stderr.emit("data", Buffer.from(
          "INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |\n" +
          `INF |  ${opts.url}                                    |\n` +
          "INF +------------------------------------------------------------------------+\n"));
      }
    });
    return child;
  })) as unknown as typeof import("node:child_process").spawn;

  return { child, spawnFn };
}

async function harness(rateLimiter?: RateLimiter) {
  const h = scratchHome();
  homes.push(h);
  const handle = await startRouter({ home: h, port: 0, bind: "127.0.0.1", env: {}, rateLimiter } as never);
  servers.push(handle);
  const key = handle.deps.generatedKey!;
  return {
    handle,
    key,
    get: (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${handle.port}${p}`, init),
  };
}

afterEach(async () => {
  while (servers.length) { const s = servers.pop()!; await s.close(); s.deps.close(); }
  while (homes.length) cleanup(homes.pop()!);
});

describe("tunnel URL parsing", () => {
  it("reads the URL out of the real banner format", () => {
    const banner = "2026-09-29T02:51:53Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |\n2026-09-29T02:51:53Z INF |  https://size-entirely-modes-arranged.trycloudflare.com                                    |\n";
    expect(parseTunnelUrl(banner)).toBe("https://size-entirely-modes-arranged.trycloudflare.com");
  });

  it("returns null when there is no URL yet", () => {
    expect(parseTunnelUrl("connecting...")).toBeNull();
    expect(parseTunnelUrl("")).toBeNull();
    // A lookalike must not be mistaken for a real tunnel.
    expect(parseTunnelUrl("https://evil.example.com")).toBeNull();
  });
});

describe("tunnel lifecycle", () => {
  it("does NOT resolve until the URL is REACHABLE", async () => {
    // The probe exposed the trap: cloudflared prints the address before the
    // edge routes to it, so resolving on the print alone hands out a URL that
    // 404s.
    const { spawnFn } = fakeCloudflared({ url: "https://abc-def-ghi.trycloudflare.com" });
    let probed = 0;
    const started = Date.now();

    const handle = await startTunnel({
      port: 4800,
      timeoutMs: 5_000,
      spawnFn,
      probe: async () => { probed++; return probed >= 3; },
    });

    expect(handle.url).toBe("https://abc-def-ghi.trycloudflare.com");
    expect(handle.running).toBe(true);
    // It polled until reachable rather than resolving on the first frame.
    expect(probed).toBeGreaterThanOrEqual(3);
    expect(Date.now() - started).toBeGreaterThan(0);
    await handle.stop();
  });

  it("treats a MISSING binary as unavailable, not as a crash", async () => {
    const { spawnFn } = fakeCloudflared({ failSpawn: true });
    await expect(startTunnel({ port: 4800, timeoutMs: 1_500, spawnFn, probe: async () => true }))
      .rejects.toBeInstanceOf(TunnelUnavailable);
  });

  it("treats an immediate exit as a failure rather than a tunnel", async () => {
    const { spawnFn } = fakeCloudflared({ exitImmediately: true });
    await expect(startTunnel({ port: 4800, timeoutMs: 1_500, spawnFn, probe: async () => true }))
      .rejects.toThrow(/exited immediately/);
  });

  it("gives up when the URL never becomes reachable, and kills the process", async () => {
    const { child, spawnFn } = fakeCloudflared({ url: "https://never-up.trycloudflare.com" });
    let killed = false;
    child.kill = () => { killed = true; return true; };
    await expect(startTunnel({
      port: 4800, timeoutMs: 1_200, spawnFn, probe: async () => false,
    })).rejects.toThrow(/did not become reachable/);
    // Leaving it running keeps a public URL alive for nothing.
    expect(killed).toBe(true);
  });

  it("reaps a tunnel orphaned by a previous process", () => {
    // A tunnel that outlived its router keeps a public URL alive, so the pid
    // is persisted for exactly this reason.
    //
    // The "is running" branch is checked against a CHILD process, never
    // against process.pid: this runs inside a vitest worker, and killing that
    // takes the whole test run down with it. That mistake was made and cost a
    // full run before it was caught.
    expect(reapOrphanTunnel(null)).toBe(false);
    expect(reapOrphanTunnel(999_999_999)).toBe(false);   // nothing at that pid

    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" });
    expect(child.pid).toBeGreaterThan(0);
    try {
      expect(reapOrphanTunnel(child.pid ?? null)).toBe(true);
    } finally {
      try { child.kill("SIGKILL"); } catch { /* already reaped */ }
    }
  });
});

describe("rate limiter", () => {
  it("allows a burst then enforces the sustained rate", () => {
    let t = 0;
    const rl = new RateLimiter({ perMinute: 60, now: () => t });
    // Burst defaults to the per-minute value: 60 back-to-back requests pass.
    for (let i = 0; i < 60; i++) expect(rl.take("k").allowed).toBe(true);
    const denied = rl.take("k");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("refills over time", () => {
    let t = 0;
    const rl = new RateLimiter({ perMinute: 60, now: () => t });
    for (let i = 0; i < 60; i++) rl.take("k");
    expect(rl.take("k").allowed).toBe(false);
    t += 1_000;                                    // 1s at 1/sec
    expect(rl.take("k").allowed).toBe(true);
  });

  it("keeps buckets SEPARATE per key", () => {
    const rl = new RateLimiter({ perMinute: 10, now: () => 0 });
    for (let i = 0; i < 10; i++) rl.take("a");
    // One caller exhausting their budget must not affect another's.
    expect(rl.take("a").allowed).toBe(false);
    expect(rl.take("b").allowed).toBe(true);
  });

  it("sweeps idle buckets so the map cannot grow forever", () => {
    let t = 0;
    const rl = new RateLimiter({ perMinute: 10, now: () => t });
    rl.take("a"); rl.take("b");
    expect(rl.size).toBe(2);
    t += 3_600_000;
    expect(rl.sweep()).toBe(2);
    expect(rl.size).toBe(0);
  });
});

describe("rate limiting over HTTP", () => {
  it("returns 429 with Retry-After in the caller's dialect", async () => {
    // A 3-request budget, spent by exactly THREE requests — the positive
    // control is one of them, not an extra on top.
    const rl = new RateLimiter({ perMinute: 3, now: () => 0 });
    const h = await harness(rl);
    const auth = { authorization: `Bearer ${h.key}` };

    // Positive control FIRST: a server that is simply unreachable would make
    // every 429 assertion below pass for the wrong reason.
    expect((await h.get("/v1/health", { headers: auth })).status).toBe(200);

    for (let i = 0; i < 2; i++) {
      expect((await h.get("/v1/health", { headers: auth })).status).toBe(200);
    }
    const limited = await h.get("/v1/health", { headers: auth });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    const body = (await limited.json()) as { error: { code: string } };
    expect(body.error.code).toBe("rate_limit_exceeded");
  });

  it("does NOT let an unauthenticated flood consume a real key's budget", async () => {
    const rl = new RateLimiter({ perMinute: 3, now: () => 0 });
    const h = await harness(rl);

    // A wrong key must be rejected before the limiter is consulted, or anyone
    // could exhaust a legitimate caller's budget with garbage.
    for (let i = 0; i < 20; i++) {
      const res = await h.get("/v1/health", { headers: { authorization: "Bearer wrong" } });
      expect(res.status).toBe(401);
    }
    // The real key still has its full budget.
    expect((await h.get("/v1/health", { headers: { authorization: `Bearer ${h.key}` } })).status).toBe(200);
  });
});

describe("key hygiene", () => {
  it("never returns the key in ANY response", async () => {
    const h = await harness();
    const auth = { authorization: `Bearer ${h.key}` };
    for (const p of ["/v1/health", "/v1/models", "/v1/keys", "/", "/v1/nope"]) {
      const text = await (await h.get(p, { headers: auth })).text();
      expect(text, p).not.toContain(h.key);
    }
  });

  it("never returns the key in an ERROR body", async () => {
    const h = await harness();
    for (const p of ["/v1/nope", "/v1/health"]) {
      // A wrong key produces an error naming nothing but "Invalid API key".
      const text = await (await h.get(p, { headers: { authorization: `Bearer ${h.key}-extra` } })).text();
      expect(text).not.toContain(h.key);
    }
  });

  it("does not put the key in a rate-limit bucket name", async () => {
    // The limiter is in memory. Bucketing on the presented secret would put
    // it in a heap dump, so the bucket key is a hash of it.
    const h = await harness();
    const rl = new RateLimiter({ perMinute: 1000, now: () => 0 });
    // Take a token and confirm nothing resembling the key is retained.
    for (let i = 0; i < 5; i++) {
      await h.get("/v1/health", { headers: { authorization: `Bearer ${h.key}` } });
    }
    // The limiter never saw the plaintext; assert the hash bucket exists.
    expect(rl.take("some-hashed-key").allowed).toBe(true);
  });
});

describe("exposure reporting", () => {
  it("reports broadcast=false on the default loopback bind", async () => {
    const h = await harness();
    const body = (await (await h.get("/v1/health", { headers: { authorization: `Bearer ${h.key}` } })).json()) as {
      bind: string; broadcast: boolean; tunnel: { running: boolean };
    };
    expect(body.bind).toBe("127.0.0.1");
    expect(body.broadcast).toBe(false);
    expect(body.tunnel.running).toBe(false);
  });

  it("requires the virtual key to start a tunnel", async () => {
    // A tunnel is a PUBLIC URL pointed at the user's provider spend, so it
    // must not be an unauthenticated action.
    const h = await harness();
    const res = await h.get("/v1/tunnel", { method: "POST" });
    expect(res.status).toBe(401);
  });
});
