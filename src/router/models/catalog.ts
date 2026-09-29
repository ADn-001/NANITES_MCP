/**
 * The advertised model catalog.
 *
 * `/v1/models` returns ONLY what the user advertised. A harness pings the
 * catalog on connect, and a router that returned its whole consolidated
 * provider list would make that call return hundreds of entries the harness
 * cannot use — and, worse, would fill a UI's model picker with ids the
 * operator never intended to expose.
 *
 * The alias is the point. A published id like
 * `qwen/qwen3.8-27b:free` contains a slash and a colon, and a client that
 * only accepts its own naming convention will reject it. The advertised
 * `nanites-flash` is a name every client accepts.
 */
import type { DatabaseSync } from "node:sqlite";
import { NanitesError } from "../../helpers/errors.js";
import { ProviderModelStore } from "../../storage/providerModelStore.js";
import { nowIso } from "../../storage/db.js";
import { ROUTER_PROFILE } from "../constants.js";
import type { Modality } from "../ir/types.js";

export interface AdvertisedModel {
  /** The harness-safe name. This is what a client sees and sends back. */
  alias: string;
  /** The namespaced id this resolves to. */
  real_id: string;
  provider: string;
  modalities: Modality[];
  context_window: number | null;
  created_at: string;
}

interface AdvertisedRow {
  alias: string;
  real_id: string;
  provider: string;
  modalities: string;
  context_window: number | null;
  created_at: string;
}

function rowToModel(row: AdvertisedRow): AdvertisedModel {
  let mods: unknown;
  try {
    mods = JSON.parse(row.modalities);
  } catch {
    mods = ["text"];
  }
  return {
    alias: row.alias,
    real_id: row.real_id,
    provider: row.provider,
    modalities: Array.isArray(mods) ? (mods as Modality[]) : ["text"],
    context_window: row.context_window === null ? null : Number(row.context_window),
    created_at: row.created_at,
  };
}

export function listAdvertised(db: DatabaseSync): AdvertisedModel[] {
  const rows = db.prepare("SELECT * FROM router_advertised ORDER BY alias").all() as unknown as AdvertisedRow[];
  return rows.map(rowToModel);
}

export function getAdvertised(db: DatabaseSync, alias: string): AdvertisedModel | null {
  const row = db.prepare("SELECT * FROM router_advertised WHERE alias = ?").get(alias) as AdvertisedRow | undefined;
  return row ? rowToModel(row) : null;
}

/**
 * Publish a model under a safe name.
 *
 * The real_id must exist in the catalog, for the same reason chain candidates
 * are validated: a catalog entry pointing at a model nobody discovered is a
 * failure the operator should see now.
 */
export function setAdvertised(db: DatabaseSync, args: {
  alias: string;
  realId: string;
  provider: string;
  modalities?: Modality[];
  contextWindow?: number | null;
}): AdvertisedModel {
  const alias = args.alias.trim();
  if (!alias) {
    throw new NanitesError({ code: "invalid_arguments", message: "An advertised alias is required.", retryable: false });
  }
  // A slash or colon in the advertised name is exactly the problem this feature
  // exists to solve, so refuse one rather than let it become unaddressable.
  if (/[:/\s]/.test(alias)) {
    throw new NanitesError({
      code: "invalid_arguments",
      message: `Advertised alias "${alias}" may not contain a colon, slash, or whitespace.`,
      retryable: false,
      details: { alias },
    });
  }

  const known = new ProviderModelStore(db).getModel(ROUTER_PROFILE, args.provider as never, args.realId);
  if (!known) {
    throw new NanitesError({
      code: "alias_candidate_unknown",
      message: `"${args.realId}" is not in the catalog for provider "${args.provider}". Run discovery first.`,
      retryable: false,
      details: { alias, real_id: args.realId, provider: args.provider },
    });
  }

  const modalities = args.modalities?.length ? args.modalities : (known.supported_modalities as Modality[]) ?? ["text"];
  const contextWindow = args.contextWindow ?? known.context_window ?? null;

  db.prepare(
    `INSERT INTO router_advertised (alias, real_id, provider, modalities, context_window, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (alias) DO UPDATE SET
       real_id = excluded.real_id, provider = excluded.provider,
       modalities = excluded.modalities, context_window = excluded.context_window`,
  ).run(alias, args.realId, args.provider, JSON.stringify(modalities), contextWindow, nowIso());

  return getAdvertised(db, alias)!;
}

export function deleteAdvertised(db: DatabaseSync, alias: string): boolean {
  const result = db.prepare("DELETE FROM router_advertised WHERE alias = ?").run(alias);
  return Number(result.changes) > 0;
}

/* ---------------------------------------------------------------- rendering */

/** The OpenAI `GET /v1/models` shape. */
export function renderOpenAiCatalog(models: AdvertisedModel[]): Record<string, unknown> {
  return {
    object: "list",
    data: models.map((m) => ({
      id: m.alias,
      object: "model",
      // OpenAI clients read `created`; a stable 0 is better than a shifting
      // value that makes the catalog look like it changed on every poll.
      created: 0,
      owned_by: "nanites-router",
      context_length: m.context_window ?? 0,
      capabilities: { modalities: m.modalities },
    })),
  };
}

/** The Anthropic `GET /v1/models` shape. */
export function renderAnthropicCatalog(models: AdvertisedModel[]): Record<string, unknown> {
  return {
    data: models.map((m) => ({
      type: "model",
      id: m.alias,
      display_name: m.alias,
      created_at: m.created_at,
    })),
    has_more: false,
    first_id: models[0]?.alias ?? null,
    last_id: models[models.length - 1]?.alias ?? null,
  };
}

export function renderCatalog(models: AdvertisedModel[], dialect: "anthropic" | "openai"): Record<string, unknown> {
  return dialect === "anthropic" ? renderAnthropicCatalog(models) : renderOpenAiCatalog(models);
}
