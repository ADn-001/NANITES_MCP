import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, applyMigrations } from "../../src/storage/migrations.js";

describe("migrations v4–v6 — telemetry + performance_score + events", () => {
  it("legacy rows survive; new columns default sensibly", () => {
    const db = new DatabaseSync(":memory:");

    // Simulate a DB already at v3 (pre-telemetry) with legacy rows.
    for (const m of MIGRATIONS) {
      if (m.version > 3) break;
      db.exec(m.sql);
    }
    db.exec("PRAGMA user_version = 3");
    db.prepare(
      `INSERT INTO sub_agent_calls (profile_name, model_id, task, tokens_in, tokens_out, duration_ms, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("t", "m1", "legacy", 10, 20, 100, 0.0, "2026-01-01T00:00:00.000Z");
    db.prepare(
      `INSERT INTO model_registry (profile_name, model_id, roles, scores, best_params, last_tested, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("t", "m1", "[]", "{}", "{}", null, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

    applyMigrations(db);

    const call = db.prepare("SELECT * FROM sub_agent_calls WHERE model_id = 'm1'").get() as Record<string, unknown>;
    expect(call.tokens_in).toBe(10);
    expect(call.tokens_out).toBe(20);
    expect(call.ttft_ms).toBeNull();
    expect(call.load_ms).toBeNull();
    expect(call.error_code).toBeNull();
    expect(call.context_window).toBeNull();

    const reg = db.prepare("SELECT * FROM model_registry WHERE model_id = 'm1'").get() as Record<string, unknown>;
    expect(reg.performance_score).toBe(50);

    // Events table exists and is empty.
    const events = db.prepare("SELECT COUNT(*) AS n FROM sub_agent_events").get() as { n: number };
    expect(Number(events.n)).toBe(0);

    const ver = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(Number(ver.user_version)).toBe(MIGRATIONS.length);

    db.close();
  });
});
