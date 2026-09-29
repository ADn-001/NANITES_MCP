/**
 * Async generation jobs.
 *
 * Needed for the genuinely slow tail: SDXL Base measured 69.6s average and
 * 83.4s max, and the LLaVA probe showed a real 23% transient 500 rate
 * (`triton error running inference`) that a retry can recover. A caller that
 * wants a render should not have to hold a socket open through either.
 *
 * Two design points that are load-bearing:
 *
 *  - **Jobs are rows, not memory.** A job in flight when the process dies must
 *    be recoverable, and the repo already has the orphan-recovery pattern from
 *    the download store.
 *  - **Progress is honest.** A percentage is emitted only when the provider
 *    reports one. Cloudflare does not, so what a caller sees is phase
 *    transitions. A fabricated 80% on a 70-second render is worse than no
 *    number, because the user trusts it.
 */
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { nowIso } from "../../storage/db.js";
import { routerProfile } from "../constants.js";
import type { Modality } from "../ir/types.js";

export type JobStatus = "queued" | "running" | "finalizing" | "done" | "failed" | "cancelled";

export interface JobRow {
  job_id: string;
  status: JobStatus;
  source: Modality;
  target: Modality;
  model: string;
  /** 0..1 ONLY when the provider reports progress; otherwise null. */
  progress: number | null;
  /** Always present. The honest fallback when there is no percentage. */
  phase: string;
  artifact_uri: string | null;
  error: { code: string; message: string } | null;
  /** Parsed, not the raw column. */
  request: unknown;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface RawRow {
  job_id: string; status: string; source: string; target: string; model: string;
  progress: number | null; phase: string; artifact_uri: string | null; error: string | null;
  request: string; created_at: string; updated_at: string; completed_at: string | null;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToJob(r: RawRow): JobRow {
  return {
    job_id: r.job_id,
    status: r.status as JobStatus,
    source: r.source as Modality,
    target: r.target as Modality,
    model: r.model,
    progress: r.progress === null ? null : Number(r.progress),
    phase: r.phase,
    artifact_uri: r.artifact_uri,
    error: parseJson<{ code: string; message: string } | null>(r.error, null),
    // Parsed on read. The column holds JSON, and returning the raw string made
    // every consumer cast it — the runner then spread a STRING, which produced
    // "body: expected an object" at dispatch time rather than at read time.
    request: parseJson<unknown>(r.request, {}),
    created_at: r.created_at,
    updated_at: r.updated_at,
    completed_at: r.completed_at,
  };
}

const COLUMNS = "job_id, status, source, target, model, progress, phase, artifact_uri, error, request, created_at, updated_at, completed_at";

export class JobStore {
  constructor(private readonly db: DatabaseSync) {}

  create(args: {
    source: Modality;
    target: Modality;
    model: string;
    request: unknown;
  }): JobRow {
    const jobId = randomUUID();
    const now = nowIso();
    this.db.prepare(
      `INSERT INTO router_jobs (job_id, status, source, target, model, progress, phase, artifact_uri, error, request, created_at, updated_at, completed_at)
       VALUES (?, 'queued', ?, ?, ?, NULL, 'queued', NULL, NULL, ?, ?, ?, NULL)`,
    ).run(jobId, args.source, args.target, args.model, JSON.stringify(args.request), now, now);
    return this.get(jobId)!;
  }

  get(jobId: string): JobRow | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM router_jobs WHERE job_id = ?`).get(jobId) as RawRow | undefined;
    return row ? rowToJob(row) : null;
  }

  list(status?: JobStatus, limit = 50): JobRow[] {
    const rows = (status
      ? this.db.prepare(`SELECT ${COLUMNS} FROM router_jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?`).all(status, limit)
      : this.db.prepare(`SELECT ${COLUMNS} FROM router_jobs ORDER BY created_at DESC LIMIT ?`).all(limit)) as unknown as RawRow[];
    return rows.map(rowToJob);
  }

  /**
   * Advance a job's status and phase.
   *
   * `progress` is only ever set from a provider-reported value. The store does
   * not compute it from elapsed time, because a percentage the user cannot
   * verify is worse than none.
   */
  update(
    jobId: string,
    patch: { status?: JobStatus; phase?: string; progress?: number | null; artifact_uri?: string | null; error?: { code: string; message: string } | null },
  ): void {
    const sets: string[] = ["updated_at = ?"];
    const params: Array<string | number | null> = [nowIso()];
    if (patch.status !== undefined) { sets.push("status = ?"); params.push(patch.status); }
    if (patch.phase !== undefined) { sets.push("phase = ?"); params.push(patch.phase); }
    if (patch.progress !== undefined) { sets.push("progress = ?"); params.push(patch.progress); }
    if (patch.artifact_uri !== undefined) { sets.push("artifact_uri = ?"); params.push(patch.artifact_uri); }
    if (patch.error !== undefined) { sets.push("error = ?"); params.push(patch.error ? JSON.stringify(patch.error) : null); }
    if (patch.status === "done" || patch.status === "failed" || patch.status === "cancelled") {
      sets.push("completed_at = ?");
      params.push(nowIso());
    }
    params.push(jobId);
    this.db.prepare(`UPDATE router_jobs SET ${sets.join(", ")} WHERE job_id = ?`).run(...params);
  }

  cancel(jobId: string): boolean {
    const job = this.get(jobId);
    // A finished job is not cancellable; reporting success here would lie
    // about a result the user already has.
    if (!job || job.status === "done" || job.status === "failed" || job.status === "cancelled") return false;
    this.update(jobId, { status: "cancelled", phase: "cancelled" });
    return true;
  }

  isTerminal(status: JobStatus): boolean {
    return status === "done" || status === "failed" || status === "cancelled";
  }

  /**
   * Fail jobs that were in flight when the process died.
   *
   * A job cannot survive its process — the upstream call is not resumable —
   * so an orphaned one must be failed rather than left `running` forever, which
   * is exactly what a caller watching it would experience as a hang.
   */
  recoverOrphans(): string[] {
    const stuck = this.list("running").concat(this.list("queued"));
    for (const job of stuck) {
      this.update(job.job_id, {
        status: "failed",
        phase: "orphaned",
        error: { code: "job_orphaned", message: "The router restarted while this job was running; its provider call cannot be resumed." },
      });
    }
    return stuck.map((j) => j.job_id);
  }
}
