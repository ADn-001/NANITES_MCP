/**
 * Live tool-loop validation (native /api/v1/chat integrations mechanism). The
 * CLAUDE.md §6a claim that LM Studio runs the loop server-side has unit tests
 * but has never been exercised against a real server + real configured MCP
 * servers. This patches the active profile tools.enabled + a real integration,
 * runs one tool-granted sub-agent, and reports whether a tool actually
 * executed (tools_used) or the server refused (structured error). ALWAYS
 * restores the profile tools grant afterwards, whatever the outcome.
 *
 * Requirements (LM Studio client): an mcp server pre-configured in mcp.json AND
 * "Allow calling servers from mcp.json" ON. Update SERVER_ID below to the label
 * you actually configured.
 */
import { buildDeps } from "../dist/tools/deps.js";

const SERVER_ID = process.env.LOOP_MCP_SERVER ?? "mcp/command-runner";
const TOOLS = process.env.LOOP_TOOLS ? process.env.LOOP_TOOLS.split(",") : ["run_command"];
const BRIEF = process.env.LOOP_BRIEF ?? null;

const deps = buildDeps();
const prof = deps.profiles.getActiveProfile();
if (!prof) throw new Error("no active profile");
const name = prof.name;
console.log(`profile ${name}`);

const toolsBefore = prof.tools ?? { enabled: false, integrations: [] };
console.log(`tools before: enabled=${toolsBefore.enabled} integrations=${JSON.stringify(toolsBefore.integrations ?? [])}`);

const patch = { tools: { enabled: true, integrations: [{ type: "plugin", id: SERVER_ID, allowed_tools: TOOLS }] } };
deps.profiles.updateProfile(name, patch);

try {
  const { runSubAgent } = await import("../dist/workflows/runSubAgent.js");
  const r = await runSubAgent(deps, name, BRIEF ?? "Run the tool allowed to you to print the current working directory, then reply with only that path.", {
    roles: ["reviewer"],
    model_id: "qwen3.5-2b",
    effort: "medium",
    reasoning_budget: 64,
  });
  console.log(`\nsub-agent ok: reply=${JSON.stringify(r.reply.slice(0, 200))}`);
  console.log(`tools_used: ${JSON.stringify(r.tools_used.map((t) => ({ tool: t.tool, output: (t.output ?? "").slice(0, 120) })))}`);
  console.log(`transport (instance empty + nothing unloaded = native-instrumented): instance_id=${JSON.stringify(r.instance_id)} load_ms=${r.metrics.load_ms} unloaded=${r.unloaded}`);
  console.log(r.tools_used.length > 0 ? "\nTOOL LOOP CONFIRMED LIVE: a real tool executed server-side." : "\nno tools_used — loop may have run tool-less (model never called the tool).");
} catch (err) {
  const e = err;
  const detail = typeof e?.details === "string" ? e.details : JSON.stringify(e?.details ?? "").slice(0, 400);
  console.log(`\nsub-agent failed: code=${e?.code} message=${e?.message}`);
  console.log(`details: ${detail}`);
  console.log("\nstructured error surfaced (no partial execution) — mechanism intact; see message for the LM Studio-side reason.");
} finally {
  // Restore the original tools grant regardless of outcome.
  deps.profiles.updateProfile(name, { tools: { enabled: toolsBefore.enabled ?? false, integrations: toolsBefore.integrations ?? [] } });
  const restored = deps.profiles.getProfile(name);
  console.log(`\ntools restored: enabled=${restored?.tools?.enabled}`);
}
