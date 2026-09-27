/**
 * Model-accurate tokenizer provider (Phase D, probe-gated else-branch). LM
 * Studio's REST API exposes no tokenize endpoint (recorded in GATELOG Phase B),
 * so accurate counts come from the real tokenizer.json of the model family via
 * `@huggingface/tokenizers` (WASM, no Python sidecar).
 *
 * Resolution order for a model:
 *   1. in-memory (per-process memoized tokenizer),
 *   2. disk cache under `cacheDir` (NANITES_HOME/tokenizers),
 *   3. a local LM Studio models dir (env `NANITES_LMSTUDIO_MODELS_DIR`), for
 *      unpacked models that ship a tokenizer.json — note GGUF models embed
 *      theirs, so this only matches non-GGUF installs,
 *   4. a fetch from Hugging Face (only when `allowFetch`) — the registry
 *      `source` repo id (CLAUDE.md §1) is the key to fetch against.
 *
 * The provider never hard-fails: it returns null on any unresolvable model,
 * offline miss, or load error, and the seam then yields the chars/4 estimate
 * (always *a* number — btw chunking depends on that).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TokenizeOptions, TokenizerProvider } from "./tokenize.js";

export interface TokenizerProviderOptions {
  /** Directory to persist fetched/resolved tokenizer.json files under. */
  cacheDir: string;
  /** Optional local LM Studio models dir (author/model/tokenizer.json). */
  modelsDir?: string;
  /** Allow an HF fetch on a cache + local miss. Off by default; a tool server
   * should only reach the network when the operator opts in
   * (`NANITES_HF_FETCH=1`). */
  allowFetch?: boolean;
  fetchTimeoutMs?: number;
}

/** Repo-keyed segment regex — rejects empty, `.` and `..` (no traversal). */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Derive a repo key from the call. An explicit repoId (registry `source`)
 * wins; otherwise a slash-shaped modelId is treated as the repo candidate. */
function toRepoKey(opts: TokenizeOptions): string | null {
  const raw = opts.repoId && opts.repoId.trim().length > 0 ? opts.repoId : opts.modelId;
  if (!raw) return null;
  const segs = raw.split("/");
  if (segs.length === 0) return null;
  for (const s of segs) {
    if (s === "" || s === "." || s === ".." || !SEGMENT.test(s)) return null;
  }
  return segs.join("/");
}

function cacheFileFor(cacheDir: string, repoKey: string): string {
  return join(cacheDir, repoKey.replace(/[^A-Za-z0-9._-]+/g, "_") + ".json");
}

type LoadedTokenizer = { encode(text: string, opts?: { add_special_tokens?: boolean }): { ids: number[] } } | null;

export function huggingfaceTokenizerProvider(options: TokenizerProviderOptions): TokenizerProvider {
  const cacheDir = options.cacheDir;
  const modelsDir = options.modelsDir;
  const allowFetch = options.allowFetch === true;
  const fetchTimeoutMs = options.fetchTimeoutMs ?? 8000;
  const memo = new Map<string, LoadedTokenizer>();

  /** Resolve a tokenizer.json path for the repo, or null. Cache writes happen
   * on local-source and fetch hits so repeat resolutions skip the network. */
  async function resolveJsonPath(repoKey: string): Promise<string | null> {
    const cacheFile = cacheFileFor(cacheDir, repoKey);
    if (existsSync(cacheFile)) return cacheFile;

    const segs = repoKey.split("/");
    if (modelsDir && segs.length === 2) {
      const local = join(modelsDir, ...segs, "tokenizer.json");
      if (existsSync(local)) {
        try {
          mkdirSync(cacheDir, { recursive: true });
          copyFileSync(local, cacheFile);
          return cacheFile;
        } catch {
          return local;
        }
      }
    }

    if (!allowFetch) return null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
      let res: Response;
      try {
        res = await fetch(`https://huggingface.co/${segs.join("/")}/resolve/main/tokenizer.json`, {
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) return null;
      const text = await res.text();
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cacheFile, text);
      return cacheFile;
    } catch {
      return null;
    }
  }

  async function loadFor(repoKey: string): Promise<LoadedTokenizer> {
    if (memo.has(repoKey)) return memo.get(repoKey)!;
    let tokenizer: LoadedTokenizer = null;
    try {
      const jsonPath = await resolveJsonPath(repoKey);
      if (jsonPath) {
        const { Tokenizer } = await import("@huggingface/tokenizers");
        const json = JSON.parse(readFileSync(jsonPath, "utf8"));
        // Counting needs only the tokenizer.json model graph; an absent
        // tokenizer_config.json is tolerated (empty config).
        tokenizer = new Tokenizer(json, {}) as unknown as LoadedTokenizer;
      }
    } catch {
      tokenizer = null;
    }
    memo.set(repoKey, tokenizer);
    return tokenizer;
  }

  return {
    id: "hf-tokenizers",
    async count(text: string, opts: TokenizeOptions): Promise<number | null> {
      const repoKey = toRepoKey(opts);
      if (!repoKey) return null;
      try {
        const tokenizer = await loadFor(repoKey);
        if (!tokenizer) return null;
        const encoded = tokenizer.encode(text, { add_special_tokens: false });
        return encoded.ids.length;
      } catch {
        return null;
      }
    },
  };
}
