/**
 * Phase 29 gate (Phase C) — migration v10 creates the jobs table + its
 * (status, created_at) index on a scratch DB, defaults status to 'queued', and
 * leaves the schema at the latest version.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, applyMigrations } from "../../src/storage/migrations.js";

describe("migration v10 — jobs table", () => {
  it("adds the jobs columns, queued default, and status index to a v9 DB", () => {
    const db = new DatabaseSync(":memory:");
    for (const m of MIGRATIONS) {
      if (m.version > 9) break;
      db.exec(m.sql);
    }
    db.exec("PRAGMA user_version = 9");

    applyMigrations(db);

    const cols = db.prepare("PRAGMA table_info(jobs)").all() as unknown as { name: string }[];
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "id",
        "profile_name",
        "kind",
        "status",
        "payload",
        "result",
        "error_code",
        "error_message",
        "created_at",
        "updated_at",
      ]),
    );

    // status defaults to 'queued' on insert.
    const inserted = db
      .prepare(`INSERT INTO jobs (profile_name, kind, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run("t", "sub_agent", "{}", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    const row = db.prepare("SELECT status FROM jobs WHERE id = ?").get(Number(inserted.lastInsertRowid)) as {
      status: string;
    };
    expect(row.status).toBe("queued");

    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'jobs'")
      .all() as unknown as { name: string }[];
    expect(idx.map((i) => i.name)).toContain("idx_jobs_status_created");

    const ver = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(Number(ver.user_version)).toBe(MIGRATIONS.length);
    db.close();
  });
});
