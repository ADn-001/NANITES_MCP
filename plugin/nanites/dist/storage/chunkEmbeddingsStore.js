import { nowIso } from "./db.js";
export class ChunkEmbeddingsStore {
    db;
    /** Confirmed embedding dimension once the vec0 table is built; null until then. */
    dim = null;
    ext = null;
    constructor(db) {
        this.db = db;
    }
    // ---- plain corpus (always available; keyword fallback + provenance) ----
    replaceChunks(profileName, chunks) {
        const del = this.db.prepare("DELETE FROM btw_chunks WHERE profile_name = ?");
        const ins = this.db.prepare("INSERT INTO btw_chunks (profile_name, chunk_id, summary, msg_start, msg_end, created_at) VALUES (?, ?, ?, ?, ?, ?)");
        this.db.exec("BEGIN");
        try {
            del.run(profileName);
            for (const c of chunks) {
                ins.run(profileName, c.chunk_id, c.summary, c.msg_start ?? null, c.msg_end ?? null, c.created_at ?? nowIso());
            }
            this.db.exec("COMMIT");
        }
        catch (err) {
            this.db.exec("ROLLBACK");
            throw err;
        }
    }
    listChunks(profileName) {
        const rows = this.db
            .prepare("SELECT * FROM btw_chunks WHERE profile_name = ? ORDER BY msg_start")
            .all(profileName);
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
    async init(dim) {
        if (this.ext)
            return this.dim === dim;
        try {
            // Non-literal specifier: sqlite-vec is an optional dependency (absent in
            // this environment), so a static import string would fail type resolution.
            const spec = "sqlite-vec";
            const mod = (await import(spec));
            if (typeof mod.load !== "function")
                return false;
            mod.load(this.db);
            this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunk_embeddings USING vec0(
          profile_name TEXT,
          chunk_id TEXT,
          embedding FLOAT[${Math.floor(dim)}]
        )`);
            this.ext = mod;
            this.dim = Math.floor(dim);
            return true;
        }
        catch {
            return false;
        }
    }
    /** True only when the vec0 layer is live (extension + confirmed dim). */
    available() {
        return this.ext !== null && this.dim !== null;
    }
    deleteAll(profileName) {
        let n = Number(this.db.prepare("DELETE FROM btw_chunks WHERE profile_name = ?").run(profileName).changes);
        if (this.available()) {
            n += Number(this.db.prepare("DELETE FROM chunk_embeddings WHERE profile_name = ?").run(profileName).changes);
        }
        return n;
    }
    deleteBefore(profileName, iso) {
        return Number(this.db.prepare("DELETE FROM btw_chunks WHERE profile_name = ? AND created_at < ?").run(profileName, iso).changes);
    }
}
