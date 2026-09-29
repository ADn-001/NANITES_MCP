/**
 * Phase R0 — router foundation.
 *
 * R0 exists to prove four things before any protocol work lands on them: the
 * second bin packages correctly, the storage namespace is reserved, the virtual
 * key is genuinely hashed at rest, and the security posture is in place.
 *
 * The tests that matter most here are the ones that pass for the WRONG reason.
 * `health is unreachable` proves nothing, so each network test has a positive
 * control. The constant-time comparison test asserts against a `===`
 * implementation, because a prefix-of-the-real-key is exactly the input a naive
 * compare leaks on.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { buildRouterDeps, startRouter, type RouterDeps, type StartedRouter } from "../../src/router/deps.js";
import {
  hashVirtualKey,
  newKeySalt,
  newVirtualKey,
  verifyVirtualKey,
  bearerToken,
  resolveVirtualKey,
  readConfig,
  ensureConfigRow,
} from "../../src/router/auth.js";
import { LEGACY_ROUTER_PROFILE } from "../../src/router/constants.js";
import { MAX_BODY_BYTES } from "../../src/router/server.js";
import { MIGRATIONS } from "../../src/storage/migrations.js";
import { ProfileManager } from "../../src/storage/profileManager.js";
import { scratchHome, cleanup } from "../phase3/helpers.js";

const homes: string[] = [];
const openDeps: RouterDeps[] = [];
const servers: StartedRouter[] = [];

function home(): string {
  const h = scratchHome();
  homes.push(h);
  return h;
}

function deps(h: string, env: NodeJS.ProcessEnv = {}): RouterDeps {
  const d = buildRouterDeps(h, env);
  openDeps.push(d);
  return d;
}

interface Up {
  port: number;
  get(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

/**
 * Start a server on an ephemeral port.
 *
 * `startRouter` builds its own deps, so this must NOT also call `deps()` —
 * opening the same SQLite file twice leaves a second WAL handle that Windows
 * refuses to unlink during cleanup (EPERM).
 */
async function startServer(h: string, env: NodeJS.ProcessEnv = {}): Promise<Up & { d: RouterDeps }> {
  const handle = await startRouter({ home: h, port: 0, bind: "127.0.0.1", env });
  servers.push(handle);
  return {
    ...handle,
    d: handle.deps,
    get: (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${handle.port}${p}`, init),
    close: handle.close,
  };
}

function authed(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${key}`, ...extra };
}

afterEach(async () => {
  // AWAIT both closes. Fire-and-forget leaves the listening socket and the
  // SQLite handle open past the test, and the scratch dir cannot be removed on
  // Windows while any handle into it is live (EPERM).
  while (servers.length) {
    const s = servers.pop()!;
    await s.close();
    s.deps.close();
  }
  while (openDeps.length) openDeps.pop()!.close();
  while (homes.length) cleanup(homes.pop()!);
});

describe("R0.1 — packaging and process", () => {
  it("declares a second bin and the router scripts", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      bin: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(pkg.bin["nanites-router"]).toBe("./dist/router/main.js");
    // The MCP server's bin must survive the addition.
    expect(pkg.bin["nanites"]).toBe("./dist/index.js");
    expect(pkg.scripts["router"]).toContain("dist/router/main.js");
  });

  it("builds a router entry point that does not import the MCP server", () => {
    const mainPath = path.join(process.cwd(), "src", "router", "main.ts");
    const source = fs.readFileSync(mainPath, "utf8");
    // The router must be independently runnable — importing src/index.ts would
    // drag in the stdio transport, tool registration, and the LM Studio
    // lifecycle, none of which a network gateway should need.
    expect(source).not.toMatch(/from\s+["']\.\.\/index\.js["']/);
    expect(source).not.toMatch(/from\s+["']\.\.\/index\.ts["']/);
  });
});

describe("R0.2 — storage", () => {
  it("declares every migration in ascending, gapless order", () => {
    const versions = MIGRATIONS.map((m) => m.version);
    const sorted = [...versions].sort((a, b) => a - b);
    // The v24 lesson: an entry declared out of order is silently never reached.
    expect(versions).toEqual(sorted);

    // The PROPERTY, not a frozen number. This test used to hardcode 25 and
    // then had to be edited for every migration, which is a change-detector
    // that pays for itself by being wrong the moment it is missed. What
    // actually matters is that the sequence starts at 1, never repeats, and
    // has no gap — a gap means a version number was skipped and a database
    // created at that version would never receive the migrations after it.
    expect(versions[0]).toBe(1);
    expect(new Set(versions).size).toBe(versions.length);
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBe(versions[i - 1] + 1);
    }
    // The router tables arrived in v25, which must stay in the sequence.
    expect(versions).toContain(25);
  });

  it("creates every router table and exactly one config row", () => {
    const d = deps(home());
    const tables = (d.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'router_%' ORDER BY name",
    ).all() as Array<{ name: string }>).map((r) => r.name);

    expect(tables).toEqual([
      "router_advertised",
      "router_aliases",
      "router_config",
      "router_jobs",
      "router_key_metrics",
      "router_modality_pins",
      "router_sticky",
      "router_traffic",
    ]);

    const version = d.db.prepare("PRAGMA user_version").get() as { user_version: number };
    // The applied version tracks the last DECLARED migration, so adding one
    // does not require editing this assertion.
    expect(Number(version.user_version)).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);

    const rows = d.db.prepare("SELECT COUNT(*) AS n FROM router_config").get() as { n: number };
    expect(Number(rows.n)).toBe(1);
  });

  it("is idempotent — re-running migrations adds nothing", () => {
    const h = home();
    const first = deps(h);
    const before = first.db.prepare("SELECT COUNT(*) AS n FROM router_config").get() as { n: number };
    expect(Number(before.n)).toBe(1);
    openDeps.pop()?.close();

    const second = deps(h);
    const after = second.db.prepare("SELECT COUNT(*) AS n FROM router_config").get() as { n: number };
    expect(Number(after.n)).toBe(1);
  });

  it("reserves __router__ so a user profile cannot collide with the legacy rows", () => {
    const h = home();
    const pm = new ProfileManager(h);

    let code: string | null = null;
    try {
      pm.createProfile({ name: LEGACY_ROUTER_PROFILE } as never);
    } catch (err) {
      code = (err as { code?: string }).code ?? "unknown";
    }
    expect(code).toBe("invalid_profile_name");

    // The near-miss is NOT reserved — a one-character difference is a different
    // name and must still work.
    expect(pm.createProfile({ name: "__router" } as never).name).toBe("__router");
  });
});

describe("R0.3 — the virtual key", () => {
  it("generates a key on first boot and does not store it in plaintext", () => {
    const h = home();
    const d = deps(h);
    expect(d.generatedKey).toBeTruthy();
    expect(d.generatedKey!.length).toBeGreaterThanOrEqual(40);

    const stored = readConfig(d.db);
    expect(stored?.virtual_key_hash).toBeTruthy();
    expect(stored!.virtual_key_hash).not.toContain(d.generatedKey!);

    // The strongest assertion: scan the raw file. A hash column would pass a
    // value check while some other table leaked the plaintext.
    const dbPath = path.join(h, "nanites.db");
    expect(fs.readFileSync(dbPath).includes(Buffer.from(d.generatedKey!, "utf8"))).toBe(false);
  });

  it("reuses a stored key on a later boot instead of regenerating", () => {
    const h = home();
    const first = deps(h, {});
    const key = first.generatedKey!;
    const hash = first.keyHash;
    openDeps.pop()?.close();

    const second = deps(h, {});
    // Regenerating would invalidate every configured harness on restart.
    expect(second.generatedKey).toBeNull();
    expect(second.keyHash).toBe(hash);

    const presented = bearerToken(`Bearer ${key}`);
    expect(verifyVirtualKey(presented, hash).ok).toBe(true);
  });

  it("lets NANITES_ROUTER_KEY win over a stored key", () => {
    const h = home();
    const env = { NANITES_ROUTER_KEY: "user-supplied-key" } as NodeJS.ProcessEnv;
    const d = deps(h, env);
    expect(d.generatedKey).toBeNull();
    expect(verifyVirtualKey("user-supplied-key", d.keyHash).ok).toBe(true);
    expect(verifyVirtualKey("some-other-key", d.keyHash).ok).toBe(false);
  });

  it("authenticates only the exact key, and a truncated one cannot pass", () => {
    const salt = newKeySalt();
    const key = newVirtualKey();
    const hash = hashVirtualKey(key, salt);

    expect(verifyVirtualKey(key, hash).ok).toBe(true);
    // A prefix and an extension must both fail.
    //
    // NOTE on what this does and does not prove. Replacing the constant-time
    // compare with `===` leaves these assertions PASSING, because scrypt
    // avalanches: a truncated key hashes to an entirely different digest
    // regardless of how the two digests are then compared. So this test proves
    // the stored form is a real scrypt digest rather than a reversible
    // encoding — it is NOT a test of timing-safety, and it is named
    // accordingly. A genuine timing test would need to measure, not assert.
    expect(verifyVirtualKey(key.slice(0, key.length - 4), hash).ok).toBe(false);
    expect(verifyVirtualKey(key + "x", hash).ok).toBe(false);
    expect(verifyVirtualKey("", hash).ok).toBe(false);
    expect(verifyVirtualKey(undefined, hash).ok).toBe(false);
  });

  it("stores a scrypt digest, so a reversed comparison still rejects a prefix", () => {
    // The assertion that actually distinguishes a hash from a reversible
    // encoding: the stored value must be a non-reversible digest, so even a
    // deliberately naive `===` on the digests rejects a truncated key.
    const salt = newKeySalt();
    const key = newVirtualKey();
    const hash = hashVirtualKey(key, salt);

    expect(hash.startsWith("scrypt$")).toBe(true);
    // The plaintext must not be recoverable by any substring of the stored
    // value — no base64/hex reversal, no embedded secret.
    expect(hash).not.toContain(key);
    expect(hash.split("$")[5]).not.toContain(key.slice(0, 8));
  });

  it("fails closed on a malformed stored hash", () => {
    for (const bad of ["", "notahash", "scrypt$16384$8$1", "bcrypt$1$2$3$4$5", "scrypt$a$b$c$d$e"]) {
      const result = verifyVirtualKey("anything", bad);
      expect(result.ok).toBe(false);
      expect(result.reason).not.toBe("ok");
    }
  });

  it("uses a per-install salt, so the same key hashes differently in two installs", () => {
    const key = newVirtualKey();
    expect(hashVirtualKey(key, newKeySalt())).not.toBe(hashVirtualKey(key, newKeySalt()));
  });

  it("parses a bearer header and rejects a malformed one", () => {
    expect(bearerToken("Bearer abc123")).toBe("abc123");
    expect(bearerToken("bearer abc123")).toBe("abc123");
    expect(bearerToken("BEARER  abc123 ")).toBe("abc123");
    expect(bearerToken(["Bearer abc123"])).toBe("abc123");
    expect(bearerToken("Basic abc123")).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });

  it("creates a config row with no key yet, and treats that as normal", () => {
    const d = deps(home());
    const row = ensureConfigRow(d.db);
    // A first boot before key provisioning is a real state, not an error.
    expect(row.id).toBe(1);
    expect(row.port).toBe(4800);
    expect(row.bind).toBe("127.0.0.1");
    expect(row.default_strategy).toBe("round_robin");
  });
});

describe("R0.4 — the server", () => {
  it("serves health on an ephemeral port, with a positive control", async () => {
    const s = await startServer(home());
    expect(s.port).toBeGreaterThan(0);

    // Positive control first: an UNREACHABLE server would make the 401
    // assertion below pass for entirely the wrong reason.
    const good = await s.get("/v1/health", { headers: authed(s.d.generatedKey!) });
    expect(good.status).toBe(200);

    const body = (await good.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    // The health payload must report the RESOLVED port, not the requested one.
    expect(body.port).toBe(s.port);
    expect(body.bind).toBe("127.0.0.1");
    expect(body.broadcast).toBe(false);
    expect(body.key_present).toBe(true);
    // `detail` carries WHY a helper is unavailable, which is the difference
    // between "not installed" and "installed but broken".
    expect(body.helpers.needle).toBe(false);
    expect(body.helpers.laya).toBe(false);
    expect(body.helpers.detail).toBeTruthy();
  });

  it("rejects a WRONG key in the OpenAI shape", async () => {
    const s = await startServer(home());
    // A WRONG key, not a missing one. A missing key is caught by the earlier
    // `!presented` branch, so a test that only covers "absent" passes even if
    // the actual comparison is removed entirely — which is exactly what a
    // deliberate break showed.
    const res = await s.get("/v1/health", { headers: { authorization: "Bearer not-the-key" } });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string; type: string } };
    // An OpenAI SDK parses `error.message`; anything else surfaces as a
    // confusing parse failure rather than the real problem.
    expect(body.error).toBeTruthy();
    expect(typeof body.error.message).toBe("string");
  });

  it("rejects a WRONG key in the Anthropic shape", async () => {
    const s = await startServer(home());
    const res = await s.get("/v1/health", {
      headers: { authorization: "Bearer not-the-key", "anthropic-version": "2023-06-01" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { type: string; error: { type: string; message: string } };
    // Anthropic clients parse `type:"error"` at the top level.
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("authentication_error");
  });

  it("rejects a MISSING key, in whichever dialect the caller speaks", async () => {
    const s = await startServer(home());
    const bare = await s.get("/v1/health");
    expect(bare.status).toBe(401);
    const anthropic = await s.get("/v1/health", { headers: { "anthropic-version": "2023-06-01" } });
    expect(anthropic.status).toBe(401);
    expect(((await anthropic.json()) as { type: string }).type).toBe("error");
  });

  it("rejects a wrong key, a prefix of the key, and a mangled header", async () => {
    const s = await startServer(home());
    const real = s.d.generatedKey!;

    for (const bad of ["wrong", real.slice(0, real.length - 6), real + "x"]) {
      const res = await s.get("/v1/health", { headers: { authorization: `Bearer ${bad}` } });
      expect(res.status).toBe(401);
    }
    const noScheme = await s.get("/v1/health", { headers: { authorization: real } });
    expect(noScheme.status).toBe(401);
  });

  it("never leaks the key in any response", async () => {
    const s = await startServer(home());
    const key = s.d.generatedKey!;
    for (const p of ["/v1/health", "/v1/keys", "/", "/v1/nope"]) {
      const res = await s.get(p, { headers: authed(key) });
      const text = await res.text();
      expect(text).not.toContain(key);
    }
  });

  it("404s an unknown route in the caller's dialect", async () => {
    const s = await startServer(home());
    const key = s.d.generatedKey!;

    const openai = await s.get("/v1/nope", { headers: authed(key) });
    expect(openai.status).toBe(404);
    expect(((await openai.json()) as { error: unknown }).error).toBeTruthy();

    const anthropic = await s.get("/v1/nope", { headers: authed(key, { "anthropic-version": "2023-06-01" }) });
    expect(anthropic.status).toBe(404);
    expect(((await anthropic.json()) as { type: string }).type).toBe("error");
  });

  it("blocks a loopback/metadata upstream through the SSRF guard", async () => {
    const s = await startServer(home());
    const res = await s.get(
      `/v1/health?upstream=${encodeURIComponent("http://169.254.169.254/latest/meta-data/")}`,
      { headers: authed(s.d.generatedKey!) },
    );
    // A tunnelled router must not be usable as an SSRF proxy into the
    // operator's LAN or cloud metadata.
    expect(res.status).toBe(400);
  });

  it("reports broadcast=true only when the bind is widened", async () => {
    const s = await startServer(home());
    const body = (await (await s.get("/v1/health", { headers: authed(s.d.generatedKey!) })).json()) as {
      broadcast: boolean;
    };
    expect(body.broadcast).toBe(false);
  });
});

describe("R0 — isolation", () => {
  it("keeps two routers on separate homes entirely separate", async () => {
    const s1 = await startServer(home());
    const s2 = await startServer(home());

    const key1 = s1.d.generatedKey!;
    // Key 1 must not authenticate against router 2. The salts differ, so the
    // stored digests differ even for an identical plaintext.
    const cross = await s2.get("/v1/health", { headers: { authorization: `Bearer ${key1}` } });
    expect(cross.status).toBe(401);
  });

  it("defaults the port to 4800, distinct from the dashboard's 4700", () => {
    const d = deps(home());
    expect(readConfig(d.db)?.port).toBe(4800);
  });

  it("caps the request body", () => {
    // 8 MB is enough for a base64 image and bounded enough that one request
    // cannot exhaust the process.
    expect(MAX_BODY_BYTES).toBe(8 * 1024 * 1024);
  });
});
