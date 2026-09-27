/**
 * Live lifecycle probe (Phase 35). Against the real dashboard port:
 *   1. lifecycleBoot() must KILL the running dashboard (identity-checked).
 *   2. A mapped tool call (via buildServer + uiController) lazily restarts it
 *      and its FIRST call carries dashboard_url -> #/settings (once per kind);
 *      a second call of the same kind stays silent.
 * Run from repo root after `npm run build`. Requires a dashboard running on
 * NANITES_UI_PORT (default 4700) beforehand to prove the boot kill.
 */
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../dist/server/buildServer.js";
import { lifecycleBoot, ensureDashboardStarted } from "../dist/ui/lifecycle.js";
import { resetOpenState } from "../dist/ui/openSession.js";
import { uiPort } from "../dist/ui/autostart.js";

const port = uiPort();
const health = async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/profiles`, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch {
    return false;
  }
};

console.log(`dashboard before boot: ${(await health()) ? "RUNNING" : "down"}`);
console.log("calling lifecycleBoot() (kills a stale Nanites dashboard)...");
await lifecycleBoot();
console.log(`dashboard after boot:  ${(await health()) ? "RUNNING (should be down)" : "down (killed)"}`);

resetOpenState();
const home = process.env.NANITES_HOME;
const server = buildServer({ home, uiController: { start: ensureDashboardStarted } });
const [ct, st] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "lifecycle-probe", version: "0.0.1" });
await server.server.connect(st);
await client.connect(ct);

try {
  const r1 = await client.callTool({ name: "list_profiles", arguments: {} });
  const d1 = JSON.parse(r1.content.find((c) => c.type === "text")?.text ?? "{}");
  console.log(`\nfirst list_profiles: ok=${d1.ok} dashboard_url=${d1.data?.dashboard_url ?? "(none)"} action=${d1.data?.dashboard_action ?? "-"}`);
  console.log(`dashboard after first mapped tool: ${(await health()) ? "RUNNING (lazy start OK)" : "down (FAIL)"}`);

  const r2 = await client.callTool({ name: "list_profiles", arguments: {} });
  const d2 = JSON.parse(r2.content.find((c) => c.type === "text")?.text ?? "{}");
  console.log(`second list_profiles (same kind): dashboard_url=${d2.data?.dashboard_url ?? "(none — once per kind OK)"}`);
} finally {
  await client.close();
  await server.close();
}
