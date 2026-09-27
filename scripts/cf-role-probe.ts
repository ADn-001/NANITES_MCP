/**
 * Role probe (see the module header). One live Cloudflare call per pinned role, using the
 * production request shape (`planCloudInference` + `buildCloudChatRequest`) and
 * the role's production tool setting, so we can see — verbatim, before any
 * parser touches it — how each pinned model answers its own task type.
 *
 * The raw `fetch` is deliberate: `client.chat` parses and discards the body, so
 * a leaked tool-call dialect is invisible through the normal path. Tool-capable
 * roles run a two-round mini loop (call -> execute -> re-inject) mirroring
 * `runCloudToolLoop`, because the leaked dialect appears when a tool schema is
 * on the wire. Every round's raw content is recorded, not just the last.
 *
 * Writes role_probe_latest.md.
 *
 * Run: npx tsx scripts/cf-role-probe.ts [profile] [role...]
 */
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { openNanitesDb } from "../src/storage/db.js";
import { ProviderKeyStore } from "../src/storage/providerKeyStore.js";
import { RolePinStore } from "../src/storage/rolePinStore.js";
import { buildCloudChatRequest, planCloudInference } from "../src/providers/cloudPlanner.js";
import { buildFsToolDefs, executeFsTool, type FsGrant } from "../src/providers/fsTools.js";
import { parseChatResponse, serializeChatRequest } from "../src/providers/client.js";
import { buildVisionContent } from "../src/providers/vision.js";
import type { ChatMessage, ChatResponse } from "../src/providers/types.js";
import type { Effort } from "../src/helpers/inferencePlanner.js";

const BASE = "https://api.cloudflare.com/client/v4";
const FS_ROOT = process.env.NANITES_PROBE_FS_ROOT ?? process.cwd();
const MAX_TOOL_ROUNDS = 2;
const TOOL_ROUND_EFFORT: Effort = "low";
const PLAIN_EFFORT: Effort = "medium";
const CLIENT_TIMEOUT_MS = 180_000;
const VERBATIM_CAP = 4_000;

/**
 * A leak captured live on 2026-09-11 (refactorer / gpt-oss-120b, tools on).
 * Kept in the generated doc because the leak is intermittent — the run that
 * regenerates this file can easily miss it, and this is the evidence the F3
 * parser was written against.
 */
const LEAK_OBSERVATION =
  'analysis: need to read file.<|end|><|start|>assistantcommentary to=functions.read_file {"path":" src/providers/fsTools.ts"," limit":4000}<|call|>';

/**
 * A generated 16x16 PNG, as a data URI. Cloudflare refuses images under 10px
 * ("image dimensions must be at least 10px (got 1x1)"), so an embedded 1x1
 * literal is not usable; generating keeps the probe self-contained.
 */
function makePngDataUri(size = 16): string {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed), 0);
    return Buffer.concat([len, typed, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const i = row + 1 + x * 4;
      raw[i] = (x * 255) / (size - 1);
      raw[i + 1] = (y * 255) / (size - 1);
      raw[i + 2] = 128;
      raw[i + 3] = 255;
    }
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

interface ProbeSpec {
  role: string;
  /** Display/record label when it differs from the pinned role (tool-off baseline). */
  label?: string;
  /** The role's production tool setting: fs loop for code roles, tool-less for the rest. */
  tools: boolean;
  brief: string;
  /** Attach the tiny PNG (vision role only — images and tools are mutually exclusive). */
  image?: boolean;
}

const PROBES: ProbeSpec[] = [
  { role: "reviewer", tools: true, brief: "Read src/helpers/cleaner.ts, then report any correctness bug you find with its line number." },
  { role: "code_qa", tools: true, brief: "Read src/providers/fsTools.ts, then list every guard that keeps a tool call inside the grant root." },
  { role: "code_writer", tools: true, brief: "Read src/helpers/errors.ts, then write a short note explaining what a caller should do with a retryable error." },
  { role: "refactorer", tools: true, brief: "Read src/providers/fsTools.ts, then propose one function worth extracting and why." },
  { role: "test_writer", tools: true, brief: "Read test/phase38/plugin.test.ts, then propose one missing assertion for the plugin wrapper." },
  { role: "classifier", tools: false, brief: "Classify the task 'rename a variable across one file' as exactly one of: code_review, refactor, docs." },
  { role: "doc_writer", tools: false, brief: "Write three sentences explaining what a job queue does for a caller." },
  { role: "summarizer", tools: false, brief: "Summarize in three bullets: a tool loop advertises tools, executes the model's calls, and re-injects the results." },
  { role: "extractor", tools: false, brief: "Extract the name and version as JSON: 'nanites 0.0.1 was published by ADn-001'." },
  { role: "commit_writer", tools: false, brief: "Write one conventional-commit subject line for: mask the ntfy token on profile-returning tools." },
  { role: "vision", tools: false, image: true, brief: "Describe this image in one sentence." },
];

interface RoundRecord {
  round: number;
  http: number;
  finish_reason: string | null;
  content: string;
  parsed_calls: number;
  tool_names: string[];
  classification: string;
  note?: string;
}

interface ProbeRecord {
  role: string;
  provider: string;
  model: string;
  tools: boolean;
  effort: Effort;
  rounds: RoundRecord[];
  skipped?: string;
}

/**
 * A leaked call is *the* finding this probe exists for, so the classifier names
 * the dialect rather than collapsing everything to "markup". Anything with
 * angle-bracket tags that is not obviously a sentence lands in `other_markup` —
 * that bucket is how an unknown dialect gets discovered rather than missed.
 */
function classify(content: string, parsedCalls: number): string {
  const text = (content ?? "").trim();
  if (parsedCalls > 0) return "native_tool_call";
  if (!text) return "empty";
  if (/<tool_call>/.test(text)) {
    return /<arg_key>/.test(text) ? "leaked_tool_call:tagged" : "leaked_tool_call:bare";
  }
  if (/<\|(start|channel|call|end|im_start|endoftext)\|>/.test(text)) {
    // gpt-oss harmony: the model puts its call in `content` as
    // `<|start|>assistant<|channel|>commentary to=functions.NAME {json}<|call|>`
    // (or with the channel tag flattened out) and returns finish_reason=stop,
    // so there is no native tool_call to execute and the loop accepts the leak
    // as the final answer. This is the known tool-call-leak defect, observed live.
    return /to=functions\.[A-Za-z_][\w.-]*/.test(text) ? "leaked_tool_call:harmony" : "leaked_template_token";
  }
  // A stray closing/opening think tag with no opening pair means the model's
  // reasoning leaked into content (observed on qwq-32b, at the extractor pin).
  if (/<\/?think>/i.test(text)) return "leaked_think_tag";
  if (/<\/?(function|tool|invoke|parameter)[\s>/]/.test(text)) return "other_markup";
  if (/^[[{]/.test(text)) {
    try {
      JSON.parse(text);
      return "json_answer";
    } catch {
      return "malformed_json";
    }
  }
  return "prose_answer";
}

function contentText(resp: ChatResponse): string {
  return typeof resp.content === "string" ? resp.content : JSON.stringify(resp.content ?? "");
}

async function probeOnce(
  spec: ProbeSpec,
  model: string,
  url: string,
  apiKey: string,
): Promise<ProbeRecord> {
  const effort = spec.tools ? TOOL_ROUND_EFFORT : PLAIN_EFFORT;
  const grant: FsGrant | null = spec.tools ? { root: FS_ROOT, allowed_tools: null } : null;
  const tools = grant ? buildFsToolDefs(grant) : undefined;

  const userContent = spec.image ? buildVisionContent(spec.brief, [makePngDataUri()]) : spec.brief;
  const messages: ChatMessage[] = [{ role: "user", content: userContent }];

  const record: ProbeRecord = {
    role: spec.label ?? spec.role,
    provider: "cloudflare",
    model,
    tools: spec.tools,
    effort,
    rounds: [],
  };

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const advertise = !!tools && tools.length > 0 && round < MAX_TOOL_ROUNDS;
    const plan = planCloudInference(effort, spec.role);
    const req = buildCloudChatRequest(
      plan,
      "cloudflare",
      model,
      messages,
      "You are a precise software analyst.",
      advertise ? tools : undefined,
    );

    const t0 = Date.now();
    let http = 0;
    let raw: unknown = null;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        // Must go through the same wire serialization the clients use: a parsed
        // tool call is flat ({id,name,arguments}) and Cloudflare rejects that
        // shape unless it is rebuilt into OpenAI's {type,function:{...}} form.
        body: JSON.stringify(serializeChatRequest(req)),
        signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
      });
      http = res.status;
      raw = await res.json().catch(() => ({ parse_error: true }));
    } catch (err) {
      record.rounds.push({
        round,
        http: 0,
        finish_reason: null,
        content: "",
        parsed_calls: 0,
        tool_names: [],
        classification: "transport_error",
        note: `${(err as Error).message} after ${Date.now() - t0}ms`,
      });
      return record;
    }

    if (http >= 400) {
      record.rounds.push({
        round,
        http,
        finish_reason: null,
        content: "",
        parsed_calls: 0,
        tool_names: [],
        classification: "http_error",
        note: JSON.stringify(raw).slice(0, 500),
      });
      return record;
    }

    let resp: ChatResponse;
    try {
      resp = parseChatResponse(raw);
    } catch (err) {
      record.rounds.push({
        round,
        http,
        finish_reason: null,
        content: "",
        parsed_calls: 0,
        tool_names: [],
        classification: "unparseable_response",
        note: `${(err as Error).message} | raw=${JSON.stringify(raw).slice(0, 300)}`,
      });
      return record;
    }

    const content = contentText(resp);
    const calls = resp.tool_calls ?? [];
    record.rounds.push({
      round,
      http,
      finish_reason: resp.finish_reason ?? null,
      content,
      parsed_calls: calls.length,
      tool_names: calls.map((c) => c.name),
      classification: classify(content, calls.length),
    });

    if (calls.length === 0 || !grant || round >= MAX_TOOL_ROUNDS) break;

    messages.push({ role: "assistant", content: resp.content ?? "", tool_calls: calls });
    for (const call of calls) {
      const { output } = await executeFsTool(grant, call.name, call.arguments);
      messages.push({ role: "tool", content: output, tool_call_id: call.id, name: call.name });
    }
  }

  return record;
}

function renderDoc(profile: string, records: ProbeRecord[]): string {
  const lines: string[] = [];
  lines.push("# 44 — Cloudflare Role Probe");
  lines.push("");
  lines.push(`Date: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`Profile: \`${profile}\` | generated by \`scripts/cf-role-probe.ts\``);
  lines.push("");
  lines.push("One live call per pinned role with the production request shape, plus a");
  lines.push("two-round tool loop for the tool-capable roles. Raw content is captured");
  lines.push("before any parser runs, so a leaked dialect is visible here even though the");
  lines.push("normal client path would swallow it.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| role | model | tools | round | http | finish | chars | calls | classification |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const r of records) {
    if (r.skipped) {
      lines.push(`| ${r.role} | \`${r.model}\` | ${r.tools} | - | - | - | - | - | skipped: ${r.skipped} |`);
      continue;
    }
    for (const rd of r.rounds) {
      lines.push(
        `| ${r.role} | \`${r.model}\` | ${r.tools} | ${rd.round} | ${rd.http} | ${rd.finish_reason ?? "-"} | ${rd.content.length} | ${rd.parsed_calls} | ${rd.classification} |`,
      );
    }
  }
  lines.push("");
  lines.push("### Leak observations (recorded across runs)");
  lines.push("");
  lines.push("The leaked-call dialect is intermittent: the same role and brief can return a");
  lines.push("native `tool_calls` answer on one run and a leaked call on the next. Captured");
  lines.push("2026-09-11 — `refactorer` / `@cf/openai/gpt-oss-120b`, tools on, round 0,");
  lines.push("`finish_reason=stop`, 0 parsed calls:");
  lines.push("");
  lines.push("```");
  lines.push(LEAK_OBSERVATION);
  lines.push("```");
  lines.push("");
  lines.push("That is the known tool-call-leak defect happening live: there is no `tool_calls` to");
  lines.push("execute, so the loop's accept-any-content branch returned the markup as the");
  lines.push("answer and the job reported `done`. `src/helpers/toolCallLeak.ts` is written");
  lines.push("against this harmony dialect, plus the `<tool_call>` family from the earlier");
  lines.push("job samples.");
  lines.push("");
  lines.push("## Verbatim content");
  lines.push("");
  for (const r of records) {
    if (r.skipped) continue;
    lines.push(`### ${r.role} — \`${r.model}\` (tools ${r.tools ? "on" : "off"}, effort ${r.effort})`);
    lines.push("");
    for (const rd of r.rounds) {
      lines.push(`**round ${rd.round}** — ${rd.classification}, finish \`${rd.finish_reason ?? "-"}\``);
      lines.push("");
      if (rd.note) lines.push(`> note: ${rd.note}`);
      lines.push("```");
      lines.push(rd.content.length > VERBATIM_CAP ? `${rd.content.slice(0, VERBATIM_CAP)}\n[truncated]` : rd.content);
      lines.push("```");
      lines.push("");
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const profile = process.argv[2] ?? "test";
  const wanted = process.argv.slice(3).filter((a) => !a.startsWith("--"));
  const selected = wanted.length > 0 ? PROBES.filter((p) => wanted.includes(p.role)) : PROBES;
  // The tool-capable roles also run tool-less: that separates "this model leaks
  // markup" from "this model leaks markup only when a tool schema is offered".
  const probes: ProbeSpec[] = [
    ...selected,
    ...selected.filter((p) => p.tools).map((p) => ({ ...p, tools: false, label: `${p.role} (no tools)` })),
  ];

  const { db, close } = openNanitesDb();
  const keys = new ProviderKeyStore(db).availableKeys(profile, "cloudflare");
  const pins = new RolePinStore(db);

  if (keys.length === 0) {
    console.error(`No available Cloudflare key for profile ${profile} — aborting.`);
    close();
    process.exitCode = 1;
    return;
  }
  const key = keys[0]!;
  if (!key.account_id) {
    console.error("Key has no account_id — cannot build the endpoint URL. Aborting.");
    close();
    process.exitCode = 1;
    return;
  }
  const url = `${BASE}/accounts/${key.account_id}/ai/v1/chat/completions`;

  const records: ProbeRecord[] = [];
  for (const spec of probes) {
    const pin = pins.get(profile, spec.role);
    if (!pin) {
      records.push({ role: spec.role, provider: "-", model: "-", tools: spec.tools, effort: PLAIN_EFFORT, rounds: [], skipped: "no pin" });
      continue;
    }
    if (pin.provider !== "cloudflare") {
      records.push({ role: spec.role, provider: pin.provider, model: pin.model_id, tools: spec.tools, effort: PLAIN_EFFORT, rounds: [], skipped: `pin is ${pin.provider}, not cloudflare` });
      continue;
    }
    console.log(`\n--- ${spec.role} (${pin.model_id}) tools=${spec.tools}`);
    const rec = await probeOnce(spec, pin.model_id, url, key.api_key);
    for (const rd of rec.rounds) {
      console.log(`  round ${rd.round} http=${rd.http} finish=${rd.finish_reason ?? "-"} calls=${rd.parsed_calls} ${rd.classification}`);
      if (rd.note) console.log(`    note: ${rd.note}`);
      if (rd.content) console.log(`    content: ${JSON.stringify(rd.content.slice(0, 200))}`);
    }
    records.push(rec);
  }

  close();
  const doc = renderDoc(profile, records);
  writeFileSync("role_probe_latest.md", doc, "utf8");
  console.log("\nwrote role_probe_latest.md");
}

main().catch((e) => {
  console.error("probe failed:", (e as Error).message);
  process.exitCode = 1;
});
