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
import { TUNNEL_OFF, type TunnelHandle, type TunnelState } from "./transport/tunnel.js";
import { setRouterHome } from "./constants.js";

export interface RouterDeps {
  db: DatabaseSync;
  /** The NANITES_HOME this router was started against. */
  home: string;
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
  /** An already-running tunnel, for the control surface to report. */
  tunnel?: TunnelHandle;
  /** Injectable so tests can drive the clock instead of sleeping. */
  rateLimiter?: unknown;
}

export function buildRouterDeps(home?: string, env: NodeJS.ProcessEnv = process.env): RouterDeps {
  ensureNanitesHome(home);
  const opened: NanitesDb = openNanitesDb(home);
  const resolved = resolveVirtualKey(opened.db, env);
  return {
    db: opened.db,
    home: opened.home,
    keyHash: resolved.hash,
    generatedKey: resolved.generated,
    config: () => readConfig(opened.db),
    close: () => opened.close(),
  };
}

export interface StartedRouter extends RouterServerHandle {
  deps: RouterDeps;
  /** Current tunnel state, or the off state when none is running. */
  tunnelState(): TunnelState;
}

export async function startRouter(opts: StartRouterOptions = {}): Promise<StartedRouter> {
  const env = opts.env ?? process.env;
  const deps = buildRouterDeps(opts.home, env);
  // Bind BEFORE anything can make a store call, so every provider lookup in
  // this process resolves against the database this router opened.
  setRouterHome(deps.home);

  // An explicit env var wins over the stored default so a user can move the
  // port without editing the database.
  const port = opts.port ?? Number(env.NANITES_ROUTER_PORT ?? DEFAULT_ROUTER_PORT);
  const bind = opts.bind ?? (env.NANITES_ROUTER_BIND ?? DEFAULT_ROUTER_BIND);

  // A live tunnel, if one was started. Optional rather than always-null so the
  // control surface has something real to report; a caller that never starts
  // one simply gets the off state.
  const tunnel: TunnelHandle | undefined = opts.tunnel;

  const handle = await startRouterServer({
    db: deps.db,
    port: Number.isFinite(port) ? port : DEFAULT_ROUTER_PORT,
    bind,
    keyHash: deps.keyHash,
    tunnel,
    rateLimiter: opts.rateLimiter as never,
  });

  // A TunnelHandle carries a `stop` method, so it is read field by field
  // rather than spread — spreading would fold the function into the state.
  const tunnelState = (): TunnelState =>
    tunnel
      ? {
          enabled: tunnel.enabled,
          running: tunnel.running,
          url: tunnel.url,
          pid: tunnel.pid,
          last_error: tunnel.last_error,
          started_at: tunnel.started_at,
        }
      : TUNNEL_OFF;

  return { ...handle, deps, tunnelState };
}
