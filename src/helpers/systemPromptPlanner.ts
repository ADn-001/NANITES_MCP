/**
 * Deterministic per-call system-prompt builder. Same
 * philosophy as the inference planner: the orchestrator writes the brief; this
 * helper owns the model-facing frame around it. Pure function — no clock, no
 * I/O.
 *
 * Layering, top-to-bottom:
 *   0. Persistent base — the profile's `inference.system_prompt`, when set.
 *   1. Identity + purpose.
 *   2. Scope / guardrails (from profile use_case, hardware tier, effort).
 *   3. Role block (output contract).
 *   4. Tool manifest (only when a tool-loop is attached).
 *
 * A per-call `system_prompt_override` on the brief replaces the entire
 * generated header verbatim (override > generated > none).
 */
import type { Effort, ReasoningType } from "./inferencePlanner.js";

export interface ToolDef {
  name: string;
  description: string;
  input_schema?: Record<string, unknown>;
}

export interface SystemPromptInput {
  profile: {
    use_case: string;
    machine_specs: { vram_gb: number; gpu: string };
    concurrency: { mode: "sequential" | "parallel"; max_parallel_models: number; num_parallel: number };
    effort: Effort;
    dynamic_model: boolean;
    system_prompt?: string | null;
  };
  role: string;
  /** Present only when a tool-loop is active (not yet implemented this sprint). */
  toolManifest?: ToolDef[];
  modelId: string;
  reasoningType: ReasoningType;
}

function blocks(...parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => Boolean(p && p.trim())).join("\n\n");
}

export function buildSystemPrompt(input: SystemPromptInput): string {
  const { max_parallel_models: processCap, num_parallel: slots } = input.profile.concurrency;
  const tier =
    input.profile.concurrency.mode === "sequential"
      ? `${input.profile.machine_specs.vram_gb}GB VRAM, sequential ${processCap}x${slots}, one inference at a time`
      : `${input.profile.machine_specs.vram_gb}GB VRAM, parallel ${processCap}x${slots}`;
  const mode = input.profile.dynamic_model ? "dynamic role-based selection" : "your own currently-loaded model";
  const reasoningNote =
    input.reasoningType === "non_reasoning" ? "" : " Reason before answering when the task warrants it.";

  const identity =
    "You are a Nanites sub-agent on a local workstation. You are the delegate, not the orchestrator: you receive one self-contained task and return one answer.";

  const scope = blocks(
    `Scope: use-case "${input.profile.use_case}". Hardware: ${tier}. Effort level: ${input.profile.effort}. Selection mode: ${mode}.`,
    `You are running as ${input.role || "a general sub-agent"}. Stay within the task; do not extend beyond what is asked.`,
  );

  const toolBlock =
    input.toolManifest && input.toolManifest.length > 0
      ? `You may only act through the following tools — never by inventing file access:\n${JSON.stringify(
          input.toolManifest.map((t) => t.name),
        )}`
      : null;

  return blocks(input.profile.system_prompt ?? null, identity, scope, toolBlock) + reasoningNote;
}
