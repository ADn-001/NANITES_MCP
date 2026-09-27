/**
 * Automatic workflow ntfy pushes (fire-and-forget by the §1 contract). The
 * explicit `send_ntfy` tool stays; this adds the event hooks the user asked
 * for: health-gate down, regimen model-level start/end/error, and — inside
 * run_untested_sweep only — whole-sprint start/end/abort. A profile with no
 * `ntfy.topic` never touches the network, so every topic-null test stays
 * hermetic.
 *
 * Fire-and-forget shape: `fireProfilePush` is async but callers `void` it, so
 * a slow or failing push never stalls the workflow. It never throws (sendNtfy
 * never throws). Tests inject a capture `push` and `await` for determinism.
 */
import type { Profile } from "../storage/profileDefaults.js";
import { sendNtfy, type NtfyResult } from "./ntfy.js";

export type WorkflowPushKind =
  | "health_down"
  | "regimen.start"
  | "regimen.end"
  | "regimen.error"
  | "sprint.start"
  | "sprint.end"
  | "sprint.abort";

/** Each push kind reads the subset of these fields its message needs. */
export interface WorkflowPushFields {
  profile?: string;
  reason?: string;
  code?: string;
  model_id?: string;
  /** Cloud provider kind when the run was a routed (non-LM-Studio) regimen. */
  provider?: string;
  unit_count?: number;
  deterministic_scored?: number;
  pending?: number;
  empty_failed?: number;
  registered?: boolean;
  message?: string;
  detail?: string;
  untested_count?: number;
  models?: string[];
  tested?: number;
  failures?: number;
}

export function buildPush(kind: WorkflowPushKind, data: WorkflowPushFields): { message: string; tags: string[] } {
  switch (kind) {
    case "health_down":
      return {
        message: `Nanites ${data.profile}: health check failed — ${data.reason ?? data.message ?? "down"} (${data.code})`,
        tags: ["nanites", "down", "warning"],
      };
    case "regimen.start":
      return {
        message: `Nanites ${data.profile}: testing ${data.model_id}${data.provider ? ` via ${data.provider}` : ""} (${data.unit_count} units)...`,
        tags: ["nanites", "regimen", "start"],
      };
    case "regimen.end":
      return {
        message:
          `Nanites ${data.profile}: ${data.model_id} regimen done — ` +
          `${data.deterministic_scored} deterministic scored, ${data.pending} pending judgment` +
          `${(data.empty_failed ?? 0) > 0 ? `, ${data.empty_failed} empty-failed` : ""}` +
          `${data.registered ? ", registry entry written" : ""}`,
        tags: ["nanites", "regimen", "end"],
      };
    case "regimen.error":
      return {
        message:
          `Nanites ${data.profile}: ${data.model_id} regimen FAILED (${data.code}): ${data.message}` +
          `${data.detail ? ` — ${data.detail}` : ""}`,
        tags: ["nanites", "regimen", "error", "warning"],
      };
    case "sprint.start":
      return {
        message:
          `Nanites ${data.profile}: untested sweep starting — ${data.untested_count} model` +
          `${data.untested_count === 1 ? "" : "s"}: ${(data.models ?? []).join(", ")}`,
        tags: ["nanites", "sweep", "start"],
      };
    case "sprint.end":
      return {
        message:
          `Nanites ${data.profile}: untested sweep done — ${data.tested} tested` +
          `${(data.failures ?? 0) > 0 ? `, ${data.failures} failed` : ""}`,
        tags: ["nanites", "sweep", "end"],
      };
    case "sprint.abort":
      return {
        message: `Nanites ${data.profile}: untested sweep ABORTED (${data.code}): ${data.message}`,
        tags: ["nanites", "sweep", "error", "warning"],
      };
  }
}

export type PushFn = (ntfy: Profile["ntfy"], message: string, tags?: string[]) => Promise<NtfyResult>;

export async function fireProfilePush(
  profile: Profile,
  kind: WorkflowPushKind,
  data: WorkflowPushFields,
  push: PushFn = sendNtfy,
): Promise<void> {
  if (!profile.ntfy.topic) return;
  try {
    await push(profile.ntfy, buildPush(kind, data).message, buildPush(kind, data).tags);
  } catch {
    // Fire-and-forget contract: never let a failed push fail the operation.
  }
}
