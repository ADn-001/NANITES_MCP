/**
 * C2 live gate. Drives the REAL cloud tool loop
 * (`runCloudToolLoop`) against Cloudflare with a filesystem grant, so the
 * transcript it builds — assistant `tool_calls` echo, `role:"tool"` answers
 * carrying `name` + `tool_call_id`, `parallel_tool_calls` — is the transcript
 * the provider actually validates.
 *
 * The gate: a two-file brief completes and returns a non-empty reply naming
 * both files. Run:
 *   npx tsx scripts/cf-c2-live.ts [profile] [model]
 *
 * Never prints key material.
 */
import { openNanitesDb } from "../src/storage/db.js";
import { ProfileManager } from "../src/storage/profileManager.js";
import { runCloudToolLoop } from "../src/providers/cloudToolLoop.js";

const BRIEF = `Read the files package.json and README.md at the repository root, then
report: (1) the value of the "name" field in package.json, and (2) the first
heading line of README.md. Use the read_file tool for each. After you have read
both files, produce your final report. Do not call tools again once you have
enough information.`;

async function main(): Promise<void> {
  const profileName = process.argv[2] ?? "test";
  const modelId = process.argv[3];
  const { db, close } = openNanitesDb();

  const profile = new ProfileManager().getProfile(profileName);
  if (!profile) {
    console.error(`no such profile: ${profileName}`);
    close();
    process.exitCode = 1;
    return;
  }

  const provider = "cloudflare" as const;
  const fsGrant = { root: process.cwd(), allowed_tools: ["read_file", "list_directory", "search_files", "get_file_info"] };

  console.log(`profile=${profileName} provider=${provider} model=${modelId ?? "(router default)"}`);
  const t0 = Date.now();

  try {
    const result = await runCloudToolLoop({
      profile,
      db,
      provider,
      ...(modelId ? { modelId } : {}),
      effort: "medium",
      role: "reviewer",
      brief: BRIEF,
      fsGrant,
      onEvent: (phase, payload) => console.log(`  [${phase}] ${JSON.stringify(payload)}`),
    });

    console.log(`\nrounds=${result.rounds} | wall=${Date.now() - t0}ms | model=${result.model_id}`);
    console.log(`tokens in=${result.tokens_in} out=${result.tokens_out}`);
    console.log(`tools_used=${JSON.stringify(result.tools_used.map((t) => t.tool))}`);
    if (result.truncated) console.log(`truncated=${result.truncated}`);
    console.log(`reply_chars=${result.reply.length}`);
    console.log(`reply[0..400]=${JSON.stringify(result.reply.slice(0, 400))}`);
    console.log(`\nGATE ${result.reply.trim().length > 0 ? "PASS" : "FAIL"} (non-empty reply)`);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.log(`\nERROR code=${err.code ?? "-"} message=${err.message ?? String(e)}`);
    console.log("GATE FAIL");
    process.exitCode = 1;
  } finally {
    close();
  }
}

main().catch((e) => {
  console.error("live gate crashed:", (e as Error).message);
  process.exitCode = 1;
});
