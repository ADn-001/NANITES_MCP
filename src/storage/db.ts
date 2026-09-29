/**
 * SQLite database bootstrap. Uses the Node 24 built-in `node:sqlite` driver
 * (zero native dependencies, synchronous API). The database file always
 * lives under NANITES_HOME.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { nanitesLayout, ensureNanitesHome } from "../config/paths.js";
import { applyMigrations } from "./migrations.js";

export interface NanitesDb {
  db: DatabaseSync;
  /**
   * The RESOLVED home this handle is attached to.
   *
   * Not the same as the argument: the argument is optional, and the caller
   * usually has no idea whether NANITES_HOME or the default was used. The
   * router needs the real one to resolve the active profile, and a caller
   * guessing wrong reads a DIFFERENT profile's keys -- which looks exactly
   * like "no keys configured".
   */
  home: string;
  close(): void;
}

export function openNanitesDb(home?: string): NanitesDb {
  const layout = nanitesLayout(home);
  ensureNanitesHome(home);
  const db = new DatabaseSync(layout.dbPath);
  // The dashboard is a SEPARATE process reading this same file, so the defaults
  // are wrong for the topology:
  //  - journal_mode WAL lets the reader proceed during a write instead of
  //    blocking it (rollback-journal mode would serialise the two).
  //  - busy_timeout makes a concurrent write WAIT rather than throwing
  //    SQLITE_BUSY immediately, which is the default with no timeout set.
  //  - foreign_keys is a no-op today — the schema declares no FOREIGN KEY and
  //    referential integrity is entirely application-level — but setting it
  //    now means a future migration adding a constraint is enforced
  //.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db, layout.home);
  // 0600: this file holds provider API keys in plaintext.
  // Best-effort — meaningless on Windows, meaningful on a POSIX host.
  try {
    fs.chmodSync(layout.dbPath, 0o600);
  } catch {
    // A pre-existing file with foreign ownership: not worth failing startup.
  }
  return { db, home: layout.home, close: () => db.close() };
}

/** Row timestamp helper — ISO 8601 UTC. */
export function nowIso(): string {
  return new Date().toISOString();
}
