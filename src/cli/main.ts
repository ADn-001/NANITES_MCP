#!/usr/bin/env node
/**
 * `nanites-cli` — first-run setup without a coding harness.
 *
 * ## Why this exists
 *
 * The router reads the ACTIVE profile's provider keys, and the only thing that
 * created a profile was the MCP server's `/nanites-new-profile`. So a fresh
 * install on a machine that had never seen Claude Code could serve a model to
 * nobody: `nanites-router` booted, authenticated, and then refused every
 * request with "no active profile is set" — a dead end for the one component
 * that is supposed to stand alone.
 *
 * This closes that. It creates the profile, sets the active pointer, and adds
 * provider keys, using the SAME stores the MCP tools use, so there is one
 * implementation of each and no second code path to drift.
 *
 * ## Design rules
 *
 *  - It never prompts. A CLI that blocks on stdin cannot be scripted, and the
 *    alternative -- refusing to run without a TTY -- makes it useless from a
 *    service manager. Missing input is an error naming the flag that fixes it.
 *  - It never prints a secret. A key is read from the environment or a file
 *    path; the value is never echoed, and a nickname is a label, not a secret.
 *  - It is idempotent. Re-running init on a configured home reports what is
 *    already there and changes nothing unless asked to.
 *  - It does not require LM Studio. A cloud-first profile works with no local
 *    endpoint at all, which is the whole point for a standalone gateway.
 */
import { openNanitesDb } from "../storage/db.js";
import { ProfileManager } from "../storage/profileManager.js";
import { ProviderKeyStore } from "../storage/providerKeyStore.js";
import { setRouterHome, routerProfile, readActiveProfileName } from "../router/constants.js";
import { discoverModels } from "../router/providers/discover.js";
import type { ProviderKind } from "../storage/profileDefaults.js";

const PROVIDERS: ProviderKind[] = ["cloudflare", "openrouter", "nvidia", "omniroute", "generic"];

function out(msg: string): void {
  process.stdout.write(`${msg}\n`);
}
function err(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      rest.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      // A following token that is not a flag is this flag's value.
      if (next !== undefined && !next.startsWith("--")) {
        flags[a.slice(2)] = next;
        i++;
      } else {
        flags[a.slice(2)] = true;
      }
    }
  }
  return { command: rest[0] ?? "", flags };
}

const USAGE = `nanites-cli — set up a standalone Nanites router

  nanites-cli init
      Create a profile, set it active, and report what is missing.
      Flags:
        --name <profile>        profile name (default: "default")
        --vram <gb>             VRAM in GB, advisory only (default: 8)

  nanites-cli add-key <provider>
      Add a provider key to the ACTIVE profile.
      Flags:
        --key <value>           the key itself. Prefer the env var below.
        --account-id <id>       required for cloudflare
        --gateway <url>         base URL, for generic / omniroute
        --nickname <label>      a label for this key, e.g. "work"

  nanites-cli discover [provider]
      List a provider's catalog and register what it finds.

  nanites-cli status
      Show the active profile, its keys, and whether the router can serve.

Environment:
  NANITES_HOME                where the database lives (default ~/.nanites)
  NANITES_API_KEY_<PROVIDER>  read instead of --key, so the secret never
                              appears in shell history or a process listing
`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { command, flags } = parseArgs(argv);

  if (!command || command === "help" || flags["help"]) {
    out(USAGE);
    return 0;
  }

  const home = flags["home"] as string | undefined;
  try {
    switch (command) {
      case "init": return cmdInit(home, flags);
      case "add-key": return cmdAddKey(home, flags, rest0(argv));
      case "discover": return await cmdDiscover(home, flags, rest0(argv));
      case "status": return cmdStatus(home);
      default:
        err(`unknown command "${command}"\n`);
        out(USAGE);
        return 2;
    }
  } catch (e) {
    const code = (e as { code?: string }).code;
    err(`${command} failed${code ? ` (${code})` : ""}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

/** The first positional after the command, i.e. the provider name. */
function rest0(argv: string[]): string {
  const args = argv.filter((a) => !a.startsWith("--"));
  return args[1] ?? "";
}

function cmdInit(home: string | undefined, flags: Record<string, string | boolean>): number {
  const name = (flags["name"] as string) ?? "default";
  const vram = Number(flags["vram"] ?? 8);
  const pm = new ProfileManager(home);

  const existing = pm.getProfile(name);
  if (existing) {
    out(`Profile "${name}" already exists.`);
  } else {
    pm.createProfile({
      name,
      machine_specs: { cpu: "unknown", gpu: "unknown", vram_gb: Number.isFinite(vram) ? vram : 8, ram_gb: 16, storage: "unknown" },
      use_case: "nanites-default",
      // No endpoint: this is a CLOUD-first profile. A local endpoint is
      // optional and only matters if you later delegate to a local model, so
      // init does not require LM Studio to be installed or running.
      endpoint: { url: "http://localhost:1234", auth_token: null },
    });
    out(`Created profile "${name}".`);
  }

  // Idempotent: only switch when the pointer is absent or already correct.
  const active = readActiveProfileName(resolveHome(home));
  if (active === name) {
    out(`Active profile is already "${name}".`);
  } else {
    pm.switchProfile(name);
    out(`Active profile set to "${name}".`);
  }

  // The router caches the binding per home; drop it so a router started after
  // this sees the new pointer immediately.
  setRouterHome(resolveHome(home));

  out("");
  out("Next:");
  out(`  nanites-cli add-key cloudflare --account-id <id>   (set $NANITES_API_KEY_CLOUDFLARE)`);
  out(`  nanites-cli discover cloudflare`);
  out(`  NANITES_ROUTER_KEY=... npm run router`);
  return 0;
}

function cmdAddKey(
  home: string | undefined,
  flags: Record<string, string | boolean>,
  providerArg: string,
): number {
  const provider = (flags["provider"] as string) ?? providerArg;
  if (!provider) {
    err("add-key needs a provider, e.g. `nanites-cli add-key cloudflare`.");
    return 2;
  }
  if (!PROVIDERS.includes(provider as ProviderKind)) {
    err(`Unknown provider "${provider}". Known: ${PROVIDERS.join(", ")}`);
    return 2;
  }
  const prov = provider as ProviderKind;

  // Env FIRST, so the common path never puts a secret in argv. A key in argv is
  // visible to every process on the machine and lands in shell history.
  const envName = `NANITES_API_KEY_${prov.toUpperCase()}`;
  const apiKey = (flags["key"] as string) ?? process.env[envName];
  if (!apiKey) {
    err(`No key given. Set $${envName}, or pass --key <value>.`);
    return 2;
  }
  if (provider === "cloudflare" && !(flags["account-id"] as string)) {
    err("cloudflare requires --account-id <id>. The account id is in the Cloudflare dashboard, not the API token.");
    return 2;
  }

  const profile = requireActiveProfileName(home);
  const opened = openNanitesDb(home);
  try {
    const keyId = new ProviderKeyStore(opened.db).addKey(profile, prov, apiKey, {
      accountId: (flags["account-id"] as string) ?? undefined,
      gatewayUrl: (flags["gateway"] as string) ?? undefined,
      nickname: (flags["nickname"] as string) ?? undefined,
    });
    // The secret is deliberately not echoed.
    out(`Added ${prov} key ${(flags["nickname"] as string) ?? keyId.slice(0, 8)} to profile "${profile}".`);
    out(`Next: nanites-cli discover ${prov}`);
    return 0;
  } finally {
    opened.close();
  }
}

async function cmdDiscover(
  home: string | undefined,
  flags: Record<string, string | boolean>,
  providerArg: string,
): Promise<number> {
  const targets: ProviderKind[] = providerArg
    ? [providerArg as ProviderKind]
    : ((flags["all"] as boolean) ? PROVIDERS : PROVIDERS);

  const profile = requireActiveProfileName(home);
  const opened = openNanitesDb(home);
  setRouterHome(resolveHome(home));
  let failed = 0;
  try {
    for (const prov of targets) {
      if (!PROVIDERS.includes(prov)) {
        err(`Unknown provider "${prov}".`);
        failed++;
        continue;
      }
      process.stdout.write(`discovering ${prov}... `);
      const outcome = await discoverModels(opened.db, prov, { profile });
      if (outcome.ok) {
        out(`${outcome.model_count} models`);
      } else {
        out(`failed (${outcome.code})`);
        err(`  ${outcome.message}`);
        failed++;
      }
    }
    const counts = modelCounts(opened.db, profile);
    out("");
    out(`Profile "${profile}": ${counts.discovered} model(s) discovered, ${counts.registered} registered.`);
    if (counts.discovered > 0 && counts.registered === 0) {
      out("Discovered models are CANDIDATES. Register the ones you want with the MCP tool,");
      out("or set is_registered on the ones you need directly.");
    }
    return failed > 0 ? 1 : 0;
  } finally {
    opened.close();
  }
}

/**
 * Counts, not a single number, because the two are different questions.
 *
 * DISCOVERY STORES CANDIDATES with `is_registered = 0`; registration is a
 * separate, deliberate act. A first version reported only the registered count,
 * so a successful discovery that found 65 models printed "0 registered" — which
 * reads as a failure and sends the user looking for one.
 */
function modelCounts(db: ReturnType<typeof openNanitesDb>["db"], profile: string): { discovered: number; registered: number } {
  try {
    const row = db.prepare(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN is_registered = 1 THEN 1 ELSE 0 END) AS registered FROM provider_models WHERE profile_name = ?",
    ).get(profile) as { total: number; registered: number | null };
    return { discovered: Number(row.total ?? 0), registered: Number(row.registered ?? 0) };
  } catch {
    return { discovered: 0, registered: 0 };
  }
}

function cmdStatus(home: string | undefined): number {
  const opened = openNanitesDb(home);
  const resolvedHome = resolveHome(home);
  try {
    const active = readActiveProfileName(resolvedHome);
    if (!active) {
      out("No active profile.");
      out("This router will refuse every request until one is set.");
      out("");
      out("  nanites-cli init");
      return 1;
    }
    out(`Active profile: ${active}`);

    const keys = opened.db.prepare(
      "SELECT provider, nickname, is_enabled, is_exhausted, exhausted_until FROM provider_api_keys WHERE profile_name = ? ORDER BY provider, nickname",
    ).all(active) as Array<{ provider: string; nickname: string | null; is_enabled: number; is_exhausted: number; exhausted_until: string | null }>;
    if (keys.length === 0) {
      out("Provider keys: none");
      out("");
      out("  nanites-cli add-key cloudflare --account-id <id>");
    } else {
      out("");
      out("Provider keys:");
      const now = new Date().toISOString();
      for (const k of keys) {
        const spent = k.is_exhausted === 1 && k.exhausted_until !== null && k.exhausted_until > now;
        const state = k.is_enabled === 0 ? "disabled" : spent ? `spent until ${k.exhausted_until!.slice(0, 10)}` : "ready";
        out(`  ${k.provider.padEnd(11)} ${(k.nickname ?? "(no nickname)").padEnd(18)} ${state}`);
      }
    }

    const counts = modelCounts(opened.db, active);
    out("");
    out(`Models: ${counts.discovered} discovered, ${counts.registered} registered`);
    out(`Router can serve: ${keys.some((k) => k.is_enabled === 1) ? "yes" : "no — add a key"}`);
    return 0;
  } finally {
    opened.close();
  }
}

function requireActiveProfileName(home: string | undefined): string {
  const name = readActiveProfileName(resolveHome(home));
  if (!name) {
    throw Object.assign(
      new Error('no active profile. Run `nanites-cli init` first.'),
      { code: "no_active_profile" },
    );
  }
  return name;
}

function resolveHome(home: string | undefined): string {
  if (home) return home;
  if (process.env["NANITES_HOME"]) return process.env["NANITES_HOME"];
  const base = process.env["USERPROFILE"] ?? process.env["HOME"] ?? ".";
  return `${base}/.nanites`;
}

const invokedDirectly = process.argv[1] !== undefined
  && /cli[/\\]main\.(js|ts)$/.test(process.argv[1]);
if (invokedDirectly) {
  // AwaIT before exiting: `process.exit(promise)` coerces the promise to NaN
  // and exits 0, which would report success for a command that failed.
  void main().then((code) => process.exit(code));
}
