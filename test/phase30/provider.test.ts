/**
 * Phase 30 gate (Phase D) — the local @huggingface/tokenizers provider
 * (probe-selected branch: no server tokenize endpoint exists). Exercises the
 * real WASM tokenizer through a vendored fixture (no network): cache-hit
 * resolution, local-model-dir sourcing with cache priming, and the
 * never-hard-fail chars/4 fallback for unresolved models. The HF-fetch path
 * cannot be exercised offline and is skipped (allowFetch stays off here).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countTokensAccurate, getTokenizerProvider } from "../../src/helpers/tokenize.js";
import { huggingfaceTokenizerProvider } from "../../src/helpers/tokenizerProvider.js";
import { buildDeps } from "../../src/tools/deps.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "mini-wordpiece", "tokenizer.json");
const REPO = "acme/mini-wordpiece";
// chars/4 for this text rounds to 7; the fixture tokenizer yields 5 — distinct,
// proving the provider (not the fallback) produced the count.
const SAMPLE = "hello world tokenizer probe";
const FALLBACK = 7;
const PROVIDER_COUNT = 5;

function cacheName(repoKey: string): string {
  return repoKey.replace(/[^A-Za-z0-9._-]+/g, "_") + ".json";
}

describe("Phase 30 gate — HF tokenizer provider", () => {
  it("counts against a cached tokenizer.json (no network) and differs from chars/4", async () => {
    const home = scratchHome();
    try {
      const cacheDir = join(home, "tokenizers");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, cacheName(REPO)), readFileSync(FIXTURE, "utf8"));
      const provider = huggingfaceTokenizerProvider({ cacheDir, allowFetch: false });

      expect(provider.id).toBe("hf-tokenizers");
      expect(await provider.count(SAMPLE, { repoId: REPO })).toBe(PROVIDER_COUNT);
      // memoized: a second call resolves from memory with the same result.
      expect(await provider.count(SAMPLE, { repoId: REPO })).toBe(PROVIDER_COUNT);
      // the seam honors an explicit provider and falls back otherwise.
      expect(await countTokensAccurate(SAMPLE, { repoId: REPO, provider })).toBe(PROVIDER_COUNT);
      expect(await countTokensAccurate(SAMPLE)).toBe(FALLBACK);
    } finally {
      cleanup(home);
    }
  });

  it("sources from a local LM Studio models dir and primes the cache", async () => {
    const home = scratchHome();
    try {
      const cacheDir = join(home, "tokenizers");
      const modelsDir = join(home, "models");
      const modelDir = join(modelsDir, ...REPO.split("/"));
      mkdirSync(modelDir, { recursive: true });
      copyFileSync(FIXTURE, join(modelDir, "tokenizer.json"));

      const provider = huggingfaceTokenizerProvider({ cacheDir, modelsDir, allowFetch: false });
      expect(await provider.count(SAMPLE, { repoId: REPO })).toBe(PROVIDER_COUNT);
      // the local source was copied into the cache for future resolutions.
      expect(existsSync(join(cacheDir, cacheName(REPO)))).toBe(true);
    } finally {
      cleanup(home);
    }
  });

  it("returns null for unresolved models and the seam never hard-fails", async () => {
    const home = scratchHome();
    try {
      const cacheDir = join(home, "tokenizers");
      mkdirSync(cacheDir, { recursive: true });
      const provider = huggingfaceTokenizerProvider({ cacheDir, allowFetch: false });

      // No repo-shaped model id -> provider cannot resolve.
      expect(await provider.count(SAMPLE, { modelId: "not-a-repo", repoId: undefined })).toBeNull();
      // Unknown repo, fetch disabled -> null, seam falls back to chars/4.
      expect(await provider.count(SAMPLE, { repoId: "nope/missing" })).toBeNull();
      expect(await countTokensAccurate(SAMPLE, { repoId: "nope/missing", provider })).toBe(FALLBACK);
      // Traversal-ish repo keys are rejected, not joined into paths.
      expect(await provider.count(SAMPLE, { repoId: "../evil/name" })).toBeNull();
      // Arbitrary hostile text never throws and yields a number.
      expect(await countTokensAccurate("\x00\x01😀 zzqq xyz", { repoId: REPO, provider })).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup(home);
    }
  });
});

describe("Phase 30 gate — buildDeps default provider", () => {
  it("registers an HF provider rooted under the home, resolving nothing offline", async () => {
    const home = scratchHome();
    const deps = buildDeps(home);
    try {
      const p = getTokenizerProvider();
      expect(p).not.toBeNull();
      expect(p!.id).toBe("hf-tokenizers");
      // Unresolvable offline -> accurate count equals the chars/4 fallback.
      expect(await countTokensAccurate(SAMPLE, { repoId: "nope/missing" })).toBe(FALLBACK);
    } finally {
      deps.close();
      cleanup(home);
    }
  });
});
