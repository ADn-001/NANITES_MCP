/**
 * A long-lived helper subprocess, spoken to in JSON lines.
 *
 * The reason this exists: the first helper implementation spawned a fresh
 * `python` per call. Measured on this machine, that is 0.13s of interpreter
 * start PLUS a model load on every single request — for Laya, over a minute on
 * a cold cache. A feature that slow is a feature nobody leaves enabled, so the
 * process is started once and kept.
 *
 * Failure policy, which is the part that matters:
 *
 *  - A worker that has exited is respawned on the next request, not on this
 *    one. A crashed helper must not turn every later call into a respawn.
 *  - A request that TIMES OUT kills and discards the worker. A worker stuck
 *    mid-inference is not reusable, and silently keeping it would make every
 *    subsequent request time out too.
 *  - Every call resolves. There is no path where a worker problem throws out
 *    of the router's request path; the caller gets `{ok: false, ...}` and
 *    applies its own fail-open or fail-closed policy.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface WorkerReply {
  ok: boolean;
  error?: string;
  /** True when the value the model produced was not grounded in the input. */
  ungrounded?: boolean;
  [key: string]: unknown;
}

export interface WorkerOptions {
  /** Resolved path to the worker .py file. */
  script: string;
  python?: string;
  /**
   * Per-request ceiling. Exceeding it discards the worker, because a process
   * stuck inside an inference is not recoverable by asking it nicely.
   */
  timeoutMs?: number;
}

export class HelperWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private queue: Array<{
    resolve: (r: WorkerReply) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private starting: Promise<ChildProcessWithoutNullStreams | null> | null = null;

  readonly name: string;
  private readonly script: string;
  private readonly python: string;
  private readonly timeoutMs: number;

  constructor(opts: WorkerOptions & { name: string }) {
    this.name = opts.name;
    this.script = opts.script;
    this.python = opts.python ?? (process.platform === "win32" ? "python" : "python3");
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  /** True when a process is currently alive. Never starts one. */
  running(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  /**
   * Start the worker if it is not already running.
   *
   * Concurrent callers share ONE start promise. Without that, N simultaneous
   * first requests would each spawn a Python interpreter and load a model,
   * which is precisely the cost this class exists to remove.
   */
  private async ensureStarted(): Promise<ChildProcessWithoutNullStreams | null> {
    if (this.running()) return this.child;
    // A settled-but-dead `starting` promise must not be reused: it resolves to
    // a process that has since exited, so awaiting it would hand back a corpse
    // and the respawn would silently never happen.
    if (this.starting) {
      const existing = await this.starting;
      // `killed` is set synchronously by child.kill(), so it is a reliable
      // signal that this process is on its way out. `exitCode` alone is NOT:
      // it stays null until the exit event lands, so a just-discarded worker
      // passes a null-check and is handed back as if it were alive.
      if (existing && existing.exitCode === null && !existing.killed) {
        return existing;
      }
      // It is going away. Forget the promise so the spawn below replaces it
      // rather than being assigned and then ignored.
      this.starting = null;
    }

    this.starting = (async () => {
      try {
        const child = spawn(this.python, [this.script], {
          stdio: ["pipe", "pipe", "pipe"],
        }) as ChildProcessWithoutNullStreams;
        this.attach(child);
        this.child = child;

        // A spawn error (no interpreter) arrives asynchronously, so the
        // listener is attached before anything is awaited.
        // A DEAD child's events must not fail a LIVE child's request.
        //
        // This is the respawn bug: `discard()` kills process A and clears the
        // slot, the next request spawns process B and queues a reply for it,
        // and then A's `close` arrives and calls failAllPending() — resolving
        // B's pending request with "worker exited". The caller saw a dead
        // worker even though a healthy one was answering. Measured: ping 1 ok,
        // discard, ping 2 -> {ok:false, error:"worker exited"}.
        child.on("error", (err) => {
          if (this.child !== child) return;
          this.failAllPending(err.message);
        });
        child.on("close", () => {
          // Only the process currently occupying the slot may clear it or fail
          // the queue. A superseded child is already forgotten.
          if (this.child !== child) return;
          this.child = null;
          this.failAllPending("worker exited");
        });
        child.stderr?.on("data", () => { /* the worker never writes here */ });

        this.starting = null;
        return child;
      } catch (err) {
        this.starting = null;
        return null;
      }
    })();
    return this.starting;
  }

  private attach(child: ChildProcessWithoutNullStreams): void {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    // One JSON object per line. A partial line stays buffered until its
    // newline arrives, so a reply split across two reads is not mis-parsed.
    let idx = this.buffer.indexOf("\n");
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) {
        const waiter = this.queue.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          try {
            waiter.resolve(JSON.parse(line) as WorkerReply);
          } catch {
            waiter.resolve({ ok: false, error: "unparseable reply from worker" });
          }
        }
      }
      idx = this.buffer.indexOf("\n");
    }
  }

  private failAllPending(reason: string): void {
    while (this.queue.length) {
      const waiter = this.queue.shift()!;
      clearTimeout(waiter.timer);
      waiter.resolve({ ok: false, error: reason });
    }
  }

  /**
   * Send one request and await its reply. NEVER rejects.
   *
   * Requests are serialized over one pipe rather than pipelined: a single
   * model instance is not re-entrant, and an interleaved reply would be
   * attributed to the wrong caller.
   */
  async send(payload: Record<string, unknown>): Promise<WorkerReply> {
    const child = await this.ensureStarted();
    if (!child) {
      return { ok: false, error: `could not start the ${this.name} worker (is python on PATH?)` };
    }

    return new Promise<WorkerReply>((resolve) => {
      const timer = setTimeout(() => {
        // The worker is wedged. Discard it so the NEXT request gets a fresh
        // one instead of inheriting this hang.
        this.discard("timeout");
        resolve({ ok: false, error: `${this.name} worker timed out after ${this.timeoutMs}ms` });
      }, this.timeoutMs);
      timer.unref?.();

      this.queue.push({ resolve, timer });

      try {
        child.stdin.write(JSON.stringify(payload) + "\n");
      } catch (err) {
        clearTimeout(timer);
        const i = this.queue.findIndex((w) => w.resolve === resolve);
        if (i >= 0) this.queue.splice(i, 1);
        this.discard("write failed");
        resolve({ ok: false, error: `could not write to the ${this.name} worker` });
      }
    });
  }

  /** Kill and forget the worker. The next request starts a fresh one. */
  discard(reason: string): void {
    const child = this.child;
    this.child = null;
    // The start promise is dropped here, not left to be discovered stale.
    // Awaiting it afterwards resolved to a process that was already on its
    // way out, so the respawn handed back a corpse and every later call
    // failed against it.
    this.starting = null;
    this.buffer = "";
    if (child) {
      try { child.kill(); } catch { /* already gone */ }
    }
    this.failAllPending(reason);
  }

  /** Stop the worker. Used on shutdown and in tests. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try { child.stdin.write(JSON.stringify({ op: "shutdown" }) + "\n"); } catch { /* gone */ }
    this.child = null;
    this.buffer = "";
    // A short grace period, then SIGKILL, so a wedged worker cannot hold up
    // test teardown or a router restart.
    await new Promise<void>((r) => {
      const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } r(); }, 1500);
      t.unref?.();
      child.once("close", () => { clearTimeout(t); r(); });
    });
    this.failAllPending("stopped");
  }
}

/** Resolve a worker .py next to this module, with Windows drive-letter fixup. */
export function workerPath(file: string): string {
  return new URL(file, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
}
