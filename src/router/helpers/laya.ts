/**
 * Laya adapter — a calibrated decision model over arbitrary state.
 *
 * Invoked as a subprocess, same as Needle: `laya` is a Python package and the
 * router does not embed a Python runtime.
 *
 * The question shape was established by probing the real package (0.3.21), not
 * from its documentation, which describes a looser shape than the code accepts:
 *
 *   Router().predict(state, {
 *     name: { type: "choice", instructions: "...", criteria: {label: desc, ...} }
 *   })
 *   -> { answers: { name: { choice, probabilities, confidence, ... } } }
 *
 * `criteria` is the field name; `options` and a bare dict of labels are both
 * rejected. `instructions` is required. Getting any of these wrong fails at
 * call time with a `ValueError` that does not name the real problem, so the
 * bridge constructs them centrally and they are asserted here.
 *
 * Checkpoint choice matters: the typed-decisions checkpoint scores 0.766 on
 * typed decisions versus 0.362 for the base English one, and this is a
 * classifier, so the base would have made routing decisions worse.
 */
import { spawn } from "node:child_process";
import { UnavailableHelper, type HelperModel } from "./interface.js";

const BRIDGE = `
import json, sys
def ok(d): print(json.dumps({"ok": True, **d}))
def bad(e): print(json.dumps({"ok": False, "error": "%s: %s" % (type(e).__name__, str(e)[:200])}))
try:
    from laya import Router
    op = json.loads(sys.stdin.read())
    if op["op"] == "warm":
        Router()
        ok({"warmed": True})
    else:
        r = Router()
        out = r.predict(op["state"], op["questions"])
        ok({"result": out})
except Exception as e:
    bad(e)
`;

export interface LayaOptions {
  python?: string;
  timeoutMs?: number;
}

export class LayaHelper implements HelperModel {
  readonly name = "laya";
  private readonly python: string;
  private readonly timeoutMs: number;
  private ready: boolean | null = null;
  private reason = "";

  constructor(opts: LayaOptions = {}) {
    this.python = opts.python ?? (process.platform === "win32" ? "python" : "python3");
    // Laya loads a model on first use, which took over a minute on a cold
    // cache. The budget reflects that rather than the 33ms steady-state claim,
    // which is what makes a per-call timeout on it safe.
    this.timeoutMs = opts.timeoutMs ?? 90_000;
  }

  async probe(): Promise<boolean> {
    if (this.ready !== null) return this.ready;
    try {
      const res = await this.invoke({ op: "warm" });
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

  private invoke(payload: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(this.python, ["-c", BRIDGE], { stdio: ["pipe", "pipe", "pipe"] });
      } catch (err) {
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
        return;
      }
      let out = "";
      let errOut = "";
      const timer = setTimeout(() => child.kill(), this.timeoutMs);
      child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
      child.stderr?.on("data", (d: Buffer) => { errOut += d.toString(); });
      child.on("error", (err: Error) => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        const last = out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
        if (last) {
          try {
            resolve(JSON.parse(last) as never);
            return;
          } catch { /* fall through */ }
        }
        resolve({ ok: false, error: errOut.trim().slice(0, 200) || `exited ${code}` });
      });
      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    });
  }

  /**
   * Build the question map the package actually accepts.
   *
   * Exported so the shape is asserted directly rather than only through a live
   * call — a wrong field name here surfaces as a ValueError that does not name
   * the field, which is expensive to debug at request time.
   */
  static choiceQuestion(name: string, instructions: string, options: string[]): Record<string, unknown> {
    const criteria: Record<string, string> = {};
    for (const o of options) criteria[o] = o;
    return { [name]: { type: "choice", instructions, criteria } };
  }

  async classify(state: string, options: string[]): Promise<{ choice: string | null; confidence: number }> {
    if (options.length < 2) return { choice: null, confidence: 0 };
    if (!(await this.probe())) return { choice: null, confidence: 0 };
    const res = await this.invoke({
      op: "predict",
      state,
      questions: LayaHelper.choiceQuestion("kind", "Choose the label that best describes the state.", options),
    });
    if (!res.ok || !res.result) return { choice: null, confidence: 0 };
    return readChoice(res.result, "kind", options);
  }

  async score(state: string, criteria: string[]): Promise<{ score: number | null }> {
    if (!(await this.probe())) return { score: null };
    const res = await this.invoke({
      op: "predict",
      state,
      questions: { quality: { type: "score", instructions: "Score the state against the criteria.", criteria } },
    });
    if (!res.ok || !res.result) return { score: null };
    const answers = (res.result as { answers?: Record<string, { score?: unknown }> }).answers;
    const raw = answers?.["quality"]?.score;
    return { score: typeof raw === "number" ? raw : null };
  }

  async retrieve(): Promise<{ indices: number[] }> {
    // Laya classifies; it does not embed. Retrieval is Needle's job, and
    // pretending otherwise would return an empty list dressed as an answer.
    return { indices: [] };
  }

  async extract(): Promise<null> {
    // Laya emits no text at all — its own card says so — so there is no
    // structured-output path to offer. Declared rather than stubbed so a
    // caller cannot mistake "unavailable" for "returned nothing useful".
    return null;
  }
}

function readChoice(result: unknown, name: string, options: string[]): { choice: string | null; confidence: number } {
  const answers = (result as { answers?: Record<string, Record<string, unknown>> }).answers;
  const a = answers?.[name];
  if (!a) return { choice: null, confidence: 0 };
  const choice = typeof a["choice"] === "string" ? (a["choice"] as string) : null;
  // Only a label we actually offered counts. A model that invents one is
  // treated as having no answer.
  if (choice && !options.includes(choice)) return { choice: null, confidence: 0 };
  const probs = a["probabilities"] as Record<string, number> | undefined;
  const confidence = choice && probs ? Number(probs[choice] ?? 0) : Number(a["confidence"] ?? 0);
  return { choice, confidence: Number.isFinite(confidence) ? confidence : 0 };
}

export function layaOrUnavailable(opts?: LayaOptions): HelperModel {
  const helper = new LayaHelper(opts);
  void helper.probe().catch(() => undefined);
  return helper;
}

export { UnavailableHelper };
