/**
 * The built-in default test regimen (test_plan_ref: "default"), converted
 * from test_regimen_plan_draft Tasks 1-10 into the §5 schema. Prompt text is
 * verbatim from the draft. Tasks 2 (JSON validity), 7 (exact labels), and 10
 * (exact answers) are deterministic_rule units; everything else is
 * orchestrator_judged with the draft's rubric bullets folded into `rubric`.
 */
import type {
  Difficulty,
  Measure,
  PromptSpec,
  RecommendedConfig,
  ScoringSpec,
  TestUnit,
} from "./schema.js";

export const DEFAULT_TEST_PLAN_REF = "default";

interface UnitInput {
  id: string;
  name: string;
  task_group: string;
  difficulty: Difficulty;
  prompts: PromptSpec[];
  measures: Measure[];
  roles: string[];
  config: RecommendedConfig;
  scoring: ScoringSpec;
}

function u(input: UnitInput): TestUnit {
  return {
    id: input.id,
    name: input.name,
    task_group: input.task_group,
    difficulty: input.difficulty,
    prompts: input.prompts,
    measures: input.measures,
    applicable_roles: input.roles,
    recommended_config: input.config,
    scoring: input.scoring,
    source: "default_regimen",
    version: 1,
  };
}

// ---- Recommended configs (from each task's table in the draft) -----------

const C_T1: RecommendedConfig = { context_length: 8000, kv_cache_quant: "Q8", temperature: 0.2, top_p: 0.9, top_k: 40, repeat_penalty: 1.1, max_output_tokens: 400 };
const C_T2: RecommendedConfig = { context_length: 4000, kv_cache_quant: "Q8", temperature: 0.0, top_p: 1.0, top_k: 1, repeat_penalty: 1.0, max_output_tokens: 200 };
const C_T3: RecommendedConfig = { context_length: 16000, kv_cache_quant: "Q8", temperature: 0.3, top_p: 0.95, top_k: 40, repeat_penalty: 1.05, max_output_tokens: 800 };
const C_T4: RecommendedConfig = { context_length: 4000, kv_cache_quant: "Q8", temperature: 0.1, top_p: 0.9, top_k: 20, repeat_penalty: 1.1, max_output_tokens: 500 };
const C_T5: RecommendedConfig = { context_length: 4000, kv_cache_quant: "Q8", temperature: 0.4, top_p: 0.9, top_k: 40, repeat_penalty: 1.15, max_output_tokens: 60 };
const C_T6: RecommendedConfig = { context_length: 8000, kv_cache_quant: "Q8", temperature: 0.2, top_p: 0.9, top_k: 40, repeat_penalty: 1.1, max_output_tokens: 500 };
const C_T7: RecommendedConfig = { context_length: 2000, kv_cache_quant: "Q4", temperature: 0.0, top_p: 1.0, top_k: 1, repeat_penalty: 1.0, max_output_tokens: 10 };
const C_T8: RecommendedConfig = { context_length: 6000, kv_cache_quant: "Q8", temperature: 0.2, top_p: 0.9, top_k: 40, repeat_penalty: 1.1, max_output_tokens: 300 };
const C_T9: RecommendedConfig = { context_length: 6000, kv_cache_quant: "Q8", temperature: 0.1, top_p: 0.9, top_k: 20, repeat_penalty: 1.05, max_output_tokens: 400 };
const C_T10: RecommendedConfig = { context_length: 2000, kv_cache_quant: "Q8", temperature: 0.0, top_p: 1.0, top_k: 1, repeat_penalty: 1.0, max_output_tokens: 50 };

// ---- Rubrics (folded from each task's rubric bullets in the draft) -------

const R_T1 =
  "Correctness (did it actually understand the code, not just pattern-match keywords). Honesty under 1c (penalize heavily if it hallucinates handling that isn't there). Conciseness (penalize rambling/repetition). Format compliance (did it follow the requested structure).";
const R_T2 =
  "Valid JSON, parseable with no post-processing (binary pass/fail, matters most). Zero extraneous text/fences (how often it leaks prose despite instructions). Field accuracy.";
const R_T3 =
  "Do the tests actually compile/make syntactic sense. Coverage of the specifically requested cases (happy/edge/error). 3c specifically: did it produce a genuinely boundary-testing case, or generic filler tests.";
const R_T4 =
  "Syntactic correctness (would this actually compile). Internal consistency in 4c (do the three outputs agree on field names/types). Unnecessary invention (penalize adding fields/logic that weren't asked for).";
const R_T5 =
  "Format compliance (conventional commit style, length limit). 5c specifically: did it correctly separate concerns rather than blending them into one message.";
const R_T6 =
  "6a: did it catch the off-by-one (<= should be <). 6b: did it catch that forEach doesn't await, so loadAll returns before results are populated. 6c: critical test - did it correctly say 'no bugs,' or did it hallucinate a problem? Models that fail 6c are unreliable as a pre-filter (false positives waste review time worse than false negatives).";
const R_T7 =
  "Format compliance (single label, nothing else - binary pass/fail per response). 7a/7b: correct label. 7c: does it commit to an answer instead of hedging/explaining.";
const R_T8 =
  "Accuracy (does it correctly describe behavior, not just restate the function name). 8b: did it mention the edge case. Conciseness (docs should be tight, not padded).";
const R_T9 =
  "9a/9b: correctness of the transformation, and in 9b specifically whether error handling was preserved exactly. 9c: critical test - did it rename only d, or did it also 'helpfully' rename n? Over-eager models that change more than asked are dangerous for mechanical refactor delegation.";
const R_T10 =
  "10a: exact match, zero extra characters. 10b: critical test - did it fabricate an email rather than saying NONE? This is the single most important failure mode to screen for in any model used for extraction (Task 2) or classification (Task 7), since fabrication instead of admitting 'not found' silently corrupts downstream data.";

// ---- Task 1 prompts (verbatim) -------------------------------------------

const P1A =
  "Summarize what this file does in 3-5 sentences. Then list its public functions/exports with a one-line description of each.\n\n" +
  "interface CacheEntry<V> {\n" +
  "  value: V;\n" +
  "  expiresAt: number;\n" +
  "}\n\n" +
  "export class TTLCache<K, V> {\n" +
  "  private store = new Map<K, CacheEntry<V>>();\n" +
  "  private maxSize: number;\n\n" +
  "  constructor(maxSize: number = 100) {\n" +
  "    this.maxSize = maxSize;\n" +
  "  }\n\n" +
  "  set(key: K, value: V, ttlMs: number): void {\n" +
  "    if (this.store.size >= this.maxSize && !this.store.has(key)) {\n" +
  "      const oldestKey = this.store.keys().next().value;\n" +
  "      if (oldestKey !== undefined) {\n" +
  "        this.store.delete(oldestKey);\n" +
  "      }\n" +
  "    }\n" +
  "    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });\n" +
  "  }\n\n" +
  "  get(key: K): V | undefined {\n" +
  "    const entry = this.store.get(key);\n" +
  "    if (!entry) return undefined;\n" +
  "    if (Date.now() > entry.expiresAt) {\n" +
  "      this.store.delete(key);\n" +
  "      return undefined;\n" +
  "    }\n" +
  "    return entry.value;\n" +
  "  }\n\n" +
  "  has(key: K): boolean {\n" +
  "    return this.get(key) !== undefined;\n" +
  "  }\n\n" +
  "  delete(key: K): boolean {\n" +
  "    return this.store.delete(key);\n" +
  "  }\n\n" +
  "  clear(): void {\n" +
  "    this.store.clear();\n" +
  "  }\n\n" +
  "  get size(): number {\n" +
  "    return this.store.size;\n" +
  "  }\n\n" +
  "  prune(): number {\n" +
  "    const now = Date.now();\n" +
  "    let removed = 0;\n" +
  "    for (const [key, entry] of this.store.entries()) {\n" +
  "      if (now > entry.expiresAt) {\n" +
  "        this.store.delete(key);\n" +
  "        removed++;\n" +
  "      }\n" +
  "    }\n" +
  "    return removed;\n" +
  "  }\n" +
  "}\n\n" +
  "export function memoize<A extends unknown[], R>(\n" +
  "  fn: (...args: A) => R,\n" +
  "  ttlMs: number = 60_000\n" +
  "): (...args: A) => R {\n" +
  "  const cache = new TTLCache<string, R>(500);\n" +
  "  return (...args: A): R => {\n" +
  "    const key = JSON.stringify(args);\n" +
  "    const cached = cache.get(key);\n" +
  "    if (cached !== undefined) return cached;\n" +
  "    const result = fn(...args);\n" +
  "    cache.set(key, result, ttlMs);\n" +
  "    return result;\n" +
  "  };\n" +
  "}";

const P1B =
  "In the code below, where is user authentication actually checked/enforced? Quote the exact function name and a 1-2 sentence explanation. If it is NOT enforced anywhere in this snippet, say so explicitly - do not guess.\n\n" +
  'import type { Request, Response, NextFunction } from "express";\n' +
  'import jwt from "jsonwebtoken";\n\n' +
  'const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";\n\n' +
  "interface AuthedRequest extends Request {\n" +
  "  user?: { id: string; role: string };\n" +
  "}\n\n" +
  "interface JwtPayload {\n" +
  "  sub: string;\n" +
  "  role: string;\n" +
  "  exp: number;\n" +
  "}\n\n" +
  "function extractToken(req: Request): string | null {\n" +
  '  const header = req.headers["authorization"];\n' +
  '  if (!header || typeof header !== "string") return null;\n' +
  '  const [scheme, token] = header.split(" ");\n' +
  '  if (scheme !== "Bearer" || !token) return null;\n' +
  "  return token;\n" +
  "}\n\n" +
  "export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {\n" +
  "  const token = extractToken(req);\n" +
  "  if (!token) {\n" +
  '    res.status(401).json({ error: "Missing bearer token" });\n' +
  "    return;\n" +
  "  }\n" +
  "  try {\n" +
  "    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;\n" +
  "    req.user = { id: payload.sub, role: payload.role };\n" +
  "    next();\n" +
  "  } catch (err) {\n" +
  '    res.status(401).json({ error: "Invalid or expired token" });\n' +
  "  }\n" +
  "}\n\n" +
  "export function requireRole(role: string) {\n" +
  "  return (req: AuthedRequest, res: Response, next: NextFunction): void => {\n" +
  "    if (!req.user) {\n" +
  '      res.status(401).json({ error: "Not authenticated" });\n' +
  "      return;\n" +
  "    }\n" +
  "    if (req.user.role !== role) {\n" +
  '      res.status(403).json({ error: `Requires role: ${role}` });\n' +
  "      return;\n" +
  "    }\n" +
  "    next();\n" +
  "  };\n" +
  "}\n\n" +
  "export function logRequest(req: Request, _res: Response, next: NextFunction): void {\n" +
  "  console.log(`${req.method} ${req.path} at ${new Date().toISOString()}`);\n" +
  "  next();\n" +
  "}\n\n" +
  "export function rateLimiter(maxPerMinute: number) {\n" +
  "  const hits = new Map<string, number[]>();\n" +
  "  return (req: Request, res: Response, next: NextFunction): void => {\n" +
  '    const ip = req.ip || "unknown";\n' +
  "    const now = Date.now();\n" +
  "    const windowStart = now - 60_000;\n" +
  "    const recent = (hits.get(ip) || []).filter((t) => t > windowStart);\n" +
  "    if (recent.length >= maxPerMinute) {\n" +
  '      res.status(429).json({ error: "Rate limit exceeded" });\n' +
  "      return;\n" +
  "    }\n" +
  "    recent.push(now);\n" +
  "    hits.set(ip, recent);\n" +
  "    next();\n" +
  "  };\n" +
  "}\n\n" +
  'export function registerRoutes(app: import("express").Express): void {\n' +
  "  app.use(logRequest);\n\n" +
  '  app.get("/public/status", (_req, res) => {\n' +
  '    res.json({ status: "ok" });\n' +
  "  });\n\n" +
  '  app.get("/api/profile", requireAuth, (req: AuthedRequest, res) => {\n' +
  "    res.json({ id: req.user?.id, role: req.user?.role });\n" +
  "  });\n\n" +
  "  app.post(\n" +
  '    "/api/admin/users",\n' +
  "    requireAuth,\n" +
  '    requireRole("admin"),\n' +
  "    rateLimiter(10),\n" +
  "    (req: AuthedRequest, res) => {\n" +
  "      res.json({ created: true, by: req.user?.id });\n" +
  "    },\n" +
  "  );\n\n" +
  '  app.delete("/api/admin/users/:id", requireAuth, requireRole("admin"), (req, res) => {\n' +
  "    res.json({ deleted: req.params.id });\n" +
  "  });\n" +
  "}";

const P1C =
  "Does this file handle the case where the network request times out? Answer YES or NO first, then justify with a quote from the code. If the answer is NO, do not invent handling that isn't there.\n\n" +
  "export class ApiClient {\n" +
  "  private baseUrl: string;\n" +
  "  private defaultHeaders: Record<string, string>;\n\n" +
  "  constructor(baseUrl: string, apiKey?: string) {\n" +
  "    this.baseUrl = baseUrl;\n" +
  "    this.defaultHeaders = {\n" +
  '      "Content-Type": "application/json",\n' +
  '      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),\n' +
  "    };\n" +
  "  }\n\n" +
  "  async get<T>(path: string): Promise<T> {\n" +
  "    const response = await fetch(`${this.baseUrl}${path}`, {\n" +
  '      method: "GET",\n' +
  "      headers: this.defaultHeaders,\n" +
  "    });\n" +
  "    if (!response.ok) {\n" +
  "      throw new Error(`GET ${path} failed with status ${response.status}`);\n" +
  "    }\n" +
  "    return response.json() as Promise<T>;\n" +
  "  }\n\n" +
  "  async post<T>(path: string, body: unknown): Promise<T> {\n" +
  "    const response = await fetch(`${this.baseUrl}${path}`, {\n" +
  '      method: "POST",\n' +
  "      headers: this.defaultHeaders,\n" +
  "      body: JSON.stringify(body),\n" +
  "    });\n" +
  "    if (!response.ok) {\n" +
  "      throw new Error(`POST ${path} failed with status ${response.status}`);\n" +
  "    }\n" +
  "    return response.json() as Promise<T>;\n" +
  "  }\n\n" +
  "  async retry<T>(fn: () => Promise<T>, attempts: number = 3): Promise<T> {\n" +
  "    let lastError: unknown;\n" +
  "    for (let i = 0; i < attempts; i++) {\n" +
  "      try {\n" +
  "        return await fn();\n" +
  "      } catch (err) {\n" +
  "        lastError = err;\n" +
  "        await new Promise((resolve) => setTimeout(resolve, 2 ** i * 100));\n" +
  "      }\n" +
  "    }\n" +
  "    throw lastError;\n" +
  "  }\n" +
  "}";

// ---- Task 2 prompts (verbatim) -------------------------------------------

const P2A =
  'Extract the following fields from this commit message as JSON with keys "type", "scope", "summary": output ONLY valid JSON, no prose, no markdown fences.\n\n' +
  '"fix(auth): handle expired refresh tokens by forcing re-login instead of silent failure"';

const P2B =
  'Extract as JSON with keys "error_code" (string or null), "file" (string or null), "line" (number or null), "message" (string). Output ONLY valid JSON, no prose, no markdown fences.\n\n' +
  "TypeError: Cannot read properties of undefined (reading 'map')\n" +
  "    at renderList (src/components/List.tsx:42:18)\n" +
  "    at processTicksAndRejections (node:internal/process/task_queues:95:5)";

const P2C =
  'Extract as JSON with keys "name" (string), "age" (number or null). Output ONLY valid JSON, nothing else - no explanation, no markdown code fences, no leading/trailing text of any kind.\n\n' +
  'Text: "Sarah works in marketing. She mentioned she\'s been there since she turned 29, three years ago."';

// ---- Task 3 prompts (verbatim) -------------------------------------------

const P3A =
  "Write unit tests (using vitest/jest syntax) for this function. Cover the happy path, an edge case, and an error case.\n\n" +
  "function bytesToHuman(bytes: number): string {\n" +
  '  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";\n' +
  '  const units = ["B", "KB", "MB", "GB", "TB"];\n' +
  "  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));\n" +
  "  return `${(bytes / 1024 ** i).toFixed(2)} ${units[i]}`;\n" +
  "}";

const P3B =
  "Write unit tests for this function using vitest. Mock the axios call. Cover: success, a 404 response, and a connection-refused error.\n\n" +
  "async function unloadModel(instanceId: string) {\n" +
  "  const client = buildClient(15000);\n" +
  '  const { data } = await client.post("/api/v1/models/unload", { instance_id: instanceId });\n' +
  "  return data;\n" +
  "}";

const P3C =
  "This function truncates text and appends a marker if truncated. Write a test that would FAIL if someone accidentally changed CHARACTER_LIMIT's comparison from `>` to `>=`. Explain in one sentence why that specific test catches the bug.\n\n" +
  "const CHARACTER_LIMIT = 30000;\n" +
  "function truncate(text) {\n" +
  "  if (text.length <= CHARACTER_LIMIT) return { text, truncated: false };\n" +
  '  return { text: text.slice(0, CHARACTER_LIMIT) + "... [truncated]", truncated: true };\n' +
  "}";

// ---- Task 4 prompts (verbatim) -------------------------------------------

const P4A =
  'Generate a TypeScript interface named "UserProfile" from this JSON example, with correct types (infer number/string/boolean/array/nullable appropriately):\n\n' +
  '{ "id": "u_123", "name": "Alex", "age": 34, "email": null, "tags": ["admin", "beta"], "active": true }';

const P4B =
  'Given this existing Zod schema pattern, generate an equivalent schema named "ProductInputSchema" for a product with fields: name (required string), price (positive number), description (optional string, max 500 chars), inStock (boolean, default true).\n\n' +
  "const UserSearchInputSchema = z.object({\n" +
  '  query: z.string().min(2).max(200).describe("Search string"),\n' +
  '  limit: z.number().int().min(1).max(100).default(20).describe("Max results"),\n' +
  "}).strict();";

const P4C =
  'Generate 3 things that must stay consistent with each other: (1) a Zod schema "PetInputSchema" for name (string), species (enum: "dog"|"cat"|"other"), age (number), (2) the TypeScript type inferred from it, (3) a one-line JSDoc-style comment for each field. Output all three, clearly labeled.';

// ---- Task 5 prompts (verbatim) -------------------------------------------

const P5A =
  "Write a conventional-commit style message (type(scope): summary, max 72 chars) for this diff:\n\n" +
  "- Added a null check before calling .map() on the results array in renderList()\n" +
  "- Added a fallback empty-state message when results is empty";

const P5B =
  "Write a conventional-commit message for this diff. Pick the most appropriate type (feat/fix/refactor/chore/docs):\n\n" +
  "- Renamed `getUser` to `fetchUserById` across 4 files\n" +
  "- Updated all call sites\n" +
  "- No behavior change";

const P5C =
  "This diff mixes an unrelated typo fix with a real feature. Write ONE commit message for the feature only, and separately note that the typo fix should probably be its own commit.\n\n" +
  "- Added retry logic (3 attempts, exponential backoff) to the download job poller\n" +
  '- Fixed a typo in an unrelated README section ("recieve" -> "receive")';

// ---- Task 6 prompts (verbatim) -------------------------------------------

const P6A =
  "Review this code for bugs. List each issue found with the line/snippet and why it's a problem.\n\n" +
  "function getAverage(nums) {\n" +
  "  let sum = 0;\n" +
  "  for (let i = 0; i <= nums.length; i++) {\n" +
  "    sum += nums[i];\n" +
  "  }\n" +
  "  return sum / nums.length;\n" +
  "}";

const P6B =
  "Review this code for bugs, focusing on async behavior.\n\n" +
  "async function loadAll(ids) {\n" +
  "  const results = [];\n" +
  "  ids.forEach(async (id) => {\n" +
  "    const data = await fetchItem(id);\n" +
  "    results.push(data);\n" +
  "  });\n" +
  "  return results;\n" +
  "}";

const P6C =
  "Review this code for bugs. If you find none, say so explicitly - do not invent issues just to have something to report.\n\n" +
  "function clamp(value, min, max) {\n" +
  "  return Math.min(Math.max(value, min), max);\n" +
  "}";

// ---- Task 7 prompts (verbatim) -------------------------------------------

const P7A =
  'Classify as exactly one of: BUG, FEATURE, QUESTION, OTHER. Respond with only the label.\n\n"Is there a way to export my data as CSV?"';

const P7B =
  'Classify as exactly one of: BUG, FEATURE, QUESTION, OTHER. Respond with only the label.\n\n"The app crashes every time I click save on a form with more than 10 fields."';

const P7C =
  'Classify as exactly one of: BUG, FEATURE, QUESTION, OTHER. Respond with only the label.\n\n"It would be nice if the app didn\'t crash when I have a lot of fields - right now it just dies."';

// ---- Task 8 prompts (verbatim) -------------------------------------------

const P8A =
  "Add a JSDoc comment above this function documenting params, return type, and behavior:\n\n" +
  "function bytesToHuman(bytes) {\n" +
  '  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";\n' +
  '  const units = ["B", "KB", "MB", "GB", "TB"];\n' +
  "  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));\n" +
  "  return `${(bytes / 1024 ** i).toFixed(2)} ${units[i]}`;\n" +
  "}";

const P8B =
  "Add a JSDoc comment for this function. Make sure to document what happens on invalid input (don't just describe the happy path).\n\n" +
  "function clamp(value, min, max) {\n" +
  "  return Math.min(Math.max(value, min), max);\n" +
  "}";

const P8C =
  'Write a 4-6 sentence "Usage" README section covering both functions below as a pair.\n\n' +
  "function bytesToHuman(bytes) { /* formats byte counts for display */ }\n" +
  "function clamp(value, min, max) { /* restricts a value to a range */ }";

// ---- Task 9 prompts (verbatim) -------------------------------------------

const P9A =
  "Convert this to use async/await instead of .then():\n\n" +
  "function getUser(id) {\n" +
  "  return fetch(`/api/users/${id}`).then(res => res.json()).then(data => data.user);\n" +
  "}";

const P9B =
  "Convert this to async/await. Preserve the exact error handling behavior - do not add or remove any error handling.\n\n" +
  "function getUser(id) {\n" +
  "  return fetch(`/api/users/${id}`)\n" +
  "    .then(res => res.json())\n" +
  '    .catch(err => { console.error("fetch failed", err); return null; });\n' +
  "}";

const P9C =
  "Rename the variable `d` to `elapsedMs` throughout this function. Do NOT change anything else, including the variable `n` even though it's also a bad name.\n\n" +
  "function calc(n, start) {\n" +
  "  const d = Date.now() - start;\n" +
  "  return d / n;\n" +
  "}";

// ---- Task 10 prompts (verbatim) ------------------------------------------

const P10A =
  "Answer with ONLY the number, nothing else - no units, no explanation, not even a period.\n\n" +
  "A file is 7,340,032 bytes. How many whole megabytes is that (1 MB = 1,048,576 bytes)?";

const P10B =
  'You are a data extractor. If the input contains no extractable email address, respond with exactly: NONE\n\n' +
  'Extract the email address from: "Contact us through our website\'s contact form."';

// ---- The 30 units --------------------------------------------------------

export const DEFAULT_REGIMEN: TestUnit[] = [
  // Task 1 — Codebase Q&A / File Summarization
  u({
    id: "task1-codebase-qa-easy",
    name: "Codebase QA / summarization (easy)",
    task_group: "task1_codebase_qa",
    difficulty: "easy",
    prompts: [{ id: "1a", text: P1A, expected: null, notes: null }],
    measures: ["quality", "honesty", "format_compliance", "role_fitness"],
    roles: ["code_qa", "summarizer"],
    config: C_T1,
    scoring: { method: "orchestrator_judged", rubric: R_T1 },
  }),
  u({
    id: "task1-codebase-qa-medium",
    name: "Codebase QA / locate logic (medium)",
    task_group: "task1_codebase_qa",
    difficulty: "medium",
    prompts: [{ id: "1b", text: P1B, expected: null, notes: "Correct answer: requireAuth, applied to /api/profile, the admin POST, and the admin DELETE routes - but NOT to /public/status." }],
    measures: ["quality", "honesty", "format_compliance"],
    roles: ["code_qa", "summarizer"],
    config: C_T1,
    scoring: { method: "orchestrator_judged", rubric: R_T1 },
  }),
  u({
    id: "task1-codebase-qa-hard",
    name: "Codebase QA / cross-reference + honesty (hard)",
    task_group: "task1_codebase_qa",
    difficulty: "hard",
    prompts: [{ id: "1c", text: P1C, expected: null, notes: "Correct answer: NO - fetch is called with no AbortController/signal and no timeout wrapper; retry() retries but never times out a hung request. Watch for models claiming retry() handles timeouts." }],
    measures: ["quality", "honesty", "format_compliance"],
    roles: ["code_qa", "summarizer"],
    config: C_T1,
    scoring: { method: "orchestrator_judged", rubric: R_T1 },
  }),

  // Task 2 — Structured Data Extraction (JSON output) — deterministic
  u({
    id: "task2-extraction-easy",
    name: "Structured extraction / clean structure (easy)",
    task_group: "task2_extraction",
    difficulty: "easy",
    prompts: [{ id: "2a", text: P2A, expected: null, notes: "Expect exactly keys type/scope/summary; pure JSON, no prose." }],
    measures: ["format_compliance", "instruction_following"],
    roles: ["extractor"],
    config: C_T2,
    scoring: {
      method: "deterministic_rule",
      rule: { type: "json_valid", params: {} },
      rubric: R_T2,
    },
  }),
  u({
    id: "task2-extraction-medium",
    name: "Structured extraction / messy input (medium)",
    task_group: "task2_extraction",
    difficulty: "medium",
    prompts: [{ id: "2b", text: P2B, expected: null, notes: "Nullable fields allowed; pure JSON, no prose." }],
    measures: ["format_compliance", "instruction_following"],
    roles: ["extractor"],
    config: C_T2,
    scoring: {
      method: "deterministic_rule",
      rule: { type: "json_valid", params: {} },
      rubric: R_T2,
    },
  }),
  u({
    id: "task2-extraction-hard",
    name: "Structured extraction / adversarial compliance (hard)",
    task_group: "task2_extraction",
    difficulty: "hard",
    prompts: [{ id: "2c", text: P2C, expected: null, notes: "Age inferred as 32 or null, either acceptable; tests pure-JSON output with zero wrapper text." }],
    measures: ["format_compliance", "instruction_following"],
    roles: ["extractor"],
    config: C_T2,
    scoring: {
      method: "deterministic_rule",
      rule: { type: "json_valid", params: {} },
      rubric: R_T2,
    },
  }),

  // Task 3 — Unit Test Generation
  u({
    id: "task3-unit-test-gen-easy",
    name: "Unit test generation / pure function (easy)",
    task_group: "task3_unit_test_gen",
    difficulty: "easy",
    prompts: [{ id: "3a", text: P3A, expected: null, notes: null }],
    measures: ["quality", "format_compliance", "role_fitness"],
    roles: ["test_writer"],
    config: C_T3,
    scoring: { method: "orchestrator_judged", rubric: R_T3 },
  }),
  u({
    id: "task3-unit-test-gen-medium",
    name: "Unit test generation / async+error paths (medium)",
    task_group: "task3_unit_test_gen",
    difficulty: "medium",
    prompts: [{ id: "3b", text: P3B, expected: null, notes: null }],
    measures: ["quality", "format_compliance", "role_fitness"],
    roles: ["test_writer"],
    config: C_T3,
    scoring: { method: "orchestrator_judged", rubric: R_T3 },
  }),
  u({
    id: "task3-unit-test-gen-hard",
    name: "Unit test generation / boundary reasoning (hard)",
    task_group: "task3_unit_test_gen",
    difficulty: "hard",
    prompts: [{ id: "3c", text: P3C, expected: null, notes: null }],
    measures: ["quality", "honesty", "role_fitness"],
    roles: ["test_writer"],
    config: C_T3,
    scoring: { method: "orchestrator_judged", rubric: R_T3 },
  }),

  // Task 4 — Boilerplate / Scaffolding Generation
  u({
    id: "task4-boilerplate-easy",
    name: "Boilerplate / interface from example (easy)",
    task_group: "task4_boilerplate",
    difficulty: "easy",
    prompts: [{ id: "4a", text: P4A, expected: null, notes: null }],
    measures: ["quality", "format_compliance"],
    roles: ["code_writer"],
    config: C_T4,
    scoring: { method: "orchestrator_judged", rubric: R_T4 },
  }),
  u({
    id: "task4-boilerplate-medium",
    name: "Boilerplate / pattern replication (medium)",
    task_group: "task4_boilerplate",
    difficulty: "medium",
    prompts: [{ id: "4b", text: P4B, expected: null, notes: null }],
    measures: ["quality", "format_compliance"],
    roles: ["code_writer"],
    config: C_T4,
    scoring: { method: "orchestrator_judged", rubric: R_T4 },
  }),
  u({
    id: "task4-boilerplate-hard",
    name: "Boilerplate / multi-file consistency (hard)",
    task_group: "task4_boilerplate",
    difficulty: "hard",
    prompts: [{ id: "4c", text: P4C, expected: null, notes: null }],
    measures: ["quality", "format_compliance"],
    roles: ["code_writer"],
    config: C_T4,
    scoring: { method: "orchestrator_judged", rubric: R_T4 },
  }),

  // Task 5 — Commit Message / Changelog Generation
  u({
    id: "task5-commit-msg-easy",
    name: "Commit message / conventional style (easy)",
    task_group: "task5_commit_msg",
    difficulty: "easy",
    prompts: [{ id: "5a", text: P5A, expected: null, notes: null }],
    measures: ["format_compliance", "quality"],
    roles: ["commit_writer"],
    config: C_T5,
    scoring: { method: "orchestrator_judged", rubric: R_T5 },
  }),
  u({
    id: "task5-commit-msg-medium",
    name: "Commit message / infer type from ambiguous diff (medium)",
    task_group: "task5_commit_msg",
    difficulty: "medium",
    prompts: [{ id: "5b", text: P5B, expected: null, notes: null }],
    measures: ["format_compliance", "quality"],
    roles: ["commit_writer"],
    config: C_T5,
    scoring: { method: "orchestrator_judged", rubric: R_T5 },
  }),
  u({
    id: "task5-commit-msg-hard",
    name: "Commit message / separate unrelated changes (hard)",
    task_group: "task5_commit_msg",
    difficulty: "hard",
    prompts: [{ id: "5c", text: P5C, expected: null, notes: null }],
    measures: ["format_compliance", "quality"],
    roles: ["commit_writer"],
    config: C_T5,
    scoring: { method: "orchestrator_judged", rubric: R_T5 },
  }),

  // Task 6 — Code Review / Bug Spotting
  u({
    id: "task6-code-review-easy",
    name: "Code review / planted bug (easy)",
    task_group: "task6_code_review",
    difficulty: "easy",
    prompts: [{ id: "6a", text: P6A, expected: null, notes: "Bug: off-by-one - <= should be <." }],
    measures: ["quality", "role_fitness"],
    roles: ["reviewer"],
    config: C_T6,
    scoring: { method: "orchestrator_judged", rubric: R_T6 },
  }),
  u({
    id: "task6-code-review-medium",
    name: "Code review / subtle async bug (medium)",
    task_group: "task6_code_review",
    difficulty: "medium",
    prompts: [{ id: "6b", text: P6B, expected: null, notes: "Bug: forEach does not await, so loadAll returns before results are populated." }],
    measures: ["quality", "role_fitness"],
    roles: ["reviewer"],
    config: C_T6,
    scoring: { method: "orchestrator_judged", rubric: R_T6 },
  }),
  u({
    id: "task6-code-review-hard",
    name: "Code review / clean code + false-positive test (hard)",
    task_group: "task6_code_review",
    difficulty: "hard",
    prompts: [{ id: "6c", text: P6C, expected: null, notes: "No bugs present - correct answer is 'no bugs'; hallucinating a problem is the failure mode." }],
    measures: ["quality", "honesty", "role_fitness"],
    roles: ["reviewer"],
    config: C_T6,
    scoring: { method: "orchestrator_judged", rubric: R_T6 },
  }),

  // Task 7 — Classification & Routing — deterministic
  u({
    id: "task7-classify-easy",
    name: "Classification / question routing (easy)",
    task_group: "task7_classification",
    difficulty: "easy",
    prompts: [{ id: "7a", text: P7A, expected: "QUESTION", notes: null }],
    measures: ["format_compliance", "instruction_following", "role_fitness"],
    roles: ["classifier"],
    config: C_T7,
    scoring: {
      method: "deterministic_rule",
      rule: { type: "exact_match", params: { expected: "QUESTION" } },
      rubric: R_T7,
    },
  }),
  u({
    id: "task7-classify-medium",
    name: "Classification / bug triage (medium)",
    task_group: "task7_classification",
    difficulty: "medium",
    prompts: [{ id: "7b", text: P7B, expected: "BUG", notes: null }],
    measures: ["format_compliance", "instruction_following", "role_fitness"],
    roles: ["classifier"],
    config: C_T7,
    scoring: {
      method: "deterministic_rule",
      rule: { type: "exact_match", params: { expected: "BUG" } },
      rubric: R_T7,
    },
  }),
  u({
    id: "task7-classify-hard",
    name: "Classification / calibration under ambiguity (hard)",
    task_group: "task7_classification",
    difficulty: "hard",
    prompts: [{ id: "7c", text: P7C, expected: null, notes: "Arguably BUG and FEATURE; any single committed label passes - hedging/explaining is the failure mode." }],
    measures: ["format_compliance", "instruction_following"],
    roles: ["classifier"],
    config: C_T7,
    scoring: {
      method: "deterministic_rule",
      rule: { type: "label_in_set", params: { set: ["BUG", "FEATURE", "QUESTION", "OTHER"] } },
      rubric: R_T7,
    },
  }),

  // Task 8 — Docstring / Documentation Generation
  u({
    id: "task8-docs-easy",
    name: "Docstring / JSDoc from function (easy)",
    task_group: "task8_docs",
    difficulty: "easy",
    prompts: [{ id: "8a", text: P8A, expected: null, notes: null }],
    measures: ["quality", "format_compliance"],
    roles: ["doc_writer"],
    config: C_T8,
    scoring: { method: "orchestrator_judged", rubric: R_T8 },
  }),
  u({
    id: "task8-docs-medium",
    name: "Docstring / document non-obvious edge behavior (medium)",
    task_group: "task8_docs",
    difficulty: "medium",
    prompts: [{ id: "8b", text: P8B, expected: null, notes: "Correct doc notes that if min > max, results may be unintuitive." }],
    measures: ["quality", "honesty"],
    roles: ["doc_writer"],
    config: C_T8,
    scoring: { method: "orchestrator_judged", rubric: R_T8 },
  }),
  u({
    id: "task8-docs-hard",
    name: "Documentation / README section from code (hard)",
    task_group: "task8_docs",
    difficulty: "hard",
    prompts: [{ id: "8c", text: P8C, expected: null, notes: null }],
    measures: ["quality", "format_compliance", "role_fitness"],
    roles: ["doc_writer"],
    config: C_T8,
    scoring: { method: "orchestrator_judged", rubric: R_T8 },
  }),

  // Task 9 — Mechanical Refactoring / Transformation
  u({
    id: "task9-refactor-easy",
    name: "Refactor / promise to async-await (easy)",
    task_group: "task9_refactor",
    difficulty: "easy",
    prompts: [{ id: "9a", text: P9A, expected: null, notes: null }],
    measures: ["quality", "format_compliance", "role_fitness"],
    roles: ["refactorer"],
    config: C_T9,
    scoring: { method: "orchestrator_judged", rubric: R_T9 },
  }),
  u({
    id: "task9-refactor-medium",
    name: "Refactor / preserve error handling (medium)",
    task_group: "task9_refactor",
    difficulty: "medium",
    prompts: [{ id: "9b", text: P9B, expected: null, notes: "Error handling must be preserved exactly." }],
    measures: ["quality", "format_compliance", "role_fitness"],
    roles: ["refactorer"],
    config: C_T9,
    scoring: { method: "orchestrator_judged", rubric: R_T9 },
  }),
  u({
    id: "task9-refactor-hard",
    name: "Refactor / restraint (rename only what was asked) (hard)",
    task_group: "task9_refactor",
    difficulty: "hard",
    prompts: [{ id: "9c", text: P9C, expected: null, notes: "Rename only d; renaming n too is the failure mode." }],
    measures: ["quality", "honesty", "role_fitness"],
    roles: ["refactorer"],
    config: C_T9,
    scoring: { method: "orchestrator_judged", rubric: R_T9 },
  }),

  // Task 10 — Instruction-Following / Output Format Compliance (meta-test) — deterministic
  u({
    id: "task10-format-compliance-easy",
    name: "Format compliance / pure number answer (easy)",
    task_group: "task10_format_compliance",
    difficulty: "easy",
    prompts: [{ id: "10a", text: P10A, expected: "7", notes: "Exact match, zero extra characters." }],
    measures: ["format_compliance", "instruction_following"],
    roles: ["extractor", "classifier", "code_writer", "test_writer", "reviewer", "summarizer", "doc_writer", "refactorer", "commit_writer"],
    config: C_T10,
    scoring: {
      method: "deterministic_rule",
      rule: { type: "exact_match", params: { expected: "7" } },
      rubric: R_T10,
    },
  }),
  u({
    id: "task10-format-compliance-hard",
    name: "Format compliance / refuse-to-fabricate (hard)",
    task_group: "task10_format_compliance",
    difficulty: "hard",
    prompts: [{ id: "10b", text: P10B, expected: "NONE", notes: "Correct answer: NONE - fabricating a fake email is the failure mode." }],
    measures: ["format_compliance", "instruction_following", "honesty"],
    roles: ["extractor", "classifier", "code_writer", "test_writer", "reviewer", "summarizer", "doc_writer", "refactorer", "commit_writer"],
    config: C_T10,
    scoring: {
      method: "deterministic_rule",
      rule: { type: "exact_match", params: { expected: "NONE" } },
      rubric: R_T10,
    },
  }),
];
