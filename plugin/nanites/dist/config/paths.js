import os from "node:os";
import path from "node:path";
import fs from "node:fs";
/**
 * All storage lives under NANITES_HOME (default: ~/.nanites).
 *
 * The env var override exists for testability and is read at every call so
 * a test can point the server at a scratch directory without restarting.
 */
export const NANITES_HOME_ENV = "NANITES_HOME";
export function resolveNanitesHome(env = process.env) {
    const explicit = env[NANITES_HOME_ENV];
    if (explicit && explicit.trim().length > 0) {
        return path.resolve(explicit);
    }
    return path.join(os.homedir(), ".nanites");
}
export function nanitesLayout(home) {
    const root = home ?? resolveNanitesHome();
    return {
        home: root,
        profilesDir: path.join(root, "profiles"),
        dbPath: path.join(root, "nanites.db"),
        logsDir: path.join(root, "logs"),
    };
}
/** Create the directory structure. Idempotent. */
export function ensureNanitesHome(home) {
    const layout = nanitesLayout(home);
    // 0700: this home holds nanites.db, which stores provider API keys in
    // plaintext, plus the profile files carrying the LM Studio token. Without an
    // explicit mode the directories inherit the umask, which on a shared host
    // is typically world-readable.
    fs.mkdirSync(layout.profilesDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(layout.logsDir, { recursive: true, mode: 0o700 });
    // The home itself may have been created by an older run, so tighten it too.
    try {
        fs.chmodSync(layout.home, 0o700);
    }
    catch {
        // A foreign or read-only home: the mode is best-effort, not worth failing.
    }
    return layout;
}
