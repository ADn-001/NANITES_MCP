/**
 * Concurrency-hardening live probe (Phase CP-1): does the native
 * POST /api/v1/models/load accept a per-model num_parallel field, and does the
 * value round-trip into loaded_instances[].config.parallel?
 *
 * Loads ONE small model per attempt and unloads it before the next, so at most
 * one extra resident instance exists mid-probe. Never prints the auth token.
 * Run:
 *   NANITES_HOME=~/.nanites node scripts/live-probe-parallel.mjs [profileName]
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const home = process.env.NANITES_HOME || path.join(homedir(), ".nanites");
const REQ_TIMEOUT_MS = 30000;

function findProfileName(want) {
  if (want) return want;
  const activePath = path.join(home, "active_profile.json");
  if (existsSync(activePath)) {
    try {
      return JSON.parse(readFileSync(activePath, "utf8")).name;
    } catch {
      /* fall through to listing */
    }
  }
  throw new Error(`no active profile under ${home}`);
}

function loadProfile(name) {
  const profilesDir = path.join(home, "profiles");
  const candidates = [path.join(profilesDir, name.toLowerCase() + ".json"), path.join(profilesDir, name + ".json")];
  for (const p of candidates) if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  throw new Error(`profile "${name}" not found under ${profilesDir}`);
}

async function req(base, token, urlPath, method = "GET", body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(base + urlPath, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
    return { status: res.status, json, text: text.slice(0, 300) };
  } catch (err) {
    return { status: 0, json: null, text: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

async function loadedInstances(base, token) {
  const r = await req(base, token, "/api/v1/models");
  const arr = Array.isArray(r.json?.models) ? r.json.models : Array.isArray(r.json?.data) ? r.json.data : [];
  return arr.flatMap((m) => (m.loaded_instances ?? []).map((i) => ({ key: m.key ?? m.id, ...i })));
}

async function unloadInstance(base, token, instanceId) {
  if (!instanceId) return "no-id";
  const r = await req(base, token, "/api/v1/models/unload", "POST", { instance_id: instanceId });
  return `${r.status}`;
}

async function main() {
  const name = findProfileName(process.argv[2]);
  const profile = loadProfile(name);
  const base = (profile.endpoint?.url || "http://localhost:1234").replace(/\/$/, "");
  const token = profile.endpoint?.auth_token || process.env.NANITES_LMS_API_TOKEN || "";
  if (!token) throw new Error("no auth token on profile/env");

  const list = await req(base, token, "/api/v1/models");
  if (list.status !== 200) {
    console.log(`inventory HTTP ${list.status}: ${list.text}`);
    return;
  }
  const arr = Array.isArray(list.json?.models) ? list.json.models : Array.isArray(list.json?.data) ? list.json.data : [];
  const models = arr.filter((m) => !String(m.key ?? m.id).toLowerCase().includes("embed"));
  const bySize = (m) => (typeof m.size_bytes === "number" ? m.size_bytes : typeof m.size_mb === "number" ? m.size_mb * 1024 * 1024 : Infinity);
  const small = [...models].sort((a, b) => bySize(a) - bySize(b))[0];
  const easyId = models.find((m) => /0\.6b|0\.8b|1\.5b|2b/i.test(String(m.key ?? m.id)));
  const pick = easyId || small;
  if (!pick) {
    console.log("no llm model to probe with");
    return;
  }
  const modelId = pick.key ?? pick.id;
  console.log(`profile=${name} endpoint=${base}`);
  console.log(`probe model: ${modelId} (size=${pick.size_bytes ?? pick.size_mb ?? "?"})`);

  const before = await loadedInstances(base, token);
  console.log(`resident before: ${before.map((i) => `${i.key}#${i.id} p=${i.config?.parallel}`).join(", ") || "none"}`);

  async function attempt(label, body) {
    const before = await loadedInstances(base, token);
    const beforeIds = new Set(before.map((i) => i.id));
    const r = await req(base, token, "/api/v1/models/load", "POST", { model: modelId, ...body });
    if (r.status >= 200 && r.status < 300) {
      await new Promise((res) => setTimeout(res, 1000));
      const insts = await loadedInstances(base, token);
      const mine = insts.filter((i) => i.key === modelId && !beforeIds.has(i.id));
      const par = mine.map((i) => i.config?.parallel);
      const unloads = [];
      for (const i of mine) unloads.push(await unloadInstance(base, token, i.id));
      console.log(`[${label}] ACCEPT echo.load_config.parallel=${r.json?.load_config?.parallel ?? "?"} new.parallel=${par.join(",") || "?"} unload=[${unloads.join(",")}]`);
    } else {
      console.log(`[${label}] REJECT status=${r.status} body=${r.text}`);
    }
  }

  await attempt("parallel=1", { parallel: 1 });
  await attempt("parallel=2", { parallel: 2 });
  await attempt("parallel=4", { parallel: 4 });

  const after = await loadedInstances(base, token);
  console.log(`resident after: ${after.map((i) => i.id).join(", ") || "none"}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
