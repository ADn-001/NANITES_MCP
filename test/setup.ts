/**
 * Global test isolation.
 *
 * Two things leak from the host into the suite today:
 *
 *  1. `NANITES_HOME` is set in only 5 of 129 test files, so the rest read and
 *     write the developer's real `~/.nanites/` — the registry, call log, and the
 *     plaintext provider-key store. Nothing lands in git (the path is ignored),
 *     but a test run can corrupt real state.
 *  2. The health check measures free disk to decide `healthy` vs `degraded`.
 *     With no explicit dir it fell back to the OS temp dir, so on a host whose
 *     system volume is nearly full, `phase14/server` and `phase5/tools` failed
 *     with `expected 'degraded' to be 'healthy'` — a machine-state failure that
 *     has nothing to do with the code under test, and one CI cannot have.
 *
 * Both are fixed here rather than in each test file, so a new test inherits them.
 * `vitest.config.ts` sets `fileParallelism: false`, so one shared scratch home
 * per file is safe.
 */
import fs from "node:fs";
import { resetInferenceGates } from "../src/helpers/inferenceGate.js";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";

let scratch: string | undefined;
let previousHome: string | undefined;
let previousModelsDir: string | undefined;

beforeAll(() => {
  previousHome = process.env.NANITES_HOME;
  previousModelsDir = process.env.NANITES_LMSTUDIO_MODELS_DIR;

  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nanites-test-"));
  // Point the DB home at the scratch dir...
  process.env.NANITES_HOME = path.join(scratch, "home");
  // ...and the disk probe at a real directory inside it. The models dir
  // resolves through `defaultDiskDir()` (src/health/checker.ts), which honours
  // this var, so the health report no longer depends on host free space.
  const modelsDir = path.join(scratch, "models");
  fs.mkdirSync(modelsDir, { recursive: true });
  process.env.NANITES_LMSTUDIO_MODELS_DIR = modelsDir;
  fs.mkdirSync(process.env.NANITES_HOME, { recursive: true });
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.NANITES_HOME;
  else process.env.NANITES_HOME = previousHome;
  if (previousModelsDir === undefined) delete process.env.NANITES_LMSTUDIO_MODELS_DIR;
  else process.env.NANITES_LMSTUDIO_MODELS_DIR = previousModelsDir;
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

// The CP-4 inference gate is a module-level promise chain keyed by profile
// name. Tests reuse the same profile names across files, so a gate left held
// by one test deadlocks the next with a 30s timeout that looks like a slow
// test rather than a shared singleton. Clear it per file.
beforeEach(() => {
  resetInferenceGates();
});
afterAll(() => {
  resetInferenceGates();
});
