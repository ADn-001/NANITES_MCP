/**
 * Needle 3 adapter.
 *
 * Backed by a LONG-LIVED worker process (needle_worker.py), not a per-call
 * spawn. Measured on this machine: interpreter start is 0.13s but the first
 * `extract` costs ~1.4s, so a per-request process pays a model load every call.
 *
 * ## Which operation is used for what, and why
 *
 * `extract()` is grammar-constrained and returns a VALID shape, but it has NO
 * confidence field (probed: no `confidence`, `score`, or `logprob` attribute) and
 * costs ~1.9s warm. It cannot be gated on.
 *
 * `complete()` returns `{function_calls, confidence}` in ~0.08-0.9s, never
 * executes the tools, and its confidence separates cleanly on real data:
 * 0.25-0.81 for calls it is confident in, 0.06 when it should abstain. So the
 * REPAIR RUNG is built on complete(), gated on that gap.
 *
 * ## What is NOT used, and why
 *
 * `run()` EXECUTES the tool bodies: probed with a `write_file`, the file was
 * written. A repair or shim adapter must never execute anything it
 * reconstructed, so `run()` is unusable here. Repair stays deterministic first
 * (the R6 ladder), and Needle is the rung after it.
 */
import { HelperWorker, workerPath, type WorkerReply } from "./workerClient.js";
import { multiToolSource, schemaSourceFor, type ToolSpec } from "./schemaSource.js";
import { UnavailableHelper, type HelperModel } from "./interface.js";

export interface NeedleOptions {
  python?: string;
  timeoutMs?: number;
}

/** A reconstructed tool call, plus the confidence that produced it. */
export interface NeedleCall {
  name: string;
  arguments: Record<string, unknown>;
  confidence: number;
}

export class NeedleHelper implements HelperModel {
  readonly name = "needle3";
  private readonly worker: HelperWorker;
  private ready: boolean | null = null;
  private reason = "";

  constructor(opts: NeedleOptions = {}) {
    this.worker = new HelperWorker({
      name: "needle",
      script: workerPath("./needle_worker.py"),
      python: opts.python,
      timeoutMs: opts.timeoutMs ?? 120_000,
    });
  }

  /**
   * Probe once and cache. A helper that cannot load is a PERMANENT condition
   * for this process, so re-probing per call would add a subprocess round-trip
   * to the request path for nothing.
   */
  async probe(): Promise<boolean> {
    if (this.ready !== null) return this.ready;
    const res = await this.worker.send({ op: "ping" });
    this.ready = res.ok === true;
    if (!res.ok) this.reason = res.error ?? "unknown error";
    return this.ready;
  }

  available(): boolean {
    return this.ready === true;
  }

  why(): string {
    return this.reason;
  }

  /** True when a worker process is currently alive. For health output. */
  resident(): boolean {
    return this.worker.running();
  }

  /**
   * Reconstruct a tool call from mangled text.
   *
   * SIDE-EFFECT-FREE BY CONSTRUCTION: the generated tool bodies raise, and the
   * worker calls complete(), which returns the call without executing it. That
   * property is what makes the rung safe, and it was verified against a tool
   * that writes a file if run.
   *
   * Returns null when Needle abstains, errors, or is not confident enough, so
   * the caller falls through to whatever it would have done next. A repair rung
   * must never be the last word.
   */
  async reconstruct(
    text: string,
    tool: ToolSpec,
    minConfidence = 0.25,
  ): Promise<NeedleCall | null> {
    if (!(await this.probe())) return null;
    let source: string;
    try {
      source = multiToolSource([tool]);
    } catch {
      // A tool with no usable arguments cannot be reconstructed against.
      return null;
    }

    const res = await this.worker.send({ op: "complete", tool_source: source, query: text });
    if (!res.ok) return null;

    const calls = (res["calls"] as Array<{ name: string; arguments: Record<string, unknown> }>) ?? [];
    if (calls.length === 0) return null; // abstained

    const confidence = Number(res["confidence"] ?? 0);
    const call = calls[0]!;
    if (call.name !== tool.name) return null; // picked a different tool: not a repair
    if (!isPlainObject(call.arguments)) return null;
    if (confidence < minConfidence) return null;

    return { name: call.name, arguments: call.arguments, confidence };
  }

  /** Extract structured fields. No confidence is available on this path. */
  async extractFrom(text: string, schema: Record<string, unknown>): Promise<unknown | null> {
    if (!(await this.probe())) return null;
    let source: string;
    try {
      source = schemaSourceFor("Record", schema);
    } catch {
      return null;
    }
    const res = await this.worker.send({ op: "extract", schema_source: source, text });
    if (!res.ok) return null;
    const v = res["value"];
    return v === undefined ? null : v;
  }

  async extract<T>(text: string, schema: Record<string, unknown>): Promise<T | null> {
    return (await this.extractFrom(text, schema)) as T | null;
  }

  async embed(text: string): Promise<number[] | null> {
    if (!(await this.probe())) return null;
    const res = await this.worker.send({ op: "embed", text });
    if (!res.ok || !Array.isArray(res["vector"])) return null;
    return res["vector"] as number[];
  }

  async retrieve(query: string, corpus: string[]): Promise<{ indices: number[] }> {
    if (corpus.length === 0) return { indices: [] };
    const q = await this.embed(query);
    if (!q) return { indices: [] };
    const docs = await Promise.all(corpus.map((c) => this.embed(c)));
    const scored = docs
      .map((d, i) => (d ? { i, s: cosine(q, d) } : null))
      .filter(Boolean) as Array<{ i: number; s: number }>;
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

  /** Shut the worker down. Called on router close and in tests. */
  async stop(): Promise<void> {
    await this.worker.stop();
    this.ready = null;
  }
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function needleOrUnavailable(opts?: NeedleOptions): HelperModel {
  const helper = new NeedleHelper(opts);
  void helper.probe().catch(() => undefined);
  return helper;
}

export { UnavailableHelper, type WorkerReply };
