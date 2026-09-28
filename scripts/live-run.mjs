/**
 * Live-run driver: speaks MCP over stdio to the built server, exactly the way
 * a client would, so the run exercises the real tool surface rather than
 * importing internals. Prints one line per tool call with its result summary.
 *
 * The plan is a JSON file describing an ordered list of tool calls:
 *
 *   { "steps": [ { "label": "…", "tool": "run_test_regimen",
 *                   "args": { "profile": "…", "model_id": "…" } } ] }
 *
 * Optional `dump` writes every raw result to that path, `timeoutMs` bounds each
 * call, `width` truncates the printed summary.
 *
 * NANITES_HOME and the profile names come from the caller's environment, so
 * nothing here is tied to one machine. Point it at any profile you have set up:
 *
 *   NANITES_HOME=~/.nanites node scripts/live-run.mjs my-plan.json
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plan = JSON.parse(readFileSync(process.argv[2], "utf8"));

const child = spawn(process.execPath, [path.join(root, "dist", "index.js")], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});

let stdoutBuf = "";
const pending = new Map();
let stderr = "";

child.stdout.on("data", (c) => {
  stdoutBuf += c.toString();
  let idx;
  while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on("data", (c) => { stderr += c.toString(); });

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, plan.timeoutMs ?? 600000);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

/** Compact one-line rendering of a tool result. */
function summarise(res) {
  if (res.error) return "ERROR " + JSON.stringify(res.error).slice(0, 300);
  const c = res.result?.content ?? [];
  const text = c.filter((b) => b.type === "text").map((b) => b.text).join(" ");
  const structured = res.result?.structuredContent;
  const raw = structured ? JSON.stringify(structured) : text;
  return String(raw ?? "").replace(/\s+/g, " ").slice(0, plan.width ?? 600);
}

const out = [];
async function main() {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "live-run", version: "1.0.0" },
  });
  notify("notifications/initialized", {});

  for (const step of plan.steps) {
    if (step.label) process.stderr.write(`\n### ${step.label}\n`);
    const res = await rpc("tools/call", { name: step.tool, arguments: step.args ?? {} });
    const line = summarise(res);
    process.stdout.write(`\n[${step.tool}] ${step.note ?? ""}\n  ${line}\n`);
    out.push({ label: step.label ?? null, tool: step.tool, args: step.args ?? {}, result: line, raw: res.result?.structuredContent ?? null, full: res.result?.content ?? null });
    if (plan.dump) {
      const fs = await import("node:fs");
      fs.writeFileSync(path.join(root, plan.dump), JSON.stringify(out, null, 2));
    }
  }

  child.stdin.end();
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write("\nHARNESS ERROR: " + e.message + "\n");
  process.stderr.write("--- server stderr ---\n" + stderr.slice(-3000) + "\n");
  child.kill();
  process.exit(1);
});
