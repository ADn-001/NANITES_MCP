import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { buildDeps } from "../tools/deps.js";
import { registerAllTools } from "../tools/toolkit.js";
import { sweepOrphanedJobs } from "../workflows/jobRecovery.js";
import { registerNanitesPrompts } from "./prompts.js";
/**
 * Reported to the MCP client on handshake. Kept in step with `package.json`
 * and the plugin manifest by test/phase38 — a plugin's `version` pins users to
 * a cached copy until the string changes, so a divergent one silently serves
 * stale code.
 */
export const NANITES_VERSION = "1.0.0";
/**
 * Assemble the MCP server. Exposes the liveness probe plus the full §2 tool
 * surface; every handler resolves its storage/endpoint through the tool
 * dependency bundle. Tools return structured envelopes — never raw throws.
 */
export function buildServer(options = {}) {
    const deps = options.deps ?? buildDeps(options.home);
    if (!options.deps) {
        // Real boot only — an injected bundle is a test harness that owns its own
        // rows. Recovery must never keep the server from starting.
        try {
            sweepOrphanedJobs(deps);
        }
        catch {
            // Best effort: a failed sweep leaves the rows as they were, and the next
            // boot retries.
        }
    }
    const server = new McpServer({
        name: options.name ?? "nanites",
        version: options.version ?? NANITES_VERSION,
    }, { capabilities: { tools: {}, prompts: {} } });
    server.registerTool("nanites_ping", {
        title: "Nanites Ping",
        description: "Liveness probe for the Nanites MCP server. Returns server identity and transport health.",
        inputSchema: z.object({}),
    }, async () => ({
        content: [{ type: "text", text: JSON.stringify({ ok: true, service: "nanites", version: options.version ?? NANITES_VERSION }) }],
    }));
    registerAllTools(server, deps, { ui: options.uiController });
    registerNanitesPrompts(server);
    if (!options.deps) {
        // Close the home we opened so the process exits cleanly with the server.
        const close = server.close.bind(server);
        Object.defineProperty(server, "close", {
            value: async () => {
                await close();
                deps.close();
            },
            configurable: true,
        });
    }
    return server;
}
