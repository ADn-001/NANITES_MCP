#!/usr/bin/env node
/**
 * `nanites-router` — the standalone gateway process.
 *
 * This entry point must stay INDEPENDENT of the MCP server. It does not import
 * src/index.ts, does not construct an MCP server, does not register tools, and
 * does not touch the LM Studio lifecycle. The router is a network service with
 * real provider spend behind it; making it depend on an agent harness would mean
 * the gateway goes down when the harness does.
 *
 * It shares NANITES_HOME and the SQLite database with the MCP server, which is
 * the whole point of the same-repo/same-database decision (D1): the provider
 * keys are already configured there and are not re-entered here.
 */
import { startRouter, type StartedRouter } from "./deps.js";
import { DEFAULT_ROUTER_BIND, DEFAULT_ROUTER_PORT } from "./server.js";

function line(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

export async function main(): Promise<void> {
  const port = Number(process.env.NANITES_ROUTER_PORT ?? DEFAULT_ROUTER_PORT);
  const bind = process.env.NANITES_ROUTER_BIND ?? DEFAULT_ROUTER_BIND;

  let started: StartedRouter;
  try {
    started = await startRouter();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`nanites-router: failed to start: ${message}\n`);
    process.exitCode = 1;
    return;
  }

  line(`nanites-router listening on http://${bind}:${started.port}`);
  line(`  health   http://${bind}:${started.port}/v1/health`);

  // Printed exactly once, and only when this boot generated one. A stored key
  // is never re-printed — stdout is not a secret store.
  if (started.deps.generatedKey) {
    line("");
    line(`  virtual API key (shown once): ${started.deps.generatedKey}`);
    line("  set NANITES_ROUTER_KEY to supply your own instead of this one.");
  }

  if (bind !== DEFAULT_ROUTER_BIND && bind !== "localhost") {
    line("");
    line(`  WARNING: bound to ${bind}, so this endpoint is reachable off-host.`);
    line("  The virtual API key is the only thing protecting real provider spend.");
  }

  const shutdown = (signal: string): void => {
    line(`\nnanites-router: ${signal}, shutting down`);
    void started.close().then(() => started.deps.close());
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

// Run only when executed directly, so importing this module in a test does not
// start a server.
const invokedDirectly = process.argv[1] !== undefined
  && (process.argv[1].endsWith("main.js") || process.argv[1].endsWith("main.ts"));
if (invokedDirectly) void main();
