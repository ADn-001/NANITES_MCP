/**
 * Per-field default resolution for profiles, per §3 of the project
 * instructions. Resolution order for every omitted field:
 *   explicit value given -> project baseline constant -> hardcoded sane default.
 * Concurrency is derived deterministically from the resolved machine specs via
 * the guardrail advisor (concurrency-hardening, 2026-09-05) unless the profile
 * carries a validated `concurrency_override` (a {max_parallel_models,
 * num_parallel} pair inside the effective tier's allowed set). Forced
 * sequential tiers (<6 / 6-12GB) allow no override — validation rejects it.
 */
import { adviseGuardrails } from "../guardrails/advisor.js";
import type { ConcurrencyPair } from "../guardrails/tiers.js";
import { pairKey, pairAllowedOnTier, allowedPairsForVram } from "../guardrails/tiers.js";
import type { Effort } from "../helpers/inferencePlanner.js";
import type { FsGrant } from "../providers/fsTools.js";
import { NanitesError } from "../helpers/errors.js";
import * as z from "zod/v4";

export interface MachineSpecs {
  cpu: string;
  gpu: string;
  vram_gb: number;
  ram_gb: number;
  storage: string;
}

export interface EndpointConfig {
  url: string;
  auth_token: string | null;
}

export interface PricingConfig {
  input_per_million_usd: number;
  output_per_million_usd: number;
}

export interface NtfyConfig {
  topic: string | null;
  server_url: string;
  access_token: string | null;
}

export interface ConcurrencyConfig {
  mode: "sequential" | "parallel";
  /** Concurrent loaded models / sub-agents (process capacity, first half of the pair). */
  max_parallel_models: number;
  /** Server-side prompt slots per load (LM Studio `parallel`, second half of the pair). */
  num_parallel: number;
}

/**
 * A user-selected concurrency pair overriding the tier-derived default. Only
 * valid when a member of the effective tier's `allowed_pairs` (empty for
 * forced sequential tiers — such an override is rejected with
 * `concurrency_override_invalid`). Mirrors the advisor's allowed-pair shape.
 */
export type ConcurrencyOverride = ConcurrencyPair;

/** Structured rejection for an override outside the effective tier's allowed set. */
export type ConcurrencyOverrideValidation =
  | { ok: true; pair: ConcurrencyOverride }
  | { ok: false; code: "concurrency_override_invalid"; message: string };

export interface InferenceConfig {
  /** Profile-level effort triad; per-call `effort` on run_sub_agent overrides. */
  effort: Effort;
  /** Ceiling the effort fraction scales against (low=1/8, medium=1/2, high=1). */
  output_token_ceiling: number;
  /** Persistent base system prompt layered under every call. */
  system_prompt?: string | null;
  /** Per-request LM Studio idle TTL (seconds) on tool-less single-shot chat.
   * 0 = off (native `/api/v1/chat` + explicit load/teardown — today's
   * behavior). >0 on a dynamic-model profile routes run_sub_agent / btw
   * compaction through `/v1/chat/completions` + `ttl` so LM Studio JIT-keeps
   * the model warm across a queued burst and auto-evicts on queue drain.
   * 30–60 recommended. */
  ttl_s?: number;
}

/**
 * One MCP server attached to a sub-agent chat via the LM Studio `integrations`
 * request param. LM Studio itself runs the tool loop and executes tool calls
 * against the server; nanites declares the integration and — via `allowed_tools`
 * — the allowlist the model may call. `plugin` references a server pre-configured
 * in LM Studio's mcp.json (`id` is `mcp/<server_label>`); `ephemeral_mcp`
 * defines one per-request over HTTP.
 */
export type ToolIntegration =
  | {
      type: "plugin";
      id: string;
      allowed_tools?: string[];
    }
  | {
      type: "ephemeral_mcp";
      server_label: string;
      server_url: string;
      allowed_tools?: string[];
      headers?: Record<string, string>;
    };

export interface ToolsConfig {
  /** Off by default: sub-agents run with no tool access until a profile turns this on. */
  enabled: boolean;
  /** Local (LM Studio) tool loop: external MCP servers executed server-side. */
  integrations: ToolIntegration[];
  /**
   * Cloud-only filesystem grant. LM Studio's external-MCP loop cannot
   * reach a hosted cloud model, so when a cloud sub-agent runs and `enabled` is
   * true with this grant set, Nanites advertises allowlisted file tools and
   * executes the model's calls itself (see src/providers/fsTools.ts). Null or
   * absent = cloud sub-agents are tool-less regardless of `enabled`.
   */
  fs?: FsGrant | null;
}

/** Provider kind enum — local = LM Studio, others = cloud providers. */
export type ProviderKind = "cloudflare" | "openrouter" | "omniroute" | "generic" | "local";

export interface ProviderPrefs {
  cloudflare?: { enabled: boolean };
  openrouter?: { enabled: boolean };
  omniroute?: { enabled: boolean };
  generic?: { enabled: boolean };
  local?: { enabled: boolean };
}

/** Dashboard aesthetic profiles: the e-ink instrument panel, the green
 *  phosphor terminal, and the modern-minimalist look. */
export const DASHBOARD_THEMES = ["retro", "phosphor", "claude"] as const;
export type DashboardTheme = (typeof DASHBOARD_THEMES)[number];

/** Names shipped by earlier builds, mapped forward on read. */
const LEGACY_THEMES: Record<string, DashboardTheme> = {
  cogitator: "phosphor",
  anthropic: "claude",
};
export const dashboardThemeSchema = z.preprocess(
  (v) => (typeof v === "string" ? (LEGACY_THEMES[v] ?? v) : v),
  z.enum(DASHBOARD_THEMES),
);

export interface Profile {
  name: string;
  machine_specs: MachineSpecs;
  endpoint: EndpointConfig;
  use_case: string;
  pricing: PricingConfig;
  test_plan_ref: string | "default" | null;
  ntfy: NtfyConfig;
  concurrency: ConcurrencyConfig;
  /** Persisted user override (validated against the tier's allowed set); null/absent = derived default. */
  concurrency_override?: ConcurrencyOverride | null;
  /** Default inference knobs, overridable per call on run_sub_agent. */
  inference?: InferenceConfig;
  /** When true (default), run_sub_agent hot-loads the best registry match for
   * the role. When false, it uses the currently-loaded LM Studio model pool
   * instead (role-matching registered loaded models, else any loaded model). */
  dynamic_model: boolean;
  /** True when the orchestrator (this Claude) has vision, so image work stays
   * inline. When false (`/nanites-vision`), image analysis is delegated to a
   * vision-capable cloud model. Metadata that steers delegation — never a hard
   * block. */
  vision_capable: boolean;
  /** Dashboard theme, persisted so the choice survives restarts. */
  theme?: DashboardTheme;
  /** Tool-loop grant: which MCP servers a sub-agent may call (see ToolsConfig). */
  tools?: ToolsConfig;
  /** Global provider preference order; local always last. */
  provider_preference_order: ProviderKind[];
  /** Per-provider enable/disable flags. */
  providers: ProviderPrefs;
  created_at: string;
  updated_at: string;
}

/** Partial create input — every field but `name` may be omitted. */
export interface CreateProfileInput {
  name: string;
  machine_specs?: Partial<MachineSpecs>;
  endpoint?: { url?: string; auth_token?: string | null };
  use_case?: string;
  pricing?: { input_per_million_usd?: number; output_per_million_usd?: number };
  test_plan_ref?: string | "default" | null;
  ntfy?: { topic?: string | null; server_url?: string; access_token?: string | null };
  inference?: { effort?: Effort; output_token_ceiling?: number; system_prompt?: string | null; ttl_s?: number };
  dynamic_model?: boolean;
  vision_capable?: boolean;
  theme?: DashboardTheme;
  tools?: ToolsConfig;
  /** Optional concurrency override; validated against the effective tier's allowed set. */
  concurrency_override?: ConcurrencyOverride | null;
  provider_preference_order?: ProviderKind[];
  providers?: ProviderPrefs;
}

/** Hardcoded machine-spec baseline from §1 of the project instructions. */
export const MACHINE_SPEC_BASELINE: MachineSpecs = {
  cpu: "Ryzen 5 5600H",
  gpu: "GTX 1650",
  vram_gb: 4,
  ram_gb: 16,
  storage: "SSD",
};

export const DEFAULT_ENDPOINT_URL = "http://localhost:1234";
export const DEFAULT_USE_CASE = "nanites-default";
export const DEFAULT_TEST_PLAN_REF = "default";
export const DEFAULT_NTFY_SERVER_URL = "https://ntfy.sh";
export const DEFAULT_THEME: DashboardTheme = "retro";
/** Profile-level effort default; the planner scales the token budget off it. */
export const DEFAULT_EFFORT: Effort = "medium";
/** Ceiling the effort fraction scales against: low=1/8, medium=1/2, high=1. */
export const DEFAULT_OUTPUT_TOKEN_CEILING = 8192;
/** Default: hot-load the best registry match. Flip OFF to use the loaded pool. */
export const DEFAULT_DYNAMIC_MODEL = true;
/** Default: the orchestrator has vision, so image work stays inline. Flip OFF (`/nanites-vision`) to delegate image analysis to cloud models. */
export const DEFAULT_VISION_CAPABLE = true;
/** Default tool-loop grant: off, no integrations, no cloud fs grant. Sub-agents run tool-less until a profile opts in. */
export const DEFAULT_TOOLS: ToolsConfig = { enabled: false, integrations: [], fs: null };
/** Default per-request idle TTL: off. Profiles opt in (30–60s sane range). */
export const DEFAULT_TTL_S = 0;
/** Sane bounds for an on-dynamic-model ttl (validated at the zod layer). */
export const TTL_S_MIN = 1;
export const TTL_S_RECOMMENDED = 45;

/**
 * Placeholder pricing. Published Anthropic rates change; per the project
 * instructions this default must be verified against current rates at
 * first-run init and surfaced to the user — never trusted from training data.
 */
export const DEFAULT_PRICING: PricingConfig = {
  input_per_million_usd: 3.0,
  output_per_million_usd: 15.0,
};
export const PRICING_DEFAULT_FLAG =
  "pricing defaults are placeholders — verify against current published Anthropic rates during first-run init";

export function concurrencyFromSpec(spec: MachineSpecs): ConcurrencyConfig {
  const advice = adviseGuardrails({ vram_gb: spec.vram_gb });
  return {
    mode: advice.mode,
    max_parallel_models: advice.max_parallel_models,
    num_parallel: advice.num_parallel,
  };
}

/** A validated override is always non-sequential (forced tiers allow none), but keep the mode derived so the config is self-consistent. */
export function concurrencyConfigFromPair(pair: ConcurrencyPair): ConcurrencyConfig {
  return {
    mode: pair.max_parallel_models === 1 && pair.num_parallel === 1 ? "sequential" : "parallel",
    max_parallel_models: pair.max_parallel_models,
    num_parallel: pair.num_parallel,
  };
}

/** Effective concurrency for a spec + (validated) override; null override degrades to the tier default. */
export function concurrencyWithOverride(spec: MachineSpecs, override: ConcurrencyOverride | null | undefined): ConcurrencyConfig {
  return override ? concurrencyConfigFromPair(override) : concurrencyFromSpec(spec);
}

/**
 * Validate a user-supplied concurrency override against the effective tier
 * (keyed off `vramGb`)'s allowed-pair set. A forced sequential tier allows no
 * override (empty allowed set), so every override there is invalid.
 */
export function validateConcurrencyOverride(
  vramGb: number,
  override: ConcurrencyOverride,
): ConcurrencyOverrideValidation {
  if (!pairAllowedOnTier(vramGb, override)) {
    const allowed = allowedPairsForVram(vramGb);
    return {
      ok: false,
      code: "concurrency_override_invalid",
      message:
        `concurrency pair ${pairKey(override)} is not allowed for vram_gb=${vramGb}` +
        (allowed.length === 0
          ? " (tier is forced sequential — no override permitted)"
          : ` (allowed: ${allowed.map(pairKey).join(", ")})`),
    };
  }
  return { ok: true, pair: override };
}

/**
 * Resolve every optional field against the documented defaults. Write-path only
 * (create/update): an explicit concurrency override is validated against the
 * resolved specs' tier and throws `concurrency_override_invalid` when outside
 * the allowed set (forced sequential tiers allow no override). The resolved
 * `concurrency` is the *effective* pair — override wins over the tier default.
 */
export function resolveProfile(input: CreateProfileInput, now: string = new Date().toISOString()): Profile {
  const machine_specs: MachineSpecs = { ...MACHINE_SPEC_BASELINE, ...input.machine_specs };
  const endpoint: EndpointConfig = { url: DEFAULT_ENDPOINT_URL, auth_token: null, ...input.endpoint };
  const pricing: PricingConfig = { ...DEFAULT_PRICING, ...input.pricing };
  const ntfy: NtfyConfig = {
    topic: null,
    server_url: DEFAULT_NTFY_SERVER_URL,
    access_token: null,
    ...input.ntfy,
  };

  const override = input.concurrency_override ?? null;
  if (override) {
    const verdict = validateConcurrencyOverride(machine_specs.vram_gb, override);
    if (!verdict.ok) {
      throw new NanitesError({ code: verdict.code, message: verdict.message, retryable: false });
    }
  }
  const concurrency = concurrencyWithOverride(machine_specs, override);

  return {
    name: input.name,
    machine_specs,
    endpoint,
    use_case: input.use_case ?? DEFAULT_USE_CASE,
    pricing,
    test_plan_ref: input.test_plan_ref === undefined ? DEFAULT_TEST_PLAN_REF : input.test_plan_ref,
    ntfy,
    concurrency,
    concurrency_override: override,
    inference: {
      effort: input.inference?.effort ?? DEFAULT_EFFORT,
      output_token_ceiling: input.inference?.output_token_ceiling ?? DEFAULT_OUTPUT_TOKEN_CEILING,
      system_prompt: input.inference?.system_prompt ?? null,
      ttl_s: input.inference?.ttl_s ?? DEFAULT_TTL_S,
    },
    dynamic_model: input.dynamic_model ?? DEFAULT_DYNAMIC_MODEL,
    vision_capable: input.vision_capable ?? DEFAULT_VISION_CAPABLE,
    theme: input.theme ?? DEFAULT_THEME,
    tools: input.tools ?? DEFAULT_TOOLS,
    provider_preference_order: input.provider_preference_order ?? ["cloudflare", "openrouter", "omniroute", "generic", "local"],
    providers: input.providers ?? {},
    created_at: now,
    updated_at: now,
  };
}

// ---- validation ----

const machineSpecsSchema = z.object({
  cpu: z.string(),
  gpu: z.string(),
  vram_gb: z.number(),
  ram_gb: z.number(),
  storage: z.string(),
});

const endpointSchema = z.object({
  url: z.string(),
  auth_token: z.string().nullable(),
});

const pricingSchema = z.object({
  input_per_million_usd: z.number(),
  output_per_million_usd: z.number(),
});

const ntfySchema = z.object({
  topic: z.string().nullable(),
  server_url: z.string(),
  access_token: z.string().nullable(),
});

const concurrencySchema = z.object({
  mode: z.enum(["sequential", "parallel"]),
  max_parallel_models: z.number(),
  /** Absent on legacy profile files that predate the concurrency-hardening change. */
  num_parallel: z.number().optional(),
});

/** Persisted override pair, shape-mirrored with the advisor's allowed pairs. */
export const concurrencyOverrideSchema = z
  .object({
    max_parallel_models: z.number().int().positive(),
    num_parallel: z.number().int().positive(),
  })
  .nullable();

const inferenceSchema = z.object({
  effort: z.enum(["low", "medium", "high"]),
  output_token_ceiling: z.number().positive(),
  system_prompt: z.string().nullable().optional(),
  ttl_s: z.number().int().min(0).max(3600).optional(),
});

const toolIntegrationSchema = z.union([
  z.object({
    type: z.literal("plugin"),
    id: z.string(),
    allowed_tools: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("ephemeral_mcp"),
    server_label: z.string(),
    server_url: z.string(),
    allowed_tools: z.array(z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);

const fsGrantSchema = z.object({
  root: z.string().nullable().optional(),
  allowed_tools: z.array(z.string()).nullable().optional(),
});

const toolsSchema = z.object({
  enabled: z.boolean(),
  integrations: z.array(toolIntegrationSchema),
  fs: fsGrantSchema.nullable().optional(),
});

const providerPrefsSchema = z.object({
  cloudflare: z.object({ enabled: z.boolean() }).optional(),
  openrouter: z.object({ enabled: z.boolean() }).optional(),
  omniroute: z.object({ enabled: z.boolean() }).optional(),
  generic: z.object({ enabled: z.boolean() }).optional(),
});

/**
 * Full resolved-profile schema, used to validate a profile file on read so a
 * hand-edited or corrupt file is rejected rather than trusted.
 */
/**
 * Provider kinds, in default preference order. Exported so the HTTP route,
 * the MCP tool, and both profile schemas validate against one list. The list
 * was duplicated inline in two schemas, and the HTTP route cast a body with
 * no validation at all, so a malformed preference_order silently bricked
 * cloud routing.
 */
export const PROVIDER_KINDS = ["cloudflare", "openrouter", "omniroute", "generic", "local"] as const;
export const providerPreferenceOrderSchema = z.array(z.enum(PROVIDER_KINDS));

export type ProviderKindName = (typeof PROVIDER_KINDS)[number];

export const profileSchema = z.object({
  name: z.string(),
  machine_specs: machineSpecsSchema,
  endpoint: endpointSchema,
  use_case: z.string(),
  pricing: pricingSchema,
  test_plan_ref: z.string().nullable(),
  ntfy: ntfySchema,
  concurrency: concurrencySchema,
  concurrency_override: concurrencyOverrideSchema.optional(),
  inference: inferenceSchema.optional(),
  dynamic_model: z.boolean().optional(),
  vision_capable: z.boolean().optional(),
  theme: dashboardThemeSchema.optional(),
  tools: toolsSchema.optional(),
  provider_preference_order: providerPreferenceOrderSchema.optional(),
  providers: providerPrefsSchema.optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

const machineSpecsPatchSchema = z.object({
  cpu: z.string().optional(),
  gpu: z.string().optional(),
  vram_gb: z.number().optional(),
  ram_gb: z.number().optional(),
  storage: z.string().optional(),
});

/**
 * Partial profile-patch schema for `POST /api/settings/profile`. Accepts any
 * subset of fields (per §7 "accept any partial"), but type-checks the ones it
 * gets so a bad value (e.g. `vram_gb: "big"`) is rejected before any write.
 */
export const profilePatchSchema = z.object({
  name: z.string().optional(),
  machine_specs: machineSpecsPatchSchema.optional(),
  endpoint: z
    .object({ url: z.string().optional(), auth_token: z.string().nullable().optional() })
    .optional(),
  use_case: z.string().optional(),
  pricing: z
    .object({ input_per_million_usd: z.number().optional(), output_per_million_usd: z.number().optional() })
    .optional(),
  test_plan_ref: z.string().nullable().optional(),
  ntfy: z
    .object({
      topic: z.string().nullable().optional(),
      server_url: z.string().optional(),
      access_token: z.string().nullable().optional(),
    })
    .optional(),
  inference: z
    .object({
      effort: z.enum(["low", "medium", "high"]).optional(),
      output_token_ceiling: z.number().positive().optional(),
      system_prompt: z.string().nullable().optional(),
      ttl_s: z.number().int().min(0).max(3600).optional(),
    })
    .optional(),
  dynamic_model: z.boolean().optional(),
  vision_capable: z.boolean().optional(),
  theme: dashboardThemeSchema.optional(),
  tools: toolsSchema.optional(),
  concurrency_override: concurrencyOverrideSchema.optional(),
  provider_preference_order: providerPreferenceOrderSchema.optional(),
  providers: providerPrefsSchema.optional(),
});
