export const MIGRATIONS = [
    {
        version: 1,
        sql: `
      CREATE TABLE model_registry (
        profile_name TEXT NOT NULL,
        model_id     TEXT NOT NULL,
        roles        TEXT NOT NULL DEFAULT '[]',
        scores       TEXT NOT NULL DEFAULT '{}',
        best_params  TEXT NOT NULL DEFAULT '{}',
        last_tested  TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        PRIMARY KEY (profile_name, model_id)
      );

      CREATE TABLE sub_agent_calls (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_name TEXT NOT NULL,
        model_id     TEXT NOT NULL,
        task         TEXT,
        tokens_in    INTEGER NOT NULL DEFAULT 0,
        tokens_out   INTEGER NOT NULL DEFAULT 0,
        duration_ms  INTEGER NOT NULL DEFAULT 0,
        cost_usd     REAL,
        created_at   TEXT NOT NULL
      );

      CREATE TABLE test_results (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_name       TEXT NOT NULL,
        model_id           TEXT NOT NULL,
        unit_id            TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'pending',
        score              REAL,
        raw_output         TEXT,
        orchestrator_notes TEXT,
        user_notes         TEXT,
        user_approved      INTEGER NOT NULL DEFAULT 0,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );
      CREATE INDEX idx_test_results_model ON test_results (profile_name, model_id);
    `,
    },
    {
        version: 2,
        sql: `
      CREATE TABLE test_units (
        profile_name  TEXT NOT NULL,
        unit_id       TEXT NOT NULL,
        unit          TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        PRIMARY KEY (profile_name, unit_id)
      );
    `,
    },
    {
        version: 3,
        sql: `
      CREATE TABLE param_search_attempts (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_name TEXT NOT NULL,
        model_id     TEXT NOT NULL,
        attempt      INTEGER NOT NULL,
        params       TEXT NOT NULL,
        score        REAL NOT NULL,
        detail       TEXT NOT NULL DEFAULT '',
        created_at   TEXT NOT NULL
      );
      CREATE INDEX idx_param_search_model ON param_search_attempts (profile_name, model_id);
    `,
    },
    {
        version: 4,
        sql: `
      ALTER TABLE sub_agent_calls ADD COLUMN ttft_ms INTEGER;
      ALTER TABLE sub_agent_calls ADD COLUMN load_ms INTEGER;
      ALTER TABLE sub_agent_calls ADD COLUMN error_code TEXT;
      ALTER TABLE sub_agent_calls ADD COLUMN context_window INTEGER;
    `,
    },
    {
        version: 5,
        sql: `
      ALTER TABLE model_registry ADD COLUMN performance_score INTEGER NOT NULL DEFAULT 50;
    `,
    },
    {
        version: 6,
        sql: `
      CREATE TABLE sub_agent_events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_name TEXT NOT NULL,
        model_id     TEXT NOT NULL,
        phase        TEXT NOT NULL,
        payload      TEXT NOT NULL DEFAULT '{}',
        created_at   TEXT NOT NULL
      );
      CREATE INDEX idx_sub_agent_events_profile ON sub_agent_events (profile_name, id);
    `,
    },
    {
        version: 7,
        sql: `
      ALTER TABLE sub_agent_calls ADD COLUMN role TEXT;
    `,
    },
    {
        version: 8,
        sql: `
      ALTER TABLE model_registry ADD COLUMN avg_load_ms INTEGER;
      ALTER TABLE model_registry ADD COLUMN avg_response_ms INTEGER;
    `,
    },
    {
        version: 9,
        sql: `
      ALTER TABLE model_registry ADD COLUMN reasoning_type TEXT;
    `,
    },
    {
        version: 10,
        sql: `
      CREATE TABLE jobs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_name  TEXT NOT NULL,
        kind          TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'queued',
        payload       TEXT,
        result        TEXT,
        error_code    TEXT,
        error_message TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX idx_jobs_status_created ON jobs (status, created_at);
    `,
    },
    {
        // Phase E (registry scoring / regimen-state). `test_results` gains a
        // per-candidate + per-run stamp; a partial unique index makes pending rows
        // idempotent per (unit, candidate) so re-runs cannot stack duplicates.
        // `param_search_attempts` gains nullable attribution columns (logged for
        // judged units only at submit time, when the real score exists). The
        // internal `staged` status is a plain TEXT value (variant output held until
        // its baseline sibling is judged). `model_registry.score_minima` records
        // each role's worst approved unit score, feeding the low-confidence floor.
        version: 11,
        sql: `
      ALTER TABLE test_results ADD COLUMN candidate TEXT NOT NULL DEFAULT 'baseline';
      ALTER TABLE test_results ADD COLUMN test_run INTEGER NOT NULL DEFAULT 0;

      -- A pre-v11 DB can hold stacked pending rows for one unit (the D1
      -- duplicate-pending bug this phase fixes). Collapse each unit to its
      -- newest pending row so the unique index below can build; the older
      -- pending outputs are superseded and disposable. Non-pending rows are
      -- never touched.
      DELETE FROM test_results
        WHERE status = 'pending'
          AND id NOT IN (
            SELECT MAX(id) FROM test_results WHERE status = 'pending' GROUP BY profile_name, model_id, unit_id
          );

      CREATE UNIQUE INDEX idx_test_results_pending ON test_results (profile_name, model_id, unit_id, candidate) WHERE status = 'pending';

      ALTER TABLE param_search_attempts ADD COLUMN unit_id TEXT;
      ALTER TABLE param_search_attempts ADD COLUMN candidate TEXT;

      ALTER TABLE model_registry ADD COLUMN score_minima TEXT NOT NULL DEFAULT '{}';
    `,
    },
    {
        // Phase H (`/nanites-btw`, btw-spec-v2 §3). The compaction-machinery caches
        // keyed by profile alone (no session ids — one active chat per profile), the
        // throwaway chat transcript + held-instance row, and `btw_chunks`: the
        // per-chunk summary corpus the retrieval path searches. The spec's
        // `chunk_embeddings` vec0 virtual table is NOT created here — it needs the
        // sqlite-vec extension loaded AND a fixed embedding dimension (model-
        // dependent), so a plain static migration cannot build it. The
        // `chunkEmbeddingsStore` guards it instead: vec0 is created only when
        // sqlite-vec loads at runtime and a dimension is confirmed; otherwise the
        // store reports unavailable and retrieval uses keyword overlap over
        // `btw_chunks` (GATELOG Phase H records the environmental answer).
        version: 12,
        sql: `
      CREATE TABLE context_cache (
        profile_name         TEXT PRIMARY KEY,
        message_hashes       TEXT NOT NULL,
        message_count        INTEGER NOT NULL,
        cached_through_index INTEGER NOT NULL,
        updated_at           TEXT NOT NULL
      );

      CREATE TABLE context_summary_cache (
        profile_name              TEXT PRIMARY KEY,
        summary                   TEXT NOT NULL,
        summary_tokens            INTEGER NOT NULL,
        times_diffed_since_reduce INTEGER NOT NULL DEFAULT 0,
        chunk_provenance          TEXT,
        updated_at                TEXT NOT NULL
      );

      CREATE TABLE btw_chat (
        profile_name     TEXT PRIMARY KEY,
        status           TEXT NOT NULL,
        job_id           TEXT,
        model_id         TEXT,
        instance_id      TEXT,
        last_activity_at TEXT NOT NULL,
        created_at       TEXT NOT NULL
      );

      CREATE TABLE btw_chat_messages (
        profile_name TEXT NOT NULL,
        turn_index   INTEGER NOT NULL,
        role         TEXT NOT NULL,
        content      TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (profile_name, turn_index)
      );

      CREATE TABLE btw_chunks (
        profile_name   TEXT NOT NULL,
        chunk_id       TEXT NOT NULL,
        summary        TEXT NOT NULL,
        msg_start      INTEGER,
        msg_end        INTEGER,
        created_at     TEXT NOT NULL,
        PRIMARY KEY (profile_name, chunk_id)
      );
    `,
    },
    {
        // Phase 1 — Online Providers. Per-profile API keys, cached model lists,
        // cloud call + error logs, sticky model winners, and round-robin key state.
        version: 13,
        sql: `
      CREATE TABLE provider_api_keys (
        profile_name        TEXT NOT NULL,
        provider           TEXT NOT NULL,
        key_id             TEXT NOT NULL,
        api_key            TEXT NOT NULL,
        account_id         TEXT,
        gateway_url        TEXT,
        is_enabled         INTEGER NOT NULL DEFAULT 1,
        is_exhausted       INTEGER NOT NULL DEFAULT 0,
        exhausted_until    TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        created_at        TEXT NOT NULL,
        PRIMARY KEY (profile_name, provider, key_id)
      );

      CREATE TABLE provider_models (
        profile_name        TEXT NOT NULL,
        provider           TEXT NOT NULL,
        model_id           TEXT NOT NULL,
        name               TEXT NOT NULL,
        owned_by           TEXT,
        context_window     INTEGER,
        max_output_tokens  INTEGER,
        pricing_prompt     REAL,
        pricing_completion REAL,
        capabilities       TEXT NOT NULL DEFAULT '{}',
        supported_modalities TEXT NOT NULL DEFAULT '["text"]',
        is_registered      INTEGER NOT NULL DEFAULT 0,
        performance_score  INTEGER,
        last_refreshed     TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        PRIMARY KEY (profile_name, provider, model_id)
      );

      CREATE TABLE provider_sub_agent_calls (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_name        TEXT NOT NULL,
        call_uid            TEXT NOT NULL,
        provider           TEXT NOT NULL,
        model_id           TEXT NOT NULL,
        provider_request_id TEXT,
        task               TEXT,
        role               TEXT,
        tokens_in           INTEGER NOT NULL DEFAULT 0,
        tokens_out          INTEGER NOT NULL DEFAULT 0,
        duration_ms         INTEGER NOT NULL DEFAULT 0,
        cost_usd            REAL,
        ttft_ms             INTEGER,
        performance_score   INTEGER,
        status              TEXT NOT NULL DEFAULT 'success',
        created_at         TEXT NOT NULL
      );

      CREATE TABLE provider_errors (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_name        TEXT NOT NULL,
        call_uid            TEXT NOT NULL,
        provider           TEXT NOT NULL,
        model_id           TEXT,
        error_code         TEXT NOT NULL,
        error_message      TEXT NOT NULL,
        http_status        INTEGER,
        provider_error_code TEXT,
        retryable          INTEGER NOT NULL DEFAULT 0,
        retry_count         INTEGER NOT NULL DEFAULT 0,
        created_at         TEXT NOT NULL
      );

      CREATE TABLE provider_sticky_models (
        profile_name        TEXT NOT NULL,
        provider           TEXT NOT NULL,
        model_id           TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        PRIMARY KEY (profile_name, provider)
      );

      CREATE TABLE provider_key_state (
        profile_name        TEXT NOT NULL,
        provider           TEXT NOT NULL,
        last_key_index     INTEGER NOT NULL DEFAULT 0,
        exhausted_keys     TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (profile_name, provider)
      );

      CREATE INDEX idx_provider_errors_created ON provider_errors (created_at);

      CREATE TABLE provider_cleanup_meta (
        profile_name TEXT NOT NULL,
        key         TEXT NOT NULL,
        value       TEXT NOT NULL,
        PRIMARY KEY (profile_name, key)
      );
    `,
    },
    {
        // Phase 38 (plugin conversion) — pre-existing provider_models tables lack
        // the performance_score column that the schema now references. The fresh
        // CREATE in v13 carries it, but a v13 DB that was created by the earlier
        // online-providers PR (before the column was wired through) needs an ALTER
        // to add it. SQLite has no IF NOT EXISTS for ADD COLUMN, so the migration
        // tries the ALTER and swallows the duplicate-column error.
        version: 14,
        sql: `
      /* performance_score on provider_models */
      /* (handled in the per-DB guard below since SQLite has no ADD COLUMN IF NOT EXISTS) */
    `,
        needsImperative: true,
    },
    {
        // Phase P1 — Key and model nicknames (frontend-persisted display names).
        version: 15,
        sql: `
      ALTER TABLE provider_api_keys ADD COLUMN nickname TEXT;
    `,
        needsImperative: true,
    },
    {
        // Phase P1 — Model nicknames.
        version: 16,
        sql: `
      ALTER TABLE provider_models ADD COLUMN nickname TEXT;
    `,
        needsImperative: true,
    },
    {
        // Data layer. `model_registry.provider` tags which namespace a
        // registry row lives in: NULL = local LM Studio key, else a cloud provider
        // kind. Nullable so legacy/local rows stay untouched and the PK stays
        // (profile_name, model_id) — cloud model ids are provider-prefixed
        // (`@cf/...`, `openai/...`), so cross-namespace collisions are not realistic.
        // `role_pins` stores the preferred model per open-ended role (D1-D4): a role
        // is pinned to one `{provider, model_id}`; provider `local` = LM Studio key.
        version: 17,
        sql: `
      /* provider column added idempotently in applyMigrations (ADD COLUMN has no IF NOT EXISTS) */

      CREATE TABLE role_pins (
        profile_name TEXT NOT NULL,
        role         TEXT NOT NULL,
        provider     TEXT NOT NULL,
        model_id     TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        PRIMARY KEY (profile_name, role)
      );
    `,
        needsImperative: true,
    },
    {
        // Cloud regimen. `test_results.provider` records which namespace a
        // tested model lives in (NULL = local LM Studio key, else a cloud kind). It
        // is stamped on cloud regimen inserts so a later finalize — reached from the
        // unchanged submit_test_judgment path, which carries no provider — can still
        // write a provider-tagged registry entry for a judged cloud model.
        version: 18,
        sql: `/* provider column added idempotently in applyMigrations */`,
        needsImperative: true,
    },
    {
        // Cloud cost and observability. Ledger and cost reads filter these tables by
        // profile and time window; without an index every read is a full scan that
        // grows with every logged call. Applied in applyMigrations behind a
        // table-existence check — see the version === 19 branch.
        version: 19,
        sql: `/* indexes created idempotently in applyMigrations */`,
        needsImperative: true,
    },
    {
        // The cloud path logged token counts but not WHY a
        // response ended, which is the one field that distinguishes the two ways a
        // CF run fails to answer: `length` (the budget ran out mid-thought, so the
        // content field is empty) versus `stop` (the model simply chose not to call
        // a tool). Without it a truncated run and a lazy run look identical in the
        // ledger. Added idempotently in applyMigrations.
        version: 20,
        sql: `/* finish_reason column added idempotently in applyMigrations */`,
        needsImperative: true,
    },
    {
        // Pin hygiene. A pin whose model cannot call tools is rerouted
        // by the capability gate on every tool-bearing run — correct, wasteful, and
        // until now visible only as a `note` on that one run's output. These two
        // columns record the last observed reroute on the pin itself, so the pin
        // listing can say so on read. History, not current state: whether the pin is
        // rerouted *now* is recomputed from live capabilities. Added idempotently in
        // applyMigrations.
        version: 21,
        sql: `/* last_mismatch_at / last_mismatch_reason added idempotently in applyMigrations */`,
        needsImperative: true,
    },
    {
        // Concurrency and lifecycle. A job left `running` by a dead process was invisible to
        // the runner, which only ever claims `queued` — so it stayed a zombie
        // forever, and on a sequential profile the wedged slot blocked every later
        // job. These columns let a boot sweep tell "running under a live process"
        // from "orphaned by a dead one": the owner id is per-process and the
        // heartbeat is refreshed while a run is in flight. Added idempotently in
        // applyMigrations.
        version: 22,
        sql: `/* owner_id / heartbeat_at added idempotently in applyMigrations */`,
        needsImperative: true,
    },
    {
        // sub_agent_calls had NO index at all. recentForModel(profile, model, 20)
        // runs on EVERY run_sub_agent to recompute performance_score, and it
        // filtered by profile + model, so the cost of a sub-agent call scaled with
        // total history rather than with the 20 rows it wanted. list() filters by
        // profile with an optional created_at bound. IF NOT EXISTS so a re-run is
        // a no-op.
        version: 23,
        sql: "", // created idempotently in applyMigrations (see migration 23)
        needsImperative: true,
    },
];
export function applyMigrations(db) {
    const row = db.prepare("PRAGMA user_version").get();
    const current = Number(row?.user_version ?? 0);
    for (const migration of MIGRATIONS) {
        if (migration.version <= current)
            continue;
        db.exec("BEGIN");
        try {
            if (migration.version === 23) {
                // Idempotent, and tolerant of a legacy DB that predates the table:
                // the phase41 harness builds a v16 schema, where a bare CREATE INDEX
                // would throw on a missing table.
                const hasCalls = db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name = ?")
                    .get("table", "sub_agent_calls") !== undefined;
                if (hasCalls) {
                    db.exec("CREATE INDEX IF NOT EXISTS idx_calls_profile_model ON sub_agent_calls (profile_name, model_id, id DESC)");
                    db.exec("CREATE INDEX IF NOT EXISTS idx_calls_profile_time ON sub_agent_calls (profile_name, created_at)");
                }
            }
            else if (migration.version === 14) {
                // Idempotent: add performance_score to provider_models if missing.
                const cols = db.prepare("PRAGMA table_info(provider_models)").all();
                if (!cols.some((c) => c.name === "performance_score")) {
                    db.exec("ALTER TABLE provider_models ADD COLUMN performance_score INTEGER");
                }
            }
            else if (migration.version === 15) {
                // Idempotent: add nickname to provider_api_keys if missing.
                const cols = db.prepare("PRAGMA table_info(provider_api_keys)").all();
                if (!cols.some((c) => c.name === "nickname")) {
                    db.exec("ALTER TABLE provider_api_keys ADD COLUMN nickname TEXT");
                }
            }
            else if (migration.version === 16) {
                // Idempotent: add nickname to provider_models if missing.
                const cols = db.prepare("PRAGMA table_info(provider_models)").all();
                if (!cols.some((c) => c.name === "nickname")) {
                    db.exec("ALTER TABLE provider_models ADD COLUMN nickname TEXT");
                }
            }
            else if (migration.version === 17) {
                // Idempotent: add the nullable provider column to model_registry if missing.
                const cols = db.prepare("PRAGMA table_info(model_registry)").all();
                if (!cols.some((c) => c.name === "provider")) {
                    db.exec("ALTER TABLE model_registry ADD COLUMN provider TEXT");
                }
                db.exec(migration.sql);
            }
            else if (migration.version === 18) {
                // Idempotent: add the nullable provider column to test_results if missing.
                const cols = db.prepare("PRAGMA table_info(test_results)").all();
                if (!cols.some((c) => c.name === "provider")) {
                    db.exec("ALTER TABLE test_results ADD COLUMN provider TEXT");
                }
            }
            else if (migration.version === 19) {
                // Index-only migration. A legacy DB fixture may carry a partial schema,
                // and CREATE INDEX has no "if the table exists" form, so check first
                // rather than failing the whole migration run on a missing table.
                const tableExists = (name) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
                const stmts = [];
                if (tableExists("provider_sub_agent_calls")) {
                    stmts.push(`CREATE INDEX IF NOT EXISTS idx_provider_calls_profile_time
               ON provider_sub_agent_calls (profile_name, created_at DESC)`, `CREATE INDEX IF NOT EXISTS idx_provider_calls_model
               ON provider_sub_agent_calls (profile_name, provider, model_id)`);
                }
                if (tableExists("provider_errors")) {
                    stmts.push(`CREATE INDEX IF NOT EXISTS idx_provider_errors_profile_time
               ON provider_errors (profile_name, created_at DESC)`);
                }
                for (const sql of stmts)
                    db.exec(sql);
            }
            else if (migration.version === 20) {
                // Idempotent, and skipped entirely on a legacy fixture that predates the
                // provider tables — a missing table must not fail the whole run (the
                // same guard migration 19 uses for its indexes).
                const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
                    .get("provider_sub_agent_calls") !== undefined;
                if (exists) {
                    const cols = db.prepare("PRAGMA table_info(provider_sub_agent_calls)").all();
                    if (!cols.some((c) => c.name === "finish_reason")) {
                        db.exec("ALTER TABLE provider_sub_agent_calls ADD COLUMN finish_reason TEXT");
                    }
                }
            }
            else if (migration.version === 21) {
                // Idempotent, and skipped on a legacy fixture that predates the table
                // (migration 19/20 guard).
                const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
                    .get("role_pins") !== undefined;
                if (exists) {
                    const cols = db.prepare("PRAGMA table_info(role_pins)").all();
                    if (!cols.some((c) => c.name === "last_mismatch_at")) {
                        db.exec("ALTER TABLE role_pins ADD COLUMN last_mismatch_at TEXT");
                    }
                    if (!cols.some((c) => c.name === "last_mismatch_reason")) {
                        db.exec("ALTER TABLE role_pins ADD COLUMN last_mismatch_reason TEXT");
                    }
                }
            }
            else if (migration.version === 22) {
                // Idempotent, and skipped on a legacy fixture that predates the table
                // (the migration 19/20/21 guard).
                const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
                    .get("jobs") !== undefined;
                if (exists) {
                    const cols = db.prepare("PRAGMA table_info(jobs)").all();
                    if (!cols.some((c) => c.name === "owner_id")) {
                        db.exec("ALTER TABLE jobs ADD COLUMN owner_id TEXT");
                    }
                    if (!cols.some((c) => c.name === "heartbeat_at")) {
                        db.exec("ALTER TABLE jobs ADD COLUMN heartbeat_at TEXT");
                    }
                    db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_status_heartbeat ON jobs (status, heartbeat_at)");
                }
            }
            else {
                db.exec(migration.sql);
                if (migration.needsImperative) {
                    throw new Error(`Migration ${migration.version} is flagged needsImperative but fell through to its sql body. ` +
                        `Add an imperative branch, or clear the flag if the sql is now sufficient.`);
                }
            }
            db.exec(`PRAGMA user_version = ${migration.version}`);
            db.exec("COMMIT");
        }
        catch (err) {
            db.exec("ROLLBACK");
            throw err;
        }
    }
}
