/**
 * Job execution: dispatch, retry a transient failure, and report phase.
 *
 * The retry policy is the interesting part, and it came out of a probe rather
 * than a guess. LLaVA on Workers AI failed 23% of 48 sequential runs with
 * `HTTP 500 triton error running inference` — a transient inference fault —
 * and the same request shape succeeded on retry. So a 5xx from a generation
 * model is retried.
 *
 * What is NOT retried:
 *  - A shape rejection (400 / router_invalid_request). The body is wrong for
 *    this model; the same body fails identically every time.
 *  - Auth and quota. Those are key-scoped and belong to failover, not retry.
 */
import type { DatabaseSync } from "node:sqlite";
import { NanitesError } from "../../helpers/errors.js";
import { setTimeout as delay } from "node:timers/promises";
import { dispatchCfRun } from "../outbound/cloudflareRun.js";
import { resolveTarget, isRoutable } from "../outbound/resolve.js";
import { resolveHelperAlias } from "../helpers/registry.js";
import { decodeOpenAiRequest } from "../inbound/openai.js";
import { decodeAnthropicRequest } from "../inbound/anthropic.js";
import type { IRRequest } from "../ir/types.js";
import { JobStore } from "./store.js";

/** 5xx is transient for a generation model; 4xx is not. */
const TRANSIENT_CODES = new Set([
  "provider_server_error",
  "provider_gateway_error",
  "provider_timeout",
  "provider_unavailable",
  "provider_network_error",
]);

export interface RunResult {
  artifact: { kind: string; b64: string; mime: string; bytes: number } | null;
  text: string | null;
  attempts: number;
}

export interface RunJobOptions {
  db: DatabaseSync;
  jobId: string;
  /** Injectable so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  signal?: AbortSignal;
}

export async function runJob(opts: RunJobOptions): Promise<RunResult> {
  const store = new JobStore(opts.db);
  const job = store.get(opts.jobId);
  if (!job) {
    throw new NanitesError({ code: "job_not_found", message: `No job ${opts.jobId}.`, retryable: false });
  }

  const stored = job.request as unknown as { body: unknown; dialect: "openai" | "anthropic" };
  const target = resolveTarget(opts.db, job.model);

  // A job exists to run a slow provider generation. A local helper is neither
  // slow nor remote, and `dispatchCfRun` below is Cloudflare-specific, so a
  // helper job is refused explicitly rather than dispatched to a path that
  // cannot serve it. Failing here says why; dispatching would say "no key".
  if (!isRoutable(target)) {
    store.update(job.job_id, {
      status: "failed",
      phase: "failed",
      error: {
        code: "router_invalid_request",
        message: `"${job.model}" is a local helper model, not a provider generation. POST /v1/jobs runs provider models; use POST /v1/helpers/${resolveHelperAlias(target.model_id)?.op ?? ""} for a helper.`,
      },
    });
    throw new NanitesError({
      code: "router_invalid_request",
      message: `Job model "${job.model}" is a local helper, which cannot be run as an async job.`,
      retryable: false,
    });
  }

  // The stored body carries whatever model name the CALLER wrote, which may be
  // a bare id while the job is addressed by the namespaced one. Normalise it
  // so decoding does not depend on how the two were spelled — the model is
  // already resolved above and is what actually gets dispatched.
  const body = (typeof stored.body === "object" && stored.body !== null
    ? { ...(stored.body as Record<string, unknown>), model: target.stored_id }
    : stored.body) as unknown;

  let request: IRRequest;
  try {
    request = stored.dialect === "anthropic" ? decodeAnthropicRequest(body) : decodeOpenAiRequest(body);
  } catch (err) {
    // A stored request that no longer decodes is a job that cannot run, and
    // saying so beats a mysterious provider error.
    const message = err instanceof Error ? err.message : String(err);
    store.update(job.job_id, {
      status: "failed",
      phase: "failed",
      error: { code: "router_invalid_request", message: `Stored request could not be decoded: ${message}` },
    });
    throw err;
  }
  const sleep = opts.sleep ?? ((ms: number) => delay(ms));
  const maxAttempts = opts.maxAttempts ?? 3;

  store.update(job.job_id, { status: "running", phase: "running" });

  let lastError: NanitesError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // A cancelled job stops immediately; there is no point finishing a render
    // whose result nobody will collect.
    if (opts.signal?.aborted || store.get(job.job_id)?.status === "cancelled") {
      store.update(job.job_id, { status: "cancelled", phase: "cancelled" });
      return { artifact: null, text: null, attempts: attempt - 1 };
    }

    try {
      const out = await dispatchCfRun({
        db: opts.db,
        target,
        request,
        signal: opts.signal,
      });
      store.update(job.job_id, { status: "finalizing", phase: "finalizing" });
      // The artifact is stored as a data URI so a job is self-contained: the
      // caller can fetch it with no other lookup.
      const uri = out.artifact
        ? `data:${out.artifact.mime};base64,${out.artifact.b64}`
        : null;
      store.update(job.job_id, { status: "done", phase: "done", artifact_uri: uri });
      return { artifact: out.artifact, text: out.text, attempts: attempt };
    } catch (err) {
      const e = err as NanitesError;
      const code = e.code ?? "unexpected_error";
      if (!TRANSIENT_CODES.has(code) || attempt === maxAttempts) {
        store.update(job.job_id, {
          status: "failed",
          phase: "failed",
          error: { code, message: e.message ?? String(err) },
        });
        throw e;
      }
      // Transient: back off and try again, and say so in the phase so a
      // watcher can see that something happened rather than assuming a hang.
      lastError = e;
      store.update(job.job_id, { phase: `retrying (attempt ${attempt + 1} of ${maxAttempts})` });
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));
    }
  }

  const fallback = lastError ?? new NanitesError({ code: "unexpected_error", message: "Job failed.", retryable: false });
  store.update(job.job_id, {
    status: "failed",
    phase: "failed",
    error: { code: fallback.code, message: fallback.message },
  });
  return { artifact: null, text: null, attempts: maxAttempts };
}
