/**
 * Capability population for Cloudflare models.
 *
 * `/ai/models/search` publishes pricing but not a usable modality map, so the
 * capability columns would otherwise stay empty — and R5a's planner treats an
 * unknown modality as "not a candidate", which would make every image and
 * audio model invisible.
 *
 * Only models that discovery actually FOUND are written. A model Cloudflare
 * has dropped does not keep its flags, so the catalog cannot advertise a
 * capability for something that no longer answers.
 */
import type { DatabaseSync } from "node:sqlite";
import { ProviderModelStore } from "../../../storage/providerModelStore.js";
import { ROUTER_PROFILE } from "../../constants.js";
import { CF_MODELS, cfInputModalities, cfOutputModalities } from "./catalog.js";

export function applyCfCapabilities(db: DatabaseSync): number {
  const store = new ProviderModelStore(db);
  const present = new Set(store.listModels(ROUTER_PROFILE, "cloudflare").map((m) => m.model_id));
  let written = 0;

  for (const def of CF_MODELS) {
    if (!present.has(def.id)) continue;
    const existing = store.getModel(ROUTER_PROFILE, "cloudflare", def.id);
    if (!existing) continue;

    // The OUTPUT modalities are what a caller can ask this model to produce.
    // A model that emits nothing this router understands is not advertised.
    const outputs = cfOutputModalities(def);
    if (outputs.length === 0) continue;

    store.updateModalities(ROUTER_PROFILE, "cloudflare", def.id, outputs, {
      vision: cfInputModalities(def).includes("image"),
      audio: cfInputModalities(def).includes("audio"),
      video: false,
      function_calling: def.category === "text-generation",
    });
    written++;
  }
  return written;
}
