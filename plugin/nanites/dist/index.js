import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { buildServer } from "./server/buildServer.js";
import { ensureNanitesHome } from "./config/paths.js";
import { lifecycleBoot, ensureLmStudioAtBoot, ensureDashboardStarted } from "./ui/lifecycle.js";
/**
 * Phase 0 stdio transport: owns the MCP server lifecycle and satisfies the
 * NanitesTransport seam. Later phases add HTTP/SSE without touching tool
 * logic.
 */
class StdioNanitesTransport {
    kind = "stdio";
    async start() {
        const server = buildServer({ uiController: { start: ensureDashboardStarted } });
        const transport = new StdioServerTransport();
        await server.connect(transport);
        await new Promise((resolve) => {
            transport.onclose = () => resolve();
        });
    }
    async stop() {
        // stdio transport ends when the process stream closes.
    }
}
async function main() {
    ensureNanitesHome();
    // Boot orchestration: kill a stale dashboard (leave it DOWN for lazy first-use
    // start) and ensure LM Studio is running. Dashboard spawn never happens here —
    // the first mapped tool starts it and the host opens the preview. Never blocks
    // or fails the stdio boot.
    await lifecycleBoot();
    void ensureLmStudioAtBoot();
    const transport = new StdioNanitesTransport();
    await transport.start();
}
void main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`nanites: fatal startup error: ${message}\n`);
    process.exitCode = 1;
});
