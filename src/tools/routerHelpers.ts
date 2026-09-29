/**
 * The helper toggle, as an MCP tool.
 *
 * Writes the router's config row DIRECTLY rather than calling
 * `PATCH /v1/config` over HTTP. The MCP server and the router share one
 * `nanites.db` (see src/storage/db.ts and routerProfile()), so the HTTP hop
 * would add a network round trip and a hard dependency on the router process
 * being up — for a setting that must be changeable precisely when the router
 * is not behaving.
 *
 * What the MCP tool CANNOT do is what the HTTP route does: kill the resident
 * workers. That needs the running process. So the tool reports honestly whether
 * the workers were stopped or whether that is pending, rather than claiming a
 * clean stop it did not perform.
 */
import type { DatabaseSync } from "node:sqlite";
import { NanitesError } from "../helpers/errors.js";
import { updateConfig, readConfig } from "../router/auth.js";
import { routerProfile } from "../router/constants.js";
import {
  HELPER_FEATURES,
  HELPER_FEATURE_NAMES,
  featureColumn,
  readHelperFlags,
} from "../router/helpers/features.js";

export interface HelperToggleResult {
  enable_helpers: boolean;
  features: Record<string, boolean>;
  /** The evidence behind each feature, so the choice is informed. */
  evidence: Record<string, string>;
  /** Which helper serves each feature. */
  served_by: Record<string, string>;
  /**
   * False when the workers could not be stopped from here. The next router
   * request will not use them either (the flag gates every call site), but a
   * resident model keeps its memory until the router process restarts.
   */
  workers_stopped: boolean | null;
  note: string;
}

/** Read the current helper state. */
export function readHelperState(db: DatabaseSync): Record<string, unknown> {
  const flags = readHelperFlags(db);
  const evidence: Record<string, string> = {};
  const served: Record<string, string> = {};
  for (const name of HELPER_FEATURE_NAMES) {
    evidence[name] = HELPER_FEATURES[name].evidence;
    served[name] = HELPER_FEATURES[name].helper;
  }
  return {
    enable_helpers: flags.enabled,
    features: flags.features,
    evidence,
    served_by: served,
  };
}

/**
 * Apply a helper toggle.
 *
 * `features` is a partial map: naming a feature turns it on or off without
 * disturbing the others, which is the whole reason the flags are per-feature.
 * An unknown feature name is REJECTED rather than ignored — a silently dropped
 * key reads as "the router took my setting" and is discovered days later with
 * the flag still off.
 */
export function applyHelperToggle(
  db: DatabaseSync,
  args: { enable?: boolean; features?: Record<string, boolean> },
): HelperToggleResult {
  const patch: Record<string, boolean> = {};

  if (args.enable !== undefined) patch["enable_helpers"] = args.enable;
  for (const [name, value] of Object.entries(args.features ?? {})) {
    if (!HELPER_FEATURE_NAMES.includes(name as never)) {
      throw new NanitesError({
        code: "invalid_arguments",
        message: `Unknown helper feature "${name}". Known: ${HELPER_FEATURE_NAMES.join(", ")}.`,
        retryable: false,
        details: { name, known: HELPER_FEATURE_NAMES },
      });
    }
    if (typeof value !== "boolean") {
      throw new NanitesError({
        code: "invalid_arguments",
        message: `"${name}" must be a boolean.`,
        retryable: false,
        details: { name },
      });
    }
    patch[featureColumn(name as never)] = value;
  }

  if (Object.keys(patch).length === 0) {
    throw new NanitesError({
      code: "invalid_arguments",
      message: `Nothing to change. Pass enable (boolean) and/or features (e.g. {"tool_repair": true}).`,
      retryable: false,
      details: { features: HELPER_FEATURE_NAMES },
    });
  }

  const wasEnabled = Boolean(readConfig(db)?.enable_helpers);
  const config = updateConfig(db, patch);
  const nowEnabled = Boolean(config.enable_helpers);
  const flags = readHelperFlags(db);

  const evidence: Record<string, string> = {};
  const served: Record<string, string> = {};
  for (const name of HELPER_FEATURE_NAMES) {
    evidence[name] = HELPER_FEATURES[name].evidence;
    served[name] = HELPER_FEATURES[name].helper;
  }

  // The workers can only be killed by the router process. The flag gates every
  // call site regardless, so nothing will USE a helper after this — but a
  // resident model keeps its memory, and saying "stopped" from here would be a
  // claim this process cannot back up.
  const workersStopped = wasEnabled && !nowEnabled ? false : null;

  return {
    enable_helpers: nowEnabled,
    features: flags.features as unknown as Record<string, boolean>,
    evidence,
    served_by: served,
    workers_stopped: workersStopped,
    note: workersStopped === false
      ? "Helpers are off and no request will use them. The running router still holds the loaded model in memory; it is released on restart, or immediately via PATCH /v1/config {\"enable_helpers\":false} against the live router."
      : `Router profile: ${routerProfile()}. Every feature defaults to off.`,
  };
}
