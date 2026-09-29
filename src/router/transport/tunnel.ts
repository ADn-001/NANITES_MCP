/**
 * cloudflared quick-tunnel supervisor.
 *
 * A quick tunnel needs no Cloudflare account and no config file: it prints a
 * randomly-assigned `https://<words>.trycloudflare.com` and proxies to the
 * local port. That makes it the right tool for "use this router from my
 * laptop" and the wrong tool for anything durable.
 *
 * Deliberately NOT built: named tunnels, DNS records, ingress rules, and
 * Cloudflare Access. A user who needs those should run cloudflared
 * themselves and point the bind at the result.
 *
 * Two things the probe settled that the docs do not say:
 *
 *  1. The URL appears on **stderr**, inside a bordered banner, and may be
 *     followed by "it may take some time to be reachable" — so a supervisor
 *     that returns the instant it sees the URL hands out an address that
 *     still 404s. `waitForReachable` polls it.
 *  2. A missing binary is the NORMAL case on most machines. It must degrade to
 *     "tunnel unavailable", never take the router down.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export interface TunnelState {
  enabled: boolean;
  running: boolean;
  url: string | null;
  pid: number | null;
  last_error: string | null;
  started_at: string | null;
}

export const TUNNEL_OFF: TunnelState = {
  enabled: false, running: false, url: null, pid: null, last_error: null, started_at: null,
};

/** Where cloudflared usually lives on Windows; PATH is tried first. */
const WINDOWS_CANDIDATES = [
  "C:/Program Files (x86)/cloudflared/cloudflared.exe",
  "C:/Program Files/cloudflared/cloudflared.exe",
];

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/** Extract a quick-tunnel URL from cloudflared's output. */
export function parseTunnelUrl(chunk: string): string | null {
  const m = URL_RE.exec(chunk);
  return m ? m[0] : null;
}

export interface TunnelOptions {
  /** Local port the tunnel proxies to. */
  port: number;
  /** Milliseconds to wait for the URL, and then for it to answer. */
  timeoutMs?: number;
  /** Injectable for tests: given a URL, resolve true when reachable. */
  probe?: (url: string) => Promise<boolean>;
  /** Injectable for tests. */
  spawnFn?: typeof spawn;
}

export interface TunnelHandle extends TunnelState {
  stop(): Promise<void>;
}

export class TunnelUnavailable extends Error {
  constructor(public readonly reason: "not_installed" | "timeout" | "spawn_failed", message: string) {
    super(message);
    this.name = "TunnelUnavailable";
  }
}

/**
 * Start a quick tunnel and resolve once the URL is actually reachable.
 *
 * Resolving on the printed URL alone is a trap the probe exposed: Cloudflare
 * prints the address before the edge is routing to it.
 */
export async function startTunnel(opts: TunnelOptions): Promise<TunnelHandle> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const spawnFn = opts.spawnFn ?? spawn;
  const probe = opts.probe ?? defaultProbe;

  const command = process.platform === "win32" ? WINDOWS_CANDIDATES[0]! : "cloudflared";
  const args = ["tunnel", "--url", `http://127.0.0.1:${opts.port}`];

  let child: ChildProcess;
  try {
    child = spawnFn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    throw new TunnelUnavailable("spawn_failed", `Could not start cloudflared: ${err instanceof Error ? err.message : String(err)}`);
  }

  const state: TunnelState = {
    enabled: true, running: true, url: null, pid: child.pid ?? null,
    last_error: null, started_at: new Date().toISOString(),
  };

  let exited = false;
  let output = "";
  let resolveUrl: ((u: string) => void) | null = null;
  const urlPromise = new Promise<string>((r) => { resolveUrl = r; });

  const onData = (buf: Buffer): void => {
    output += buf.toString();
    if (state.url) return;
    const found = parseTunnelUrl(output);
    if (found && resolveUrl) {
      state.url = found;
      resolveUrl(found);
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  child.once("error", (err) => {
    // ENOENT here means cloudflared is not installed. That is the NORMAL case
    // and must not surface as a crash of whatever asked for a tunnel.
    exited = true;
    state.running = false;
    state.last_error = err.message.includes("ENOENT")
      ? "cloudflared is not installed or not on PATH"
      : err.message;
  });
  child.once("exit", (code) => {
    exited = true;
    state.running = false;
    if (code !== null && code !== 0) state.last_error = `cloudflared exited with code ${code}`;
  });

  // A quick tunnel that exits immediately is a failure, not a tunnel.
  const immediateExit = new Promise<never>((_, reject) => {
    child.once("exit", (code) => {
      if (state.url === null) {
        reject(new TunnelUnavailable("spawn_failed", `cloudflared exited immediately (code ${code}): ${output.slice(0, 200)}`));
      }
    });
  });

  const url = await Promise.race([urlPromise, immediateExit, delay(timeoutMs).then(() => {
    throw new TunnelUnavailable("timeout", `No tunnel URL within ${timeoutMs}ms. ${output.slice(0, 200)}`);
  })]);

  // The URL is printed before the edge routes to it, so confirm reachability
  // before handing it to a user who will paste it into a harness.
  if (!(await waitForReachable(url, probe, timeoutMs))) {
    await terminate(child);
    throw new TunnelUnavailable("timeout", `Tunnel ${url} did not become reachable in time.`);
  }

  return {
    ...state,
    stop: async () => {
      if (!child.pid || exited) return;
      await terminate(child);
    },
  };
}

async function terminate(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  try {
    // SIGTERM first so cloudflared can tear the tunnel down cleanly...
    child.kill("SIGTERM");
  } catch {
    // fall through to the hard kill
  }
  // ...then verify. A quick tunnel left running keeps a public URL alive
  // pointing at a port nothing is serving, which is worse than not having it.
  for (let i = 0; i < 20; i++) {
    if (!isAlive(pid)) return;
    await delay(100);
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
  await delay(200);
  if (isAlive(pid)) {
    // Last resort for Windows, where signals are unreliable.
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // nothing more to try
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until the tunnel answers, or the budget runs out. */
export async function waitForReachable(
  url: string,
  probe: (u: string) => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let wait = 500;
  while (Date.now() < deadline) {
    if (await probe(url)) return true;
    await delay(wait);
    wait = Math.min(wait * 2, 5_000);
  }
  return false;
}

async function defaultProbe(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/v1/health`, {
      headers: { "user-agent": "nanites-router-tunnel-probe" },
      signal: AbortSignal.timeout(5_000),
    });
    // Any HTTP answer proves the edge is routing. 401 is a PASS here: it
    // means the request reached the router and the router refused it, which
    // is exactly the health we are checking for.
    return res.status > 0;
  } catch {
    return false;
  }
}

/**
 * Clean up a tunnel left running by a previous process.
 *
 * The same shape as the dashboard's stale-process kill: a tunnel that outlived
 * its router keeps a public URL alive, and the pid is persisted so boot can
 * reap it.
 */
export function reapOrphanTunnel(pid: number | null): boolean {
  if (!pid) return false;
  if (!isAlive(pid)) return false;
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}
