/**
 * Companion-UI autostart. Called once at MCP server boot (first start of a
 * session). Ensures the dashboard is running as a persistent background
 * process. Fire-and-forget: never lets a UI failure fail the MCP startup.
 *
 * The dashboard is spawned (and kept running) by default but is NOT opened in
 * an external browser by default — surface it in Claude's embedded preview
 * pane instead. Re-enable the external browser open with NANITES_OPEN_BROWSER=1.
 * Disable the whole autostart (spawn + open) with NANITES_AUTOSTART_UI=0.
 * Port follows NANITES_UI_PORT.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_UI_PORT } from "./server.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HEALTH_PATH = "/api/health";

export function autostartUiEnabled(): boolean {
  return (process.env.NANITES_AUTOSTART_UI ?? "1") !== "0";
}

export function openBrowserEnabled(): boolean {
  return (process.env.NANITES_OPEN_BROWSER ?? "0") === "1";
}

export function uiPort(): number {
  const raw = Number(process.env.NANITES_UI_PORT ?? DEFAULT_UI_PORT);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_UI_PORT;
}

export async function uiReachable(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function openBrowser(url: string): void {
  const cmd = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: "ignore", shell: true });
    child.unref();
  } catch {
    // best-effort; never fail startup because a browser could not open
  }
}

export function uiEntry(): string {
  const built = join(ROOT, "dist", "ui", "main.js");
  return existsSync(built) ? built : join(ROOT, "src", "ui", "main.ts");
}

export async function pollHealthy(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await uiReachable(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

export async function maybeStartUi(): Promise<void> {
  if (!autostartUiEnabled()) return;
  const port = uiPort();
  const url = `http://127.0.0.1:${port}`;

  if (await uiReachable(port)) {
    if (openBrowserEnabled()) openBrowser(url);
    return;
  }

  const entry = uiEntry();
  try {
    const child = spawn(process.execPath, [entry], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  } catch {
    return;
  }

  const healthy = await pollHealthy(port, 6000);
  if (healthy && openBrowserEnabled()) openBrowser(url);
}
