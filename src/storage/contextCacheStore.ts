/**
 * The compaction machinery caches (btw-spec-v2 §2/§3) — the *incremental*
 * half of `/nanites-btw` that survives a chat reset. `context_cache` tracks how
 * much of the host session has already been diffed (message hashes +
 * `cached_through_index`), so a new invocation rebuilds only the new tail.
 * `context_summary_cache` holds the accumulated compact profile + the chunk
 * provenance that maps it back to source message ranges. Neither is touched by
 * a new `start_btw_chat`; only `/api/settings/wipe` clears them.
 */
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "./db.js";

/** One summarizer-produced chunk's mapping back to the source transcript. */
export interface ChunkProvenance {
  chunk_id: string;
  msg_start: number;
  msg_end: number;
  /** Row id in the chunk-embedding index when that chunk was embedded. */
  embedding_row_id: number | null;
}

export interface ContextDiffState {
  message_hashes: string[];
  message_count: number;
  cached_through_index: number;
  updated_at: string;
}

export interface ContextSummaryState {
  summary: string;
  summary_tokens: number;
  times_diffed_since_reduce: number;
  chunk_provenance: ChunkProvenance[] | null;
  updated_at: string;
}

interface ContextCacheRow {
  profile_name: string;
  message_hashes: string;
  message_count: number;
  cached_through_index: number;
  updated_at: string;
}

interface ContextSummaryRow {
  profile_name: string;
  summary: string;
  summary_tokens: number;
  times_diffed_since_reduce: number;
  chunk_provenance: string | null;
  updated_at: string;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class ContextCacheStore {
  constructor(private readonly db: DatabaseSync) {}

  // ---- diff state (context_cache) ----

  getDiffState(profileName: string): ContextDiffState | null {
    const row = this.db.prepare("SELECT * FROM context_cache WHERE profile_name = ?").get(profileName) as ContextCacheRow | undefined;
    if (!row) return null;
    return {
      message_hashes: parseJson<string[]>(row.message_hashes, []),
      message_count: row.message_count,
      cached_through_index: row.cached_through_index,
      updated_at: row.updated_at,
    };
  }

  setDiffState(
    profileName: string,
    state: { message_hashes: string[]; message_count: number; cached_through_index: number },
    updated_at: string = nowIso(),
  ): void {
    this.db
      .prepare(
        `INSERT INTO context_cache (profile_name, message_hashes, message_count, cached_through_index, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (profile_name) DO UPDATE SET
           message_hashes = excluded.message_hashes,
           message_count = excluded.message_count,
           cached_through_index = excluded.cached_through_index,
           updated_at = excluded.updated_at`,
      )
      .run(profileName, JSON.stringify(state.message_hashes), state.message_count, state.cached_through_index, updated_at);
  }

  // ---- summary (context_summary_cache) ----

  getSummary(profileName: string): ContextSummaryState | null {
    const row = this.db
      .prepare("SELECT * FROM context_summary_cache WHERE profile_name = ?")
      .get(profileName) as ContextSummaryRow | undefined;
    if (!row) return null;
    return {
      summary: row.summary,
      summary_tokens: row.summary_tokens,
      times_diffed_since_reduce: row.times_diffed_since_reduce,
      chunk_provenance: parseJson<ChunkProvenance[] | null>(row.chunk_provenance, null),
      updated_at: row.updated_at,
    };
  }

  setSummary(
    profileName: string,
    state: {
      summary: string;
      summary_tokens: number;
      times_diffed_since_reduce?: number;
      chunk_provenance?: ChunkProvenance[] | null;
    },
    updated_at: string = nowIso(),
  ): void {
    const existing = this.getSummary(profileName);
    this.db
      .prepare(
        `INSERT INTO context_summary_cache (profile_name, summary, summary_tokens, times_diffed_since_reduce, chunk_provenance, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (profile_name) DO UPDATE SET
           summary = excluded.summary,
           summary_tokens = excluded.summary_tokens,
           times_diffed_since_reduce = excluded.times_diffed_since_reduce,
           chunk_provenance = excluded.chunk_provenance,
           updated_at = excluded.updated_at`,
      )
      .run(
        profileName,
        state.summary,
        state.summary_tokens,
        state.times_diffed_since_reduce ?? existing?.times_diffed_since_reduce ?? 0,
        state.chunk_provenance !== undefined ? JSON.stringify(state.chunk_provenance) : existing?.chunk_provenance === null ? null : JSON.stringify(existing?.chunk_provenance ?? null),
        updated_at,
      );
  }

  deleteAll(profileName: string): number {
    let n = 0;
    n += Number(this.db.prepare("DELETE FROM context_cache WHERE profile_name = ?").run(profileName).changes);
    n += Number(this.db.prepare("DELETE FROM context_summary_cache WHERE profile_name = ?").run(profileName).changes);
    return n;
  }

  deleteBefore(profileName: string, iso: string): number {
    let n = 0;
    n += Number(this.db.prepare("DELETE FROM context_cache WHERE profile_name = ? AND updated_at < ?").run(profileName, iso).changes);
    n += Number(this.db.prepare("DELETE FROM context_summary_cache WHERE profile_name = ? AND updated_at < ?").run(profileName, iso).changes);
    return n;
  }
}
