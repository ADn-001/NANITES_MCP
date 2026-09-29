/**
 * Laya adapter — a calibrated decision model over arbitrary state.
 *
 * Backed by a LONG-LIVED worker (laya_worker.py). Cold start is over a minute
 * on a cold cache, so a per-request process would make the feature unusable.
 *
 * ## The question shape
 *
 * Established by probing the real package (0.3.21), not from its documentation,
 * which describes a looser shape than the code accepts:
 *
 *   Router().predict(state, {name: {type, instructions, ...}})
 *     -> {answers: {name: {...}}}
 *
 * `criteria` is the field name for a choice's labels; `options` and a bare dict
 * of labels are both rejected. `instructions` is REQUIRED on every question
 * type — asking a `noul` for `question` raises a ValueError that does not name
 * the field.
 *
 * ## What the eval actually showed
 *
 * Measured on 20 labeled cases per decision type, across three checkpoints:
 *
 *   decision          baseline              Laya best
 *   modality/intent   100% (deterministic)    90%   <- LOSES
 *   prompt injection   0% (does not exist)    70%
 *   cache poisoning    0%                      40%   <- too weak
 *   refusal/hedge      0%                      35%   <- too weak
 *   difficulty tier    0%                      45%   <- too weak
 *
 * The honest summary: Laya is a WEAK zero-shot judge on our data, exactly as
 * its own docs warn — it ships as a checkpoint that wants fine-tuning. It is
 * exposed for a caller who wants the signal, and the router does NOT gate a
 * decision on it.
 *
 * `act_probability` is documented as unusable and MEASURED as 1.0 on every
 * answer, including confident negatives, so `answer_confidence` is the field
 * exposed. The shipped temperatures are invalid (Laya warns at load), so no
 * raw confidence is trusted anywhere.
 */
import { HelperWorker, workerPath } from "./workerClient.js";
import { UnavailableHelper, type HelperModel } from "./interface.js";

export interface LayaOptions {
  python?: string;
  timeoutMs?: number;
}

/** One question, in the shape the package actually accepts. */
export type LayaQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string };

export interface LayaAnswer {
  /** Present on a `choice`. */
  choice?: string;
  probabilities?: Record<string, number>;
  /** Present on a `noul`: the probability of the stated proposition. */
  noul?: number;
  confidence?: number;
  answer_confidence?: number;
  [key: string]: unknown;
}

export class LayaHelper implements HelperModel {
  readonly name = "laya";
  private readonly worker: HelperWorker;
  private ready: boolean | null = null;
  private reason = "";

  constructor(opts: LayaOptions = {}) {
    this.worker = new HelperWorker({
      name: "laya",
      script: workerPath("./laya_worker.py"),
      python: opts.python,
      timeoutMs: opts.timeoutMs ?? 120_000,
    });
  }

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
   * Ask EVERY question in ONE forward pass.
   *
   * Batching is not an optimisation here, it is the difference between a usable
   * pre-flight guard and a feature nobody tolerates: `predict` answers a whole
   * questions dict from a single pass, so asking six questions as six calls
   * would pay the model cost six times for one decision.
   */
  async decide(
    state: string,
    questions: Record<string, LayaQuestion>,
    opts: { model?: string; maxLen?: number } = {},
  ): Promise<Record<string, LayaAnswer> | null> {
    if (!(await this.probe())) return null;
    if (Object.keys(questions).length === 0) return {};
    const res = await this.worker.send({
      op: "predict",
      state,
      questions,
      model: opts.model ?? "typed-decisions",
      max_len: opts.maxLen,
    });
    if (!res.ok || !res["answers"]) return null;
    return res["answers"] as Record<string, LayaAnswer>;
  }

  async classify(state: string, options: string[]): Promise<{ choice: string | null; confidence: number }> {
    // One option is not a decision; answering it would be theatre.
    if (options.length < 2) return { choice: null, confidence: 0 };
    const answers = await this.decide(
      state,
      LayaHelper.choiceQuestion("kind", "Choose the label that best describes the state.", options),
    );
    if (!answers) return { choice: null, confidence: 0 };
    return readChoice(answers["kind"], options);
  }

  async score(state: string, criteria: string[]): Promise<{ score: number | null }> {
    if (criteria.length === 0) return { score: null };
    const answers = await this.decide(state, {
      quality: { type: "score", instructions: "Score the state against the criteria.", criteria },
    });
    const raw = answers?.["quality"]?.["score"];
    return { score: typeof raw === "number" ? raw : null };
  }

  async retrieve(): Promise<{ indices: number[] }> {
    // Laya classifies; it does not embed. Retrieval is Needle's job, and
    // pretending otherwise would return an empty list dressed as an answer.
    return { indices: [] };
  }

  async extract(): Promise<null> {
    // Laya emits no text at all, so there is no structured-output path.
    // Declared rather than stubbed so a caller cannot mistake "unavailable"
    // for "returned nothing useful".
    return null;
  }

  /** Shut the worker down. Called on router close and in tests. */
  async stop(): Promise<void> {
    await this.worker.stop();
    this.ready = null;
  }

  /**
   * Build the question map the package actually accepts.
   *
   * Exported so the shape is asserted directly rather than only through a live
   * call — a wrong field name here surfaces as a ValueError that does not name
   * the field, which is expensive to debug at request time.
   */
  static choiceQuestion(
    name: string,
    instructions: string,
    options: string[],
  ): Record<string, LayaQuestion> {
    const criteria: Record<string, string> = {};
    for (const o of options) criteria[o] = o;
    return { [name]: { type: "choice", instructions, criteria } };
  }
}

function readChoice(
  answer: LayaAnswer | undefined,
  options: string[],
): { choice: string | null; confidence: number } {
  if (!answer) return { choice: null, confidence: 0 };
  const choice = typeof answer["choice"] === "string" ? (answer["choice"] as string) : null;
  // Only a label we actually offered counts. A model that invents one is
  // treated as having no answer.
  if (choice && !options.includes(choice)) return { choice: null, confidence: 0 };
  const probs = answer["probabilities"] as Record<string, number> | undefined;
  const confidence =
    choice && probs ? Number(probs[choice] ?? 0) : Number(answer["answer_confidence"] ?? 0);
  return { choice, confidence: Number.isFinite(confidence) ? confidence : 0 };
}

export function layaOrUnavailable(opts?: LayaOptions): HelperModel {
  const helper = new LayaHelper(opts);
  void helper.probe().catch(() => undefined);
  return helper;
}

export { UnavailableHelper };
