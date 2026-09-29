/**
 * Router dependency container.
 *
 * Mirrors the shape of `src/tools/deps.ts` so the two are recognisable, but
 * deliberately smaller: the router has no MCP server, no LM Studio lifecycle,
 * and no UI autostart. It opens the same database and nothing else.
 */
import type { DatabaseSync } from "node:sqlite";
import { openNanitesDb, type NanitesDb } from "../storage/db.js";
import { ensureNanitesHome } from "../config/paths.js";
import { resolveVirtualKey, readConfig, type RouterConfigRow } from "./auth.js";
import { startRouterServer, DEFAULT_ROUTER_PORT, DEFAULT_ROUTER_BIND, type RouterServerHandle } from "./server.js";

export interface RouterDeps {
  db: DatabaseSync;
  keyHash: string;
  /** Printed once on first boot. Null when an existing key was reused. */
  generatedKey: string | null;
  config(): RouterConfigRow | null;
  close(): void;
}

export interface StartRouterOptions {
  home?: string;
  port?: number;
  bind?: string;
  env?: NodeJS.ProcessEnv;
}

export function buildRouterDeps(home?: string, env: NodeJS.ProcessEnv = process.env): RouterDeps {
  ensureNanitesHome(home);
  const opened: NanitesDb = openNanitesDb(home);
  const resolved = resolveVirtualKey(opened.db, env);
  return {
    db: opened.db,
    keyHash: resolved.hash,
    generatedKey: resolved.generated,
    config: () => readConfig(opened.db),
    close: () => opened.close(),
  };
}

export interface StartedRouter extends RouterServerHandle {
  deps: RouterDeps;
}

export async function startRouter(opts: StartRouterOptions = {}): Promise<StartedRouter> {
  const env = opts.env ?? process.env;
  const deps = buildRouterDeps(opts.home, env);

  // An explicit env var wins over the stored default so a user can move the
  // port without editing the database.
  const port = opts.port ?? Number(env.NANITES_ROUTER_PORT ?? DEFAULT_ROUTER_PORT);
  const bind = opts.bind ?? (env.NANITES_ROUTER_BIND ?? DEFAULT_ROUTER_BIND);

  const handle = await startRouterServer({
    db: deps.db,
    port: Number.isFinite(port) ? port : DEFAULT_ROUTER_PORT,
    bind,
    keyHash: deps.keyHash,
  });

  return { ...handle, deps };
}
