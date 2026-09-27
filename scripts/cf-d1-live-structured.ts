/**
 * D1 live gate: structured output on the Cloudflare path.
 *
 * Two modes, because the cheap failure is worth finding before the expensive
 * one. `probe` sends one small tool-less call carrying `response_format` in
 * Cloudflare's flat shape and prints the raw reply — if the provider ignores
 * the field, this is where it shows, for a fraction of a neuron. `full` runs
 * the exit brief (the five-file review that returned *prose*) through
 * the real fs tool loop with `output_schema` set, which is the phase's actual
 * claim: the same brief now answers in schema-valid JSON.
 *
 * Live credentials are already in the profile's key store; key material is
 * never read or printed here.
 *
 * Run: npx tsx scripts/cf-d1-live-structured.ts [probe|probe-plain|full] [profile] [model]
 * Pass a model to `full` only to bypass an unusable reviewer pin (see below).
 */
import { buildDeps } from "../src/tools/deps.js";
import { RolePinStore } from "../src/storage/rolePinStore.js";
import { routeCloudWithRetry } from "../src/providers/router.js";
import { runSubAgent } from "../src/workflows/runSubAgent.js";
import type { ProviderKind } from "../src/storage/profileDefaults.js";

const SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "integer" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          defect: { type: "string" },
        },
        required: ["file", "line", "severity", "defect"],
      },
    },
    summary: { type: "string" },
  },
  required: ["findings", "summary"],
};

const FILES = [
  "src/helpers/cleaner.ts",
  "src/storage/callLogStore.ts",
  "src/storage/providerCallLogStore.ts",
  "src/workflows/costSavedReport.ts",
  "src/helpers/inferencePlanner.ts",
];

const FULL_BRIEF = [
  "Review these five files for correctness defects.",
  ...FILES.map((f) => `- ${f}`),
  "",
  "Read each file with the read_file tool before judging it, then answer with the requested JSON.",
  "Report at most 5 findings.",
].join("\n");

/**
 * A live run that fails tells us nothing on its own. The loop records one
 * `chat.round` event per round and one provider call-log row per HTTP request,
 * so a failure can be attributed to a specific round instead of being blamed on
 * "the provider".
 */
let startedAt = Date.now();
let depsRef: ReturnType<typeof buildDeps> | null = null;
let profileRef = "test";

function diagnose(): void {
  if (!depsRef) return;
  const since = new Date(startedAt - 120_000).toISOString();
  try {
    const events = depsRef.subAgentEvents.listSinceByTime(profileRef, since, 200);
    const rounds = events.filter((e) => e.phase === "chat.round");
    console.error(`\nprogress: ${rounds.length} round(s) started`);
    for (const e of events) {
      const p = e.payload ?? {};
      const detail =
        p.round !== undefined ? `round ${p.round} tools=${p.tools_advertised}` : JSON.stringify(p).slice(0, 160);
      console.error(`  ${e.created_at.slice(11, 19)}  ${e.phase.padEnd(18)} ${detail}`);
    }
  } catch (err) {
    console.error(`  (event read failed: ${(err as Error).message})`);
  }
  try {
    const calls = depsRef.providerCallLogs.listRecent(profileRef, { sinceIso: since, limit: 50 });
    console.error(`provider calls (${calls.length}):`);
    for (const c of calls) {
      console.error(
        `  ${c.created_at.slice(11, 19)}  ${c.status.padEnd(7)} ${String(c.duration_ms).padStart(7)}ms ` +
          `out=${c.tokens_out} finish=${c.finish_reason ?? "none"} ${c.model_id}`,
      );
    }
  } catch (err) {
    console.error(`  (call-log read failed: ${(err as Error).message})`);
  }
}

function firstJson(text: string): { ok: boolean; detail: string } {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  const body = (fenced ? fenced[1]! : trimmed).trim();
  try {
    const value = JSON.parse(body) as Record<string, unknown>;
    return { ok: true, detail: `keys: ${Object.keys(value).join(", ") || "(none)"}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "probe";
  const profileName = process.argv[3] ?? "test";
  const deps = buildDeps();
  startedAt = Date.now();
  depsRef = deps;
  profileRef = profileName;
  const profile = deps.profiles.getProfile(profileName);
  if (!profile) {
    console.error(`no profile named ${profileName}`);
    process.exitCode = 1;
    return;
  }
  const pin = new RolePinStore(deps.db).list(profileName).find((p) => p.role === "reviewer");
  console.log(`reviewer pin   ${pin ? `${pin.provider}/${pin.model_id}` : "(none — dynamic CF selection)"}`);
  const provider = (pin?.provider ?? "cloudflare") as ProviderKind;
  const modelId = pin?.model_id ?? undefined;

  if (mode === "probe" || mode === "probe-plain") {
    const started = Date.now();
    const res = await routeCloudWithRetry(
      {
        profile,
        db: deps.db,
        effort: "low",
        role: "reviewer",
        brief: "structured output probe",
        messages: [
          {
            role: "user",
            content:
              'Return a JSON object with one findings entry for a file "src/x.ts" at line 1, ' +
              'severity "low", defect "probe". Include a summary string.',
          },
        ],
        systemPrompt: "Answer with JSON only.",
        // `probe-plain` is the control: same call, no response_format. If it
        // succeeds where `probe` fails, the field is the cause, not the model.
        ...(mode === "probe-plain" ? {} : { responseFormat: { type: "json_schema" as const, schema: SCHEMA } }),
      },
      provider,
      modelId,
    );
    const parsed = firstJson(res.response.content ?? "");
    console.log(`model          ${res.model_id}`);
    console.log(`elapsed        ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log(`finish_reason  ${res.finish_reason ?? "none"}`);
    console.log(`content chars  ${(res.response.content ?? "").length}`);
    console.log(`parsed         ${parsed.ok ? "yes" : "NO"} (${parsed.detail})`);
    console.log(`\n--- reply ---\n${(res.response.content ?? "").trim().slice(0, 800)}\n--- end ---`);
    const label = mode === "probe-plain" ? "control (no response_format)" : "response_format sent";
    console.log(parsed.ok ? `\nPROBE PASS — ${label}: answer parsed` : `\nPROBE FAIL — ${label}: prose or invalid JSON`);
    if (!parsed.ok) process.exitCode = 1;
    deps.close();
    return;
  }

  // full
  // An optional model argument overrides the reviewer pin. It exists because a
  // pinned free-tier model can be unusable for the answer round:
  // `glm-4.7-flash` spent every attempt past the 240 s client
  // timeout for 40 minutes, which is a property of the model on that tier, not of
  // the structured-output wiring this gate is testing.
  const modelOverride = process.argv[4];
  if (modelOverride) console.log(`model override ${modelOverride} (pin bypassed)`);
  const started = Date.now();
  const res = await runSubAgent(deps, profileName, FULL_BRIEF, {
    roles: ["reviewer"],
    outputSchema: SCHEMA,
    ...(modelOverride ? { provider, model_id: modelOverride } : {}),
  });
  const parsed = firstJson(res.reply);
  console.log(`\nmodel          ${res.model_id}`);
  console.log(`elapsed        ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`tools used     ${res.tools_used.length} -> ${[...new Set(res.tools_used.map((t) => t.tool))].join(", ")}`);
  console.log(`tokens         in ${res.token_usage.inputTokens} / out ${res.token_usage.outputTokens}`);
  console.log(`validation     cleaned=${res.validation.cleaned} issues=[${res.validation.issues.join("; ")}]`);
  console.log(`parsed         ${parsed.ok ? "yes" : "NO"} (${parsed.detail})`);
  console.log(`\n--- reply ---\n${res.reply.trim().slice(0, 1200)}\n--- end ---`);

  const reads = res.tools_used.filter((t) => t.tool === "read_file").length;
  const checks: Array<[string, boolean]> = [
    ["cloud run", res.instance_id.startsWith("cloud:")],
    ["loop read at least 4 files", reads >= 4],
    ["reply parses as JSON", parsed.ok],
    ["no output_schema_invalid issue", !res.validation.issues.some((i) => i.startsWith("output_schema_invalid"))],
  ];
  console.log("");
  for (const [label, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  const ok = checks.every(([, v]) => v);
  console.log(ok ? "\nGATE PASS — structured output end to end" : "\nGATE FAIL");
  if (!ok) process.exitCode = 1;
  deps.close();
}

main().catch((e) => {
  const err = e as { code?: string; message?: string; retryable?: boolean; details?: Record<string, unknown> };
  console.error(`d1 live gate failed: [${err.code ?? "unstructured"}] ${err.message ?? String(e)}`);
  console.error(`  retryable=${err.retryable ?? "?"} (a transport error here is the network's, not the code's)`);
  // The status distinguishes "the parameter is rejected" (4xx) from "their side
  // is down" (5xx) — the whole point of running the control.
  console.error(`  details=${JSON.stringify(err.details ?? null)}`);
  diagnose();
  process.exitCode = 1;
});
