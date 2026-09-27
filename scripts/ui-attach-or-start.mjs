/**
 * Launch helper for the `.claude/launch.json` dashboard entry.
 *
 * The in-app Browser preview is not enabled on this install, so a URL-only
 * configuration (attach) is refused — preview_start needs a command. But the
 * dashboard is also lazy-started by the MCP server as a detached child on the
 * first mapped tool, so a plain `node dist/ui/main.js` command would either
 * double-bind and crash or, when that detached child already owns the port,
 * make preview_start report the port as "in use by node.exe (PID …)".
 *
 * This wrapper takes ownership so the freshly spawned preview process is the
 * one that ends up serving the port:
 *   - not serving              -> import the real UI entry, which binds.
 *   - serving a NANITES        -> kill that dashboard (identity-checked via
 *     dashboard (`/api/profiles` shape)      the same gate the MCP boot uses,
 *                                            never a foreign process), wait for
 *                                            the port to free, then bind here.
 *   - serving a foreign process -> cannot safely kill; fall back to holding so
 *     the process stays alive while the port conflict surfaces upstream.
 *
 *   NANITES_UI_PORT overrides the probed port, mirroring the server env.
 */
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const port = Number(process.env.NANITES_UI_PORT || 4700);

async function probeOk() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function isNanitesDashboard() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/profiles`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return Array.isArray(body.profiles) && "active" in body;
  } catch {
    return false;
  }
}

async function resolvePidOnPort() {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync("netstat", ["-ano"]);
    for (const line of stdout.split(/\r?\n/)) {
      const m = /TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
      if (m && Number(m[1]) === port) return Number(m[2]);
    }
    return null;
  }
  try {
    const { stdout } = await execFileAsync("lsof", ["-tiTCP", String(port), "-sTCP:LISTEN"]);
    const pid = Number(stdout.trim().split(/\s+/)[0]);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

async function killPid(pid) {
  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill", ["/F", "/PID", String(pid)]);
    } catch {
      // already gone
    }
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

async function waitPortFree(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probeOk())) return true;
    await sleep(150);
  }
  return false;
}

if (await probeOk()) {
  if (await isNanitesDashboard()) {
    // A Nanites dashboard (usually an MCP lazy-spawned detached child) already
    // owns the port. Take it over so THIS spawned preview process serves it.
    const pid = await resolvePidOnPort();
    if (pid) {
      console.log(`nanites dashboard already on http://127.0.0.1:${port} (pid ${pid}); taking over`);
      await killPid(pid);
      if (await waitPortFree(3000)) {
        await import("../dist/ui/main.js");
      } else {
        console.error(`port ${port} still occupied after killing pid ${pid}; giving up`);
        process.exitCode = 1;
      }
    } else {
      await import("../dist/ui/main.js");
    }
  } else {
    console.log(`foreign process already serving http://127.0.0.1:${port}; holding for preview`);
    setInterval(() => {}, 1 << 30);
  }
} else {
  await import("../dist/ui/main.js");
}
