#!/usr/bin/env tsx
/**
 * Run the test regimen sequentially over a fixed set of model_ids on one
 * profile, in-process (no MCP transport). Long per-model runs routinely
 * outlast an MCP tool-call window, so sweeps like this execute out-of-band
 * against the real NANITES_HOME SQLite DB while the stdio server stays idle.
 *
 * Usage:
 *   npx tsx scripts/run-regimen-batch.ts [profile] [model_id ...]
 *
 * Defaults: profile = active profile name, models = the MODEL_IDS list below.
 * Pass "NANITES_HOME" env to redirect storage.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildDeps } from "../src/tools/deps.js";
import { runTestRegimen } from "../src/workflows/runTestRegimen.js";

function readActiveProfile(home: string): string | null {
  const p = join(home, "active_profile.json");
  if (!existsSync(p)) return null;
  try {
    return (JSON.parse(readFileSync(p, "utf8")).name as string).toLowerCase();
  } catch {
    return null;
  }
}

const MODEL_IDS = [
  "qwen3.8-4b-sft-fable5-glint-i1",
  "qwen3.8-4b-function-calling-xlam-unsloth",
  "qwen3.5-4b-emperoai-qwen3.8-distill-heretic-abliterated-i1",
  "qwen2.5-coder-7b-instruct-unity-i1",
  "nvidia/nemotron-3-nano-4b",
  "mistralai/ministral-3-3b",
];

const home = process.env.NANITES_HOME || join(homedir(), ".nanites");
const argProfile = process.argv[2];
const argModels = process.argv.slice(3);
const profile = argProfile ?? readActiveProfile(home);
const models = argModels.length > 0 ? argModels : MODEL_IDS;

console.log(`home=${home}`);
console.log(`profile=${profile}`);
console.log(`models=${JSON.stringify(models)}`);

const deps = buildDeps(home);
let ok = 0;
let failed = 0;
try {
  for (const modelId of models) {
    console.log(`\n=== regimen ${modelId} ===`);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const summary = await runTestRegimen(deps, profile, modelId);
        console.log(`RESULT ${JSON.stringify(summary)}`);
        ok++;
        break;
      } catch (err) {
        const code = (err as any)?.code ?? "unknown";
        const message = (err as any)?.message ?? String(err);
        console.log(`ERR_ATTEMPT_${attempt} ${JSON.stringify({ code, message })}`);
        if (code !== "database is locked" && !String(code).toLowerCase().includes("lock")) {
          failed++;
          break;
        }
        await new Promise((r) => setTimeout(r, 2500));
        if (attempt === 2) {
          failed++;
          console.log(`GAVE_UP ${modelId}`);
        }
      }
    }
  }
} finally {
  deps.close();
}
console.log(`\nDONE ok=${ok} failed=${failed}`);
