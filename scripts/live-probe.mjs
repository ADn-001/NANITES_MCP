/**
 * Consolidated live-capability probe for the Nanites LM Studio endpoint.
 * Answers the Phase B/D/H/G open questions that were deferred to a live probe:
 *   - reachability + loaded model inventory (llm vs embedding)
 *   - does an OpenAPI inventory exist, and what paths does it expose?
 *   - is there a tokenize endpoint?
 *   - is there an embeddings endpoint (v1 vs the documented v0)?
 *   - does load expose any async/progress surface, or is it the blocking POST?
 *   - is there any system/VRAM surface?
 *
 * Read-only: issues GETs and one OpenAPI fetch, no model loads, no destructive
 * calls. Never prints the auth token or full request bodies. Run:
 *   NANITES_HOME=~/.nanites node scripts/live-probe.mjs [profileName]
 * (profile defaults to the active profile). Findings are meant to be recorded
 * in GATELOG Phase B notes.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const home = process.env.NANITES_HOME || path.join(homedir(), ".nanites");
const REQ_TIMEOUT_MS = 8000;

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
  const profilesDir = path.join(home, "profiles");
  const names = existsSync(profilesDir) ? readdirSync(profilesDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")) : [];
  if (names.length === 0) throw new Error("no profiles under " + home);
  console.error(`No active profile; pick one: ${names.join(", ")}`);
  throw new Error("active_profile.json missing/unreadable");
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
    return { status: res.status, json, text: text.slice(0, 400) };
  } catch (err) {
    return { status: 0, json: null, text: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

function classifyPaths(paths) {
  const all = Object.keys(paths).sort();
  const has = (re) => all.filter((p) => re.test(p));
  return {
    count: all.length,
    tokenize: has(/tokenize/i),
    embeddings: has(/embed/i),
    load: has(/models\/load/i),
    loadProgress: has(/load.*(progress|status|async)|progress.*load/i),
    system: has(/system|gpu|memory|vram|resource|stats|server\/info/i),
    all,
  };
}

async function main() {
  const name = findProfileName(process.argv[2]);
  const prof = loadProfile(name);
  const base = prof.endpoint?.url;
  const token = prof.endpoint?.auth_token;
  if (!base) throw new Error(`profile "${name}" has no endpoint.url`);
  const shown = prof.endpoint?.auth_token ? "<present>" : "<absent>";

  console.log(`\n== live probe: profile "${name}" @ ${base} (auth token ${shown}) ==\n`);

  const models = await req(base, token, "/api/v1/models");
  console.log(`GET /api/v1/models -> ${models.status}`);
  if (models.json?.models) {
    const list = models.json.models;
    const loaded = list.filter((m) => m.loaded_instances?.length > 0);
    const embedding = list.filter((m) => /embed/i.test(m.type ?? ""));
    console.log(`  inventory: ${list.length} total, ${loaded.length} loaded, ${embedding.length} embedding-type`);
    for (const m of loaded) {
      const types = m.loaded_instances.map((i) => (i.id ?? "").slice(0, 60)).join(", ");
      console.log(`  [loaded] ${m.type} ${m.key} (${types})`);
    }
    if (loaded.length === 0) console.log("  (no models currently loaded)");
    if (embedding.length === 0) console.log("  (no embedding-type models in inventory -> embeddings will 5xx until one is downloaded)");
    // Full inventory (id + type) is useful to H (which embedding model to load)
    // and to any later minimal-load experiment. Model keys are not secrets.
    console.log("  inventory keys (type: key):");
    for (const m of list) console.log(`    ${m.type}: ${m.key}`);
    // Does listModels report live free/total VRAM anywhere? (G wants live VRAM.)
    const vramLeads = JSON.stringify(list).match(/(vram|free_mem|memory_free|gpu_mem|vram_free|available_memory)/i);
    console.log(`  listModels contains VRAM/memory fields? ${vramLeads ? "YES (see below)" : "no"}`);
  } else if (models.status !== 0) {
    console.log(`  unexpected body: ${JSON.stringify(models.text).slice(0, 300)}`);
  } else {
    console.log(`  unreachable: ${models.text}`);
  }

  const spec = await req(base, token, "/openapi.json");
  console.log(`\nGET /openapi.json -> ${spec.status}`);
  if (spec.json?.paths) {
    const c = classifyPaths(spec.json.paths);
    console.log(`  openapi exposes ${c.count} paths`);
    console.log(`  tokenize endpoints: ${c.tokenize.length ? c.tokenize.join(", ") : "NONE"}`);
    console.log(`  embedding endpoints: ${c.embeddings.length ? c.embeddings.join(", ") : "NONE"}`);
    console.log(`  load endpoints: ${c.load.length ? c.load.join(", ") : "NONE"}`);
    console.log(`  async/load-progress endpoints: ${c.loadProgress.length ? c.loadProgress.join(", ") : "NONE"}`);
    console.log(`  system/vram/stats endpoints: ${c.system.length ? c.system.join(", ") : "NONE"}`);
    // Document the load path's request semantics as the spec describes them.
    for (const p of c.load) {
      const ops = spec.json.paths[p];
      for (const [verb, op] of Object.entries(ops)) {
        if (typeof op !== "object" || op === null) continue;
        const desc = op.description || op.summary || "";
        console.log(`  ${verb.toUpperCase()} ${p}: ${String(desc).split("\n")[0].slice(0, 160)}`);
        const params = op.requestBody?.content?.["application/json"]?.schema?.properties;
        if (params) console.log(`    params: ${Object.keys(params).join(", ")}`);
      }
    }
    console.log(`\n  full path list (${c.count}):`);
    console.log("   " + c.all.join("\n   "));
  } else {
    console.log(`  openapi not available (${spec.status} ${spec.text.slice(0, 120)})`);
    // Fall back to direct route probes so the answers aren't blank.
    for (const probe of [
      ["POST /api/v1/embeddings", "POST", "/api/v1/embeddings", { model: "probe", input: "hi" }],
      ["POST /api/v0/embeddings", "POST", "/api/v0/embeddings", { model: "probe", input: "hi" }],
      ["POST /api/v1/tokenize", "POST", "/api/v1/tokenize", { model: "probe", prompt: "hi" }],
    ]) {
      const [label, method, p, body] = probe;
      const r = await req(base, token, p, method, body);
      console.log(`${label} -> ${r.status}${r.status === 404 ? " (no route)" : ""} ${r.json ? JSON.stringify(r.json).slice(0, 160) : ""}`);
    }
  }

  // Candidate system/VRAM surfaces (for G). Read-only GETs; harmless misses.
  console.log("\n== candidate system/VRAM surfaces (read-only GETs) ==");
  for (const p of [
    "/api/v1/system/info",
    "/api/v1/system/health",
    "/api/v1/server/info",
    "/api/v1/gpu",
    "/api/v1/memory",
    "/api/v1/hardware",
    "/api/v1/models/load", // GET on a POST route -> method-not-allowed vs no-route tells us it exists
  ]) {
    const r = await req(base, token, p);
    const isErrBody = r.json?.error && /unexpected endpoint/i.test(r.json.error);
    const kind = r.status === 404 || isErrBody ? "no route" : r.status === 405 ? "route exists (method not allowed)" : `route ${r.status}`;
    console.log(`GET ${p} -> ${r.status} (${kind})`);
  }
  console.log("\nprobe complete.\n");
}

main().catch((err) => {
  console.error("probe failed:", err.message);
  process.exit(1);
});
