/**
 * D2 live gate: loop economics and observability.
 *
 * The claim is about numbers, not about a boolean: the same five-file review
 * that cost 860 s in the pre-fix exit should now batch its reads into one round
 * and finish sooner, and the run should be explainable from what it prints
 * rather than from a later database dig. So the pass/fail below is reported
 * alongside every measurement that produced it.
 *
 * Modes:
 *   full      the five-file review, round detail printed per round.
 *   failpath  one call against a model id that cannot exist. Cheap (a
 *             model-not-found spends no neurons) and the only way to prove the
 *             new failed-round ledger row without waiting for a real timeout:
 *             before D2 a failed round wrote `provider_errors` and nothing to
 *             `provider_sub_agent_calls`, so the dashboard's round timeline
 *             reported a 6-round run that had 7.
 *
 * Live credentials are already in the profile's key store; key material is
 * never read or printed here.
 *
 * Run: npx tsx scripts/cf-d2-loop-live.ts [full|failpath] [profile] [model]
 */
import { buildDeps } from "../src/tools/deps.js";
import { RolePinStore } from "../src/storage/rolePinStore.js";
import { routeCloudWithRetry } from "../src/providers/router.js";
import { runSubAgent } from "../src/workflows/runSubAgent.js";
import type { ProviderKind } from "../src/storage/profileDefaults.js";
import type { RoundDetail } from "../src/providers/cloudToolLoop.js";

/** The pre-fix exit measurement this phase is measuring against. */
const BASELINE_S = 860;

const FILES = [
  "src/helpers/cleaner.ts",
  "src/storage/callLogStore.ts",
  "src/storage/providerCallLogStore.ts",
  "src/workflows/costSavedReport.ts",
  "src/helpers/inferencePlanner.ts",
];

const BRIEF = [
  "Review these five files for correctness defects.",
  ...FILES.map((f) => `- ${f}`),
  "",
  "Read each file with the read_file tool before judging it.",
  "Report at most 5 findings, each as file, line, severity and defect.",
].join("\n");

function printRounds(detail: RoundDetail[] | undefined): void {
  if (!detail || detail.length === 0) {
    console.log("round detail   (none — single tool-less request)");
    return;
  }
  console.log("round detail:");
  for (const r of detail) {
    console.log(
      `  round ${r.round}  tools=${String(r.tools_advertised).padEnd(5)} ` +
        `${String(r.infer_ms).padStart(7)}ms  out=${String(r.tokens_out).padStart(6)}  finish=${r.finish_reason ?? "none"}`,
    );
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "full";
  const profileName = process.argv[3] ?? "test";
  const deps = buildDeps();
  const profile = deps.profiles.getProfile(profileName);
  if (!profile) {
    console.error(`no profile named ${profileName}`);
    process.exitCode = 1;
    return;
  }
  const pin = new RolePinStore(deps.db).list(profileName).find((p) => p.role === "reviewer");
  const provider = (pin?.provider ?? "cloudflare") as ProviderKind;
  const modelOverride = process.argv[4];
  console.log(`reviewer pin   ${pin ? `${pin.provider}/${pin.model_id}` : "(none — dynamic CF selection)"}`);
  if (modelOverride) console.log(`model override ${modelOverride} (pin bypassed)`);

  if (mode === "failpath") {
    // A model id Cloudflare cannot resolve. The router classifies it as
    // model-scoped, logs an error row, and walks on — no retry storm.
    const bogus = modelOverride ?? "@cf/nanites/does-not-exist";
    const before = deps.providerCallLogs.listRecent(profileName, { limit: 5 });
    try {
      await routeCloudWithRetry(
        {
          profile,
          db: deps.db,
          effort: "low",
          role: "reviewer",
          brief: "failpath probe",
          messages: [{ role: "user", content: "say ok" }],
        },
        provider,
        bogus,
      );
      console.log("\nFAILPATH FAIL — the call was expected to fail and returned");
      process.exitCode = 1;
    } catch (err) {
      const e = err as { code?: string; message?: string };
      console.log(`\nfailed as expected: [${e.code ?? "unstructured"}] ${e.message ?? ""}`);
    }
    const after = deps.providerCallLogs.listRecent(profileName, { limit: 5 });
    const fresh = after.filter((c) => !before.some((b) => b.id === c.id));
    console.log(`new ledger rows: ${fresh.length}`);
    for (const c of fresh) {
      console.log(`  status=${c.status} model=${c.model_id} out=${c.tokens_out} ms=${c.duration_ms}`);
    }
    const ok = fresh.length >= 1 && fresh.every((c) => c.status !== "success");
    console.log(ok ? "\nFAILPATH PASS — a failed round leaves a ledger row" : "\nFAILPATH FAIL — no ledger row for the failed round");
    if (!ok) process.exitCode = 1;
    deps.close();
    return;
  }

  const started = Date.now();
  const res = await runSubAgent(deps, profileName, BRIEF, {
    roles: ["reviewer"],
    ...(modelOverride ? { provider, model_id: modelOverride } : {}),
  });
  const elapsedS = (Date.now() - started) / 1000;
  const reads = res.tools_used.filter((t) => t.tool === "read_file").length;

  console.log(`\nmodel          ${res.model_id}`);
  console.log(`elapsed        ${elapsedS.toFixed(1)}s   (baseline ${BASELINE_S}s)`);
  console.log(`rounds         ${res.metrics.rounds ?? 1}`);
  printRounds(res.metrics.rounds_detail);
  console.log(`tools used     ${res.tools_used.length} (read_file ${reads})`);
  console.log(`tokens         in ${res.token_usage.inputTokens} / out ${res.token_usage.outputTokens}`);
  console.log(`validation     cleaned=${res.validation.cleaned} issues=[${res.validation.issues.join("; ")}]`);
  console.log(`\n--- reply ---\n${res.reply.trim().slice(0, 1000)}\n--- end ---`);

  // A tool round plus the answer round is the batched shape: five reads inside
  // one round. More rounds than that means the model walked the files one by one
  // and paid for the whole transcript once per file.
  const rounds = res.metrics.rounds ?? 1;
  const checks: Array<[string, boolean]> = [
    ["cloud run", res.instance_id.startsWith("cloud:")],
    ["five reads", reads >= 5],
    ["reads in one round (2 rounds total)", rounds === 2],
    ["faster than the 860 s baseline", elapsedS < BASELINE_S],
    ["non-empty reply", res.reply.trim().length > 0],
    ["round detail present", (res.metrics.rounds_detail?.length ?? 0) === rounds],
  ];
  console.log("");
  for (const [label, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  const ok = checks.every(([, v]) => v);
  console.log(
    ok
      ? `\nGATE PASS — ${rounds} rounds, ${reads} reads, ${elapsedS.toFixed(1)}s vs ${BASELINE_S}s baseline`
      : "\nGATE FAIL",
  );
  if (!ok) process.exitCode = 1;
  deps.close();
}

main().catch((e) => {
  const err = e as { code?: string; message?: string; retryable?: boolean; details?: Record<string, unknown> };
  console.error(`d2 live gate failed: [${err.code ?? "unstructured"}] ${err.message ?? String(e)}`);
  console.error(`  retryable=${err.retryable ?? "?"} details=${JSON.stringify(err.details ?? null)}`);
  process.exitCode = 1;
});
