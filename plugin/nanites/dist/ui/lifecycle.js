/**
 * Dashboard + LM Studio process lifecycle.
 *
 * The MCP server NEVER binds `NANITES_UI_PORT` itself and never spawns a
 * dashboard child. The dashboard is served by the embedded-preview launch
 * command (`scripts/ui-attach-or-start.mjs`, which binds 4700 in the preview's
 * own process); mapped tools (see `src/tools/toolkit.ts` UI_PLAN) decorate
 * their result with a `dashboard_url` deep link, and the host agent opens that
 * in the preview pane, which starts the server. When a dashboard is already
 * serving the port (e.g. a prior preview is still open), the MCP reuses it —
 * it never kills on a mapped tool.
 *
 * - Boot KILLS a stale dashboard left on the port (ours — identity-checked,
 *   never a foreign listener) so the next preview attach can bind, and ensures
 *   LM Studio is up (start via `lms server start` when it is not), both
 *   fire-and-forget.
 *
 * All of it respects `NANITES_AUTOSTART_UI=0` (full opt-out: no spawn, no
 * kill, no dashboard_url decoration) and never opens an external browser (the
 * host opens the preview).
 */
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { autostartUiEnabled, uiPort, uiReachable } from "./autostart.js";
import { ProfileManager } from "../storage/profileManager.js";
import { clientForProfile } from "../tools/deps.js";
import { runHealthCheck, defaultRecovery } from "../health/checker.js";
import { resolveNanitesHome } from "../config/paths.js";
const execFileAsync = promisify(execFile);
/**
 * Report dashboard state for a mapped tool's decoration. Never binds the port
 * and never spawns a child — the dashboard is started by the host opening the
 * returned `dashboard_url` in the embedded preview (its launch command binds
 * the port). When a dashboard is already serving (a prior preview is open), it
 * is reused. `enabled:false` means the caller must omit `dashboard_url`.
 */
export async function ensureDashboardStarted() {
    const port = uiPort();
    const url = `http://127.0.0.1:${port}`;
    if (!autostartUiEnabled())
        return { url, started: false, enabled: false };
    const started = await uiReachable(port);
    return { url, started, enabled: true };
}
/** True when the listener on `port` answers as the Nanites dashboard. */
async function isNanitesDashboard(port) {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/profiles`, {
            signal: AbortSignal.timeout(1500),
        });
        if (!res.ok)
            return false;
        const body = (await res.json());
        return Array.isArray(body.profiles) && "active" in body;
    }
    catch {
        return false;
    }
}
async function resolvePidOnPort(port) {
    if (process.platform === "win32") {
        const { stdout } = await execFileAsync("netstat", ["-ano"]);
        for (const line of stdout.split(/\r?\n/)) {
            // "  TCP    0.0.0.0:4700   ...  LISTENING       12345"
            const m = /TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
            if (m && Number(m[1]) === port)
                return Number(m[2]);
        }
        return null;
    }
    try {
        const { stdout } = await execFileAsync("lsof", ["-tiTCP", String(port), "-sTCP:LISTEN"]);
        const pid = Number(stdout.trim().split(/\s+/)[0]);
        return Number.isFinite(pid) ? pid : null;
    }
    catch {
        return null;
    }
}
async function killPid(pid) {
    if (process.platform === "win32") {
        try {
            await execFileAsync("taskkill", ["/F", "/PID", String(pid)]);
        }
        catch {
            // already gone
        }
    }
    else {
        try {
            process.kill(pid, "SIGTERM");
        }
        catch {
            // already gone
        }
    }
}
/**
 * Kill a stale Nanites dashboard on the configured port. Identity-checks first
 * (`/api/profiles` shape) so a foreign process is never killed, and waits for
 * the port to free so a subsequent lazy start cannot EADDRINUSE. No-op when
 * autostart is disabled (NANITES_AUTOSTART_UI=0) or nothing is running.
 */
/**
 * True while something is still listening on the port. Uses a TCP connect
 * rather than an HTTP route, so it cannot be fooled by a 404 from a route
 * that only answers under certain conditions.
 */
async function portStillBound(port) {
    return new Promise((resolve) => {
        const sock = net.connect({ port, host: "127.0.0.1" });
        const done = (bound) => {
            sock.destroy();
            resolve(bound);
        };
        sock.setTimeout(1000);
        sock.once("connect", () => done(true));
        sock.once("timeout", () => done(false));
        sock.once("error", () => done(false));
    });
}
export async function killStaleDashboard(port) {
    if (!autostartUiEnabled())
        return;
    const target = port ?? uiPort();
    if (!(await isNanitesDashboard(target)))
        return;
    const pid = await resolvePidOnPort(target);
    if (!pid)
        return;
    await killPid(pid);
    // Poll until the health probe stops answering (port released), ~3s max.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
        // Reachability here means "the port is still bound", not "healthy":
        // /api/health answers 404 when no profile is active, and uiReachable
        // checks res.ok, so the wait exited on the first poll while the killed
        // process still held the port and the next listen hit EADDRINUSE
        //. Probe a route that always answers once bound.
        if (!(await portStillBound(target)))
            return;
        await new Promise((r) => setTimeout(r, 150));
    }
}
/**
 * Fire-and-forget LM Studio ensure at boot: run the health check with the
 * default `lms server start` recovery against the active profile. Never throws;
 * failures only log a warning — a down LMS surfaces at the first tool call.
 */
export async function ensureLmStudioAtBoot(home = resolveNanitesHome()) {
    try {
        const profile = new ProfileManager(home).getActiveProfile();
        if (!profile)
            return; // defer: the ensure needs an active profile's endpoint
        const report = await runHealthCheck({
            profile: profile.name,
            client: clientForProfile(profile),
            recovery: defaultRecovery(),
        });
        if (!report.reachable) {
            process.stderr.write(`nanites: boot health: ${report.reason} (check via system_health_check)\n`);
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`nanites: boot health probe failed: ${message}\n`);
    }
}
/** Boot sequence: kill the stale dashboard, leave it down for lazy start. */
export async function lifecycleBoot() {
    await killStaleDashboard();
    // Run provider error cleanup if any profile is active.
    const profiles = new ProfileManager();
    const active = profiles.getActiveProfile();
    if (active) {
        const { openNanitesDb } = await import("../storage/db.js");
        const { db } = openNanitesDb();
        try {
            const { runErrorCleanup } = await import("../providers/router.js");
            runErrorCleanup(db, active.name);
        }
        finally {
            db.close();
        }
    }
}
