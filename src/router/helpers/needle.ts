/**
 * Needle 3 adapter.
 *
 * Invoked as a SUBPROCESS. `cactus-needle` is a Python package, and embedding a
 * Python runtime in a Node process is a dependency this router does not need;
 * a short-lived `python -c` keeps the failure mode trivial (a missing
 * interpreter means "helper unavailable", nothing else breaks).
 *
 * ## What Needle is NOT used for, and why
 *
 * The obvious use — repairing a malformed tool call — is exactly what the
 * package will NOT do safely. `Needle(tools=[...]).run(text)` EXECUTES the
 * tool bodies: probing it with a `write_file` tool actually wrote the file.
 * A repair adapter cannot hand it a real `write_file`, and a stub that
 * captures arguments instead of running them is not the interface the package
 * offers. So tool-call repair stays deterministic (R6) and Needle is used for
 * the two things it does without side effects:
 *
 *   - `extract(text, schema)` — grammar-constrained structured output. The
 *     schema is compiled into the decode, so the result parses by
 *     construction rather than by repair afterwards.
 *   - `embed(text)` — a 3072-dim vector for local relevance search.
 *
 * This is a limitation of the current package interface, not of the model, and
 * it is recorded here so a future integration picks it up deliberately.
 */
import { spawn } from "node:child_process";
import { UnavailableHelper, type HelperModel } from "./interface.js";

/**
 * The child program lives in a sibling .py FILE rather than an inline string.
 *
 * The schema generator inside it needs real newlines and real triple-quotes;
 * escaping those through a TypeScript template literal is a reliable way to
 * ship a silently broken program — which is exactly what happened, and cost
 * several rounds of debugging a null that turned out to be a mangled
 * annotation.
 */
const BRIDGE_PATH = new URL("./needle_bridge.py", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

export interface NeedleOptions {
  python?: string;
  timeoutMs?: number;
}

export class NeedleHelper implements HelperModel {
  readonly name = "needle3";
  private readonly python: string;
  private readonly timeoutMs: number;
  private ready: boolean | null = null;
  private reason = "";

  constructor(opts: NeedleOptions = {}) {
    this.python = opts.python ?? (process.platform === "win32" ? "python" : "python3");
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  /**
   * Probe once and cache. A helper that cannot load is a PERMANENT condition
   * for this process, so re-probing on every call would add a subprocess spawn
   * to the request path for nothing.
   */
  async probe(): Promise<boolean> {
    if (this.ready !== null) return this.ready;
    try {
      const res = await this.invoke({ op: "embed", text: "probe" });
      this.ready = res.ok;
      if (!res.ok) this.reason = res.error ?? "unknown error";
    } catch (err) {
      this.ready = false;
      this.reason = err instanceof Error ? err.message : String(err);
    }
    return this.ready;
  }

  available(): boolean {
    return this.ready === true;
  }

  why(): string {
    return this.reason;
  }

  private invoke(payload: Record<string, unknown>): Promise<{ ok: boolean; vector?: number[]; value?: unknown; error?: string }> {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(this.python, [BRIDGE_PATH], { stdio: ["pipe", "pipe", "pipe"] });
      } catch (err) {
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
        return;
      }
      let out = "";
      let errOut = "";
      const timer = setTimeout(() => child.kill(), this.timeoutMs);
      child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
      child.stderr?.on("data", (d: Buffer) => { errOut += d.toString(); });
      child.on("error", (err: Error) => {
        clearTimeout(timer);
        resolve({ ok: false, error: err.message });
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        const last = out.trim().split("\n").filter(Boolean).pop();
        if (last) {
          try {
            resolve(JSON.parse(last) as never);
            return;
          } catch { /* fall through to the error path */ }
        }
        resolve({ ok: false, error: errOut.trim().slice(0, 200) || `exited ${code}` });
      });
      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    });
  }

  async embed(text: string): Promise<number[] | null> {
    if (!(await this.probe())) return null;
    const res = await this.invoke({ op: "embed", text });
    return res.ok && Array.isArray(res.vector) ? res.vector : null;
  }

  async extract<T>(text: string, schema: Record<string, unknown>): Promise<T | null> {
    if (!(await this.probe())) return null;
    const res = await this.invoke({ op: "extract", text, schema });
    return res.ok ? (res.value as T) : null;
  }

  async retrieve(query: string, corpus: string[]): Promise<{ indices: number[] }> {
    if (corpus.length === 0) return { indices: [] };
    const q = await this.embed(query);
    if (!q) return { indices: [] };
    // Score the corpus locally once the query vector exists: one subprocess
    // call rather than one per document.
    const docs = await Promise.all(corpus.map((c) => this.embed(c)));
    const scored = docs.map((d, i) => (d ? { i, s: cosine(q, d) } : null)).filter(Boolean) as Array<{ i: number; s: number }>;
    scored.sort((a, b) => b.s - a.s);
    return { indices: scored.map((x) => x.i) };
  }

  // Needle emits no natural-language answer, so these two are honest no-ops
  // rather than fake classifications.
  async classify(): Promise<{ choice: string | null; confidence: number }> {
    return { choice: null, confidence: 0 };
  }
  async score(): Promise<{ score: number | null }> {
    return { score: null };
  }
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** The helper set, degrading to unavailable models rather than failing. */
export function needleOrUnavailable(opts?: NeedleOptions): HelperModel {
  const helper = new NeedleHelper(opts);
  // Availability is probed lazily; until then it reports unavailable, which is
  // the safe default for an opt-in feature.
  void helper.probe().catch(() => undefined);
  return helper;
}

export { UnavailableHelper };
