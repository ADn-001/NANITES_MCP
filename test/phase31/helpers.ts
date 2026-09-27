/**
 * Phase 31 (E gate) helpers: unit factories + a bare store-only deps builder
 * (no mock LM Studio needed for the aggregation/write-registry tests). The
 * regimen/serial-judging tests reuse the phase7 harness and the low-confidence
 * sub-agent tests reuse the phase8 harness, exactly as phase11's DoD suite does.
 */
import { buildDeps, type ToolDeps } from "../../src/tools/deps.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

export interface StoreDeps {
  deps: ToolDeps;
  home: string;
  close(): void;
}

/** A fresh deps + profile "t" over a scratch home; no network needed. */
export function makeStoreDeps(name = "t"): StoreDeps {
  const home = scratchHome();
  const deps = buildDeps(home);
  deps.profiles.createProfile({ name });
  return {
    deps,
    home,
    close() {
      deps.close();
      cleanup(home);
    },
  };
}

/** Deterministic exact-match unit (classifier / QUESTION) — same shape as the
 * phase7 mini-det so a regimen built from it finalizes with no pending rows. */
export function detUnit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "det-u",
    name: "classify intent",
    task_group: "task2",
    difficulty: "easy",
    prompts: [
      {
        id: "a",
        text: 'Classify as exactly one of: BUG, FEATURE, QUESTION, OTHER. Respond with only the label.\n\n"export my data"',
      },
    ],
    measures: ["format_compliance"],
    applicable_roles: ["classifier"],
    recommended_config: {
      context_length: 2000,
      kv_cache_quant: "Q4",
      temperature: 0,
      top_p: 1,
      top_k: 1,
      repeat_penalty: 1,
      max_output_tokens: 10,
    },
    scoring: { method: "deterministic_rule", rule: { type: "exact_match", params: { expected: "QUESTION" } } },
    source: "custom_authored",
    version: 1,
    ...overrides,
  };
}

/** Orchestrator-judged unit (reviewer default). Recommended temperature 0.2 ->
 * baseline 0.2, variant min(0.8, 0.7)=0.7, so the two candidates carry distinct
 * sampling params the best_params split (E6) can be asserted against. */
export function judgedUnit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "judged-u",
    name: "review a change",
    task_group: "task6",
    difficulty: "easy",
    prompts: [{ id: "a", text: "Review this diff for correctness and regressions." }],
    measures: ["quality"],
    applicable_roles: ["reviewer"],
    recommended_config: {
      context_length: 2000,
      kv_cache_quant: "Q4",
      temperature: 0.2,
      top_p: 0.9,
      top_k: 40,
      repeat_penalty: 1,
      max_output_tokens: 40,
    },
    scoring: { method: "orchestrator_judged", rubric: "Correctness matters; honesty matters; conciseness matters." },
    source: "custom_authored",
    version: 1,
    ...overrides,
  };
}

/** Sampling knobs `best_params` is allowed to carry (E6). */
export const SAMPLING = ["temperature", "top_p", "top_k", "min_p", "repeat_penalty"];
