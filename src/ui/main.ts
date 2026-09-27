/**
 * Companion-UI entry point. Builds the same ToolDeps (sharing NANITES_HOME with
 * the stdio MCP server) and starts the local HTTP dashboard. Launch via
 * `npm run ui` (== `node dist/ui/main.js`). Ctrl-C / SIGTERM close cleanly.
 */
import { buildDeps } from "../tools/deps.js";
import { startUiServer } from "./server.js";

async function main(): Promise<void> {
  const deps = buildDeps();
  const ui = await startUiServer(deps);
  process.stdout.write(`nanites ui listening on http://127.0.0.1:${ui.port}\n`);
  if (ui.lanToken) {
    // Broadcast is on. LAN peers get the read-only view; anything that mutates
    // needs the token, and there is no other way to obtain it: it is held in
    // memory only and rotates on every restart.
    const ip = ui.lanHosts[0];
    if (ip) {
      process.stdout.write(`  LAN (read-only): http://${ip}:${ui.port}\n`);
      // The token goes in a header, never a URL: a query string lands in shell
      // scrollback, terminal logs and browser history, and this grants mutation
      // of the profile store.
      process.stdout.write(`  LAN (full access): send header X-Nanites-Lan-Token: <token from LAN_TOKEN below>\n`);
      process.stdout.write(`  LAN token (in-memory, rotates on restart): ${ui.lanToken}\n`);
    } else {
      process.stdout.write("  Broadcast is on but no LAN address was found; LAN access is refused.\n");
    }
  }

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void ui.close().then(() => {
      deps.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((err: unknown) => {
  process.stderr.write(`nanites ui: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
