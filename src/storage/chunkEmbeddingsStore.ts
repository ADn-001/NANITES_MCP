/**
 * Retrieval corpus for `/nanites-btw` (btw-spec-v2 §7/§10) — one store, two
 * layers. The plain `btw_chunks` table holds each map-step chunk's *summary
 * text* (the doc retrieval returns); it always works and is the corpus the
 * keyword-overlap fallback searches. The `chunk_embeddings` vec0 virtual table
 * is the optional vector layer, created only when the sqlite-vec extension
 * loads under `node:sqlite` AND an embedding dimension is confirmed — neither a
 * static migration nor a dimension-less call can build it. When that layer is
 * absent the store reports `available() === false` and retrieval uses keyword
 * overlap; the storage/citation shape (`chunk_id` + provenance) is identical
 * either way (§10).
 */
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "./db.js";

export interface ChunkDoc {
  profile_name: string;
  chunk_id: string;
  /** The summarizer's summary text for the chunk — the retrievable doc. */
  summary: string;
  msg_start: number | null;
  msg_end: number | null;
  created_at: string;
}

interface ChunkDocRow {
  profile_name: string;
  chunk_id: string;
  summary: string;
  msg_start: number | null;
  msg_end: number | null;
  created_at: string;
}

export interface RetrievedChunk {
  chunk_id: string;
  summary: string;
  msg_start: number | null;
  msg_end: number | null;
  /** Rank distance when vector retrieval ran (lower = closer); 0 on keyword. */
  rank: number;
}

type VecLoader = { load(db: unknown): unknown };

export class ChunkEmbeddingsStore {
  /** Confirmed embedding dimension once the vec0 table is built; null until then. */
  private dim: number | null = null;
  private ext: VecLoader | null = null;

  constructor(private readonly db: DatabaseSync) {}

  // ---- plain corpus (always available; keyword fallback + provenance) ----

  replaceChunks(
    profileName: string,
    chunks: Array<{ chunk_id: string; summary: string; msg_start?: number | null; msg_end?: number | null; created_at?: string }>,
  ): void {
    const del = this.db.prepare("DELETE FROM btw_chunks WHERE profile_name = ?");
    const ins = this.db.prepare(
      "INSERT INTO btw_chunks (profile_name, chunk_id, summary, msg_start, msg_end, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.db.exec("BEGIN");
    try {
      del.run(profileName);
      for (const c of chunks) {
        ins.run(profileName, c.chunk_id, c.summary, c.msg_start ?? null, c.msg_end ?? null, c.created_at ?? nowIso());
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  listChunks(profileName: string): ChunkDoc[] {
    const rows = this.db
      .prepare("SELECT * FROM btw_chunks WHERE profile_name = ? ORDER BY msg_start")
      .all(profileName) as unknown as ChunkDocRow[];
    return rows;
  }

  // ---- vector layer (guarded — absent in this environment) ----

  /**
   * Try to load sqlite-vec and build the vec0 table at the confirmed embedding
   * dimension. Async (dynamic import). Returns true only when the extension
   * loaded and the table now exists; callers fall back to keyword overlap on
   * false. Never throws — an unavailable extension is an environmental answer,
   * not an error.
   */
  async init(dim: number): Promise<boolean> {
    if (this.ext) return this.dim === dim;
    try {
      // Non-literal specifier: sqlite-vec is an optional dependency (absent in
      // this environment), so a static import string would fail type resolution.
      const spec = "sqlite-vec";
      const mod = (await import(spec)) as unknown as VecLoader;
      if (typeof mod.load !== "function") return false;
      mod.load(this.db as unknown as Parameters<VecLoader["load"]>[0]);
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS chunk_embeddings USING vec0(
          profile_name TEXT,
          chunk_id TEXT,
          embedding FLOAT[${Math.floor(dim)}]
        )`,
      );
      this.ext = mod;
      this.dim = Math.floor(dim);
      return true;
    } catch {
      return false;
    }
  }

  /** True only when the vec0 layer is live (extension + confirmed dim). */
  available(): boolean {
    return this.ext !== null && this.dim !== null;
  }

  deleteAll(profileName: string): number {
    let n = Number(this.db.prepare("DELETE FROM btw_chunks WHERE profile_name = ?").run(profileName).changes);
    if (this.available()) {
      n += Number(this.db.prepare("DELETE FROM chunk_embeddings WHERE profile_name = ?").run(profileName).changes);
    }
    return n;
  }

  deleteBefore(profileName: string, iso: string): number {
    return Number(
      this.db.prepare("DELETE FROM btw_chunks WHERE profile_name = ? AND created_at < ?").run(profileName, iso).changes,
    );
  }
}
