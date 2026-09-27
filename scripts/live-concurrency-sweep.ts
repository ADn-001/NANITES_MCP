#!/usr/bin/env tsx
/**
 * LIVE CONCURRENCY SWEEP — CP-3 / CP-4 / CP-5 end-to-end against the real LM
 * Studio at NANITES_LM_BASE_URL. Not CI, not gate-blocking. If Studio is
 * unreachable, prints SKIP and exits 0.
 *
 * Confirms, on a real sequential profile, that:
 *   1. CP-3: a load body carries `parallel: 1` and the resident instance
 *      reports `config.parallel: 1` back through listModels.
 *   2. CP-4: two concurrent blocking run_sub_agent calls serialize (chat B
 *      starts only after chat A's load + chat + teardown fully complete —
 *      no two live chats, no double-load race).
 *   3. CP-5: a /api/profile GET reflects the resolved pair + allowed_pairs;
 *      a concurrency_override patch round-trips; a forced-tier override is
 *      rejected; clearing returns to derived.
 *
 * Usage:
 *   NANITES_LM_BASE_URL=http://localhost:1234 \
 *     LIVE_MODEL=qwen3.5-0.8b tsx scripts/live-concurrency-sweep.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server/buildServer.js";
import { buildDeps } from "../src/tools/deps.js";
import { LmStudioClient } from "../src/lmstudio/client.js";
import { NanitesError } from "../src/helpers/errors.js";
import { startUiServer, type UiServer } from "../src/ui/server.js";
import { allowedPairsForVram } from "../src/guardrails/tiers.js";

const baseUrl = process.env.NANITES_LM_BASE_URL ?? "http://localhost:1234";
const model = process.env.LIVE_MODEL ?? "qwen3.5-0.8b";
// Studio's server config can require an auth token; honor either the
// explicit sweep env var or the standard token env the rest of the codebase
// already uses (LMSTUDIO_API_KEY / LMSTUDIO_AUTH_TOKEN / NANITES_LM_AUTH_TOKEN).
// Resolve against NANITES_LMS_API_TOKEN too — that is the env var the
// profile-driven LmStudioClient (built by buildDeps) reads at runtime.
const authToken = process.env.NANITES_LM_SWEEP_TOKEN
  ?? process.env.LMSTUDIO_API_KEY
  ?? process.env.LMSTUDIO_AUTH_TOKEN
  ?? process.env.NANITES_LM_AUTH_TOKEN
  ?? process.env.NANITES_LMS_API_TOKEN
  ?? null;
if (authToken) {
  process.env.NANITES_LMS_API_TOKEN = authToken;
  console.log(`OK  using bearer token from env (length ${authToken.length})`);
}

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.error(`  FAIL  ${label} ${detail}`);
  }
}

async function main(): Promise<number> {
  const client = new LmStudioClient({ baseUrl, authToken, timeoutMs: 30_000 });
  try {
    await client.listModels();
  } catch (err) {
    if (err instanceof NanitesError && (err.code === "connection_refused" || err.code === "network_error")) {
      console.log(`SKIP: LM Studio unreachable at ${baseUrl} (${err.code}). Live test; run with the server up.`);
      return 0;
    }
    if (err instanceof NanitesError && err.code === "http_client_error") {
      const status = (err.details as { status?: number } | undefined)?.status;
      if (status === 401 || status === 403) {
        console.log(`SKIP: LM Studio at ${baseUrl} requires auth (HTTP ${status}). Set NANITES_LMS_API_TOKEN or the studio-side "OpenAI compatible API server > Require API Key" toggle, then re-run.`);
        return 0;
      }
    }
    throw err;
  }
  console.log(`OK  LM Studio reachable at ${baseUrl}; using model "${model}"`);

  const home = mkdtempSync(join(tmpdir(), "nanites-live-conc-"));
  let ui: UiServer | null = null;
  try {
    const deps = buildDeps(home);
    const server = buildServer({ home, deps });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "nanites-live-conc", version: "0.0.1" });
    await server.server.connect(st);
    await mcp.connect(ct);
    const call = async (name: string, args: unknown): Promise<{ ok: boolean; data?: any; error?: any }> => {
      const r = await mcp.callTool({ name, arguments: args as Record<string, unknown> });
      const text = (r.content.find((c: any) => c.type === "text")?.text ?? "{}") as string;
      return JSON.parse(text);
    };

    // ---- Sequential profile (4GB -> forced 1x1) ----
    await call("create_profile", {
      name: "seq",
      endpoint: { url: baseUrl },
      machine_specs: { vram_gb: 4 },
      inference: { effort: "low" },
    });
    await call("write_registry_entry", { profile: "seq", model_id: model, entry: { roles: ["summarizer"] } });
    await call("switch_profile", { name: "seq" });

    // Boot the UI server for the CP-5 round-trip (same transport as a real
    // dashboard save).
    ui = await startUiServer(deps, { port: 0 });
    const uiBase = `http://127.0.0.1:${ui.port}`;

    // ---- CP-3: load body carries parallel:1, instance reports config.parallel:1 ----
    console.log("\n[CP-3] load carries parallel:1 on a sequential profile");
    // Use a long-running request and poll listModels while the model is still
    // loaded; the sub-agent auto-unloads on teardown so a single check after
    // the call returns will often see the slot already freed.
    const probeChatPromise = call("run_sub_agent", {
      profile: "seq",
      model_id: model,
      brief: "Count slowly from 1 to 5, one number per line, then say done.",
      effort: "low",
    });
    let probe = null as null | Awaited<ReturnType<typeof call>>;
    let probeInst: { loaded_instances: Array<{ config?: { parallel?: number } }> } | undefined;
    const probeStart = Date.now();
    while (Date.now() - probeStart < 20_000) {
      const r = await client.listModels();
      probeInst = r.models.find((m) => m.loaded_instances.length > 0);
      if (probeInst) break;
      await new Promise((res) => setTimeout(res, 80));
    }
    probe = await probeChatPromise;
    ok(probe.ok === true, "CP-3 probe run ok", JSON.stringify(probe.error));
    ok(probe.data?.loaded_this_call === true, "CP-3 probe loaded this call");
    ok(!!probeInst, "CP-3 instance present in listModels while chat is in flight");
    ok(probeInst?.loaded_instances[0]?.config?.parallel === 1, "CP-3 instance config.parallel === 1", `parallel=${probeInst?.loaded_instances[0]?.config?.parallel}`);
    // The chat must still have produced a reply (we didn't break loads).
    ok(typeof probe.data?.reply === "string" && probe.data.reply.length > 0, "CP-3 chat reply produced", `reply=${JSON.stringify(probe.data?.reply).slice(0, 60)}`);

    // ---- CP-4: two concurrent blocking run_sub_agent calls serialize ----
    console.log("\n[CP-4] two concurrent blocking calls serialize on a sequential tier");
    const sweepStart = Date.now();
    const [a, b] = await Promise.all([
      call("run_sub_agent", { profile: "seq", model_id: model, brief: "Say ready.", effort: "low" }),
      call("run_sub_agent", { profile: "seq", model_id: model, brief: "Say go.", effort: "low" }),
    ]);
    const sweepMs = Date.now() - sweepStart;
    ok(a.ok === true && b.ok === true, "CP-4 both calls returned ok", `a=${JSON.stringify(a.error)} b=${JSON.stringify(b.error)}`);
    ok(a.data?.loaded_this_call === true && b.data?.loaded_this_call === true, "CP-4 each call loaded (no double-load race; serialized two clean cycles)");
    ok(sweepMs >= 800, "CP-4 elapsed >= 800ms (two serialized chats, not overlapped)", `elapsed=${sweepMs}ms`);

    // ---- CP-5: /api/profile reflects pair + allowed_pairs ----
    console.log("\n[CP-5] /api/profile reports the resolved pair and allowed pairs");
    const prof = (await (await fetch(`${uiBase}/api/profile?name=seq`)).json()) as {
      profile: { concurrency: { mode: string; max_parallel_models: number; num_parallel: number }; allowed_pairs: unknown[]; concurrency_override: unknown; overridden: boolean };
    };
    ok(prof.profile.concurrency.num_parallel === 1, "CP-5 concurrency.num_parallel === 1 on sequential", JSON.stringify(prof.profile.concurrency));
    ok(prof.profile.overridden === false, "CP-5 overridden === false by default");
    ok(Array.isArray(prof.profile.allowed_pairs) && prof.profile.allowed_pairs.length === 0, "CP-5 sequential allowed_pairs is empty (forced tier)", JSON.stringify(prof.profile.allowed_pairs));
    ok(allowedPairsForVram(4).length === 0, "CP-5 advisor agrees: <12GB has no allowed pairs");

    // ---- CP-5: dashboard patch round-trips; forced-tier override rejected ----
    console.log("\n[CP-5] dashboard override round-trip + forced-tier rejection");
    const patchOk = await fetch(`${uiBase}/api/settings/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "seq", concurrency_override: { max_parallel_models: 2, num_parallel: 2 } }),
    });
    ok(patchOk.status === 400, "CP-5 forced-tier override rejected with 400", `status=${patchOk.status}`);
    const rejBody = (await patchOk.json()) as { code?: string };
    ok(rejBody.code === "concurrency_override_invalid", "CP-5 rejection code is concurrency_override_invalid", `code=${rejBody.code}`);

    // Switch to a 16GB parallel profile (2x2 only) and prove the override saves.
    await call("create_profile", {
      name: "par",
      endpoint: { url: baseUrl },
      machine_specs: { vram_gb: 16 },
      inference: { effort: "low" },
    });
    await call("write_registry_entry", { profile: "par", model_id: model, entry: { roles: ["summarizer"] } });
    await call("switch_profile", { name: "par" });

    const patchPar = await fetch(`${uiBase}/api/settings/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "par", concurrency_override: { max_parallel_models: 2, num_parallel: 2 } }),
    });
    ok(patchPar.status === 200, "CP-5 16GB override saves (200)", `status=${patchPar.status}`);
    const after = (await (await fetch(`${uiBase}/api/profile?name=par`)).json()) as {
      profile: { concurrency: { num_parallel: number }; overridden: boolean; allowed_pairs: Array<{ max_parallel_models: number; num_parallel: number }> };
    };
    ok(after.profile.overridden === true, "CP-5 16GB overridden flag is true after patch");
    ok(after.profile.concurrency.num_parallel === 2, "CP-5 16GB concurrency.num_parallel === 2 after patch");
    ok(after.profile.allowed_pairs.length === 1 && after.profile.allowed_pairs[0]?.num_parallel === 2, "CP-5 16GB allowed_pairs is the single 2x2");

    const clearPatch = await fetch(`${uiBase}/api/settings/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "par", concurrency_override: null }),
    });
    ok(clearPatch.status === 200, "CP-5 clearing override saves (200)", `status=${clearPatch.status}`);
    const cleared = (await (await fetch(`${uiBase}/api/profile?name=par`)).json()) as {
      profile: { overridden: boolean; concurrency: { num_parallel: number } };
    };
    ok(cleared.profile.overridden === false, "CP-5 cleared override returns overridden=false");
    ok(cleared.profile.concurrency.num_parallel === 2, "CP-5 derived default on 16GB is 2 slots");

    await mcp.close();
    await server.server.close();
    deps.close();
  } finally {
    if (ui) {
      try { await ui.close(); } catch {}
    }
    try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  return fail === 0 ? 0 : 1;
}

void main().then((code) => process.exit(code)).catch((err) => {
  console.error(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
