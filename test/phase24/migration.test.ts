import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, applyMigrations } from "../../src/storage/migrations.js";
import { RegistryStore } from "../../src/storage/registryStore.js";

describe("migration v9 — reasoning_type", () => {
  it("legacy registry rows survive and read reasoning_type as 'unknown'", () => {
    const db = new DatabaseSync(":memory:");
    for (const m of MIGRATIONS) {
      if (m.version > 8) break;
      db.exec(m.sql);
    }
    db.exec("PRAGMA user_version = 8");
    db.prepare(
      `INSERT INTO model_registry (profile_name, model_id, roles, scores, best_params, last_tested, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("t", "m1", "[]", "{}", "{}", null, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

    applyMigrations(db);

    const col = db
      .prepare("SELECT reasoning_type FROM model_registry WHERE model_id = 'm1'")
      .get() as { reasoning_type: string | null };
    expect(col.reasoning_type).toBeNull();

    // Read back through the store: null column -> "unknown".
    const store = new RegistryStore(db);
    const entry = store.get("t", "m1");
    expect(entry?.reasoning_type).toBe("unknown");

    const ver = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(Number(ver.user_version)).toBe(MIGRATIONS.length);
    db.close();
  });
});
