/**
 * JSON-file profile manager: CRUD, active-profile pointer, per-field default
 * fallback (§3 of the project instructions). Profiles are small,
 * human-editable, rarely written — hence JSON, not SQLite. All paths derive
 * from NANITES_HOME; nothing is hardcoded.
 *
 * Writes are atomic (temp file + rename) and synchronous, so concurrent
 * callers serialize deterministically with last-write-wins semantics — no
 * torn files, no corruption.
 */
import fs from "node:fs";
import path from "node:path";
import { ensureNanitesHome, type NanitesLayout } from "../config/paths.js";
import { NanitesError } from "../helpers/errors.js";
import {
  resolveProfile,
  profileSchema,
  concurrencyWithOverride,
  validateConcurrencyOverride,
  DEFAULT_DYNAMIC_MODEL,
  DEFAULT_VISION_CAPABLE,
  DEFAULT_TOOLS,
  type CreateProfileInput,
  type Profile,
  type ConcurrencyOverride,
} from "./profileDefaults.js";

const PROFILE_NAME_RE = /^[\w.-]+$/;

/**
 * True when `name` is safe to resolve to a file under the profiles dir.
 *
 * The regex alone is not sufficient: it accepts "." and "..", and
 * `path.join` normalizes those away, so `deleteProfile("../active_profile")`
 * would unlink `<home>/active_profile.json` — the real active-profile pointer,
 * which lives one level above the profiles dir. Reject both spellings
 * explicitly.
 */
function isSafeProfileName(name: string): boolean {
  return PROFILE_NAME_RE.test(name) && name !== "." && name !== "..";
}

export class ProfileManager {
  private readonly layout: NanitesLayout;
  private readonly activeFile: string;

  constructor(home?: string) {
    this.layout = ensureNanitesHome(home);
    this.activeFile = path.join(this.layout.home, "active_profile.json");
  }

  createProfile(input: CreateProfileInput): Profile {
    const name = input.name.trim();
    if (!PROFILE_NAME_RE.test(name)) {
      throw new NanitesError({
        code: "invalid_profile_name",
        message: "Profile name may only contain letters, digits, '_', '.', '-'",
        retryable: false,
      });
    }
    if (fs.existsSync(this.profilePath(name))) {
      throw new NanitesError({
        code: "profile_exists",
        message: `Profile "${name}" already exists`,
        retryable: false,
      });
    }
    const profile = resolveProfile({ ...input, name });
    this.writeProfileFile(profile);
    return profile;
  }

  getProfile(name: string): Profile | null {
    if (!PROFILE_NAME_RE.test(name)) return null;
    const file = this.profilePath(name);
    if (!fs.existsSync(file)) return null;
    return this.readProfileFile(file, name);
  }

  listProfiles(): string[] {
    if (!fs.existsSync(this.layout.profilesDir)) return [];
    return fs
      .readdirSync(this.layout.profilesDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .sort();
  }

  switchProfile(name: string): Profile {
    const profile = this.getProfile(name);
    if (!profile) {
      throw new NanitesError({
        code: "profile_not_found",
        message: `No profile named "${name}"`,
        retryable: false,
      });
    }
    this.writeActive(name);
    return profile;
  }

  getActiveProfile(): Profile | null {
    const name = this.readActive();
    if (!name) return null;
    return this.getProfile(name);
  }

  updateProfile(name: string, patch: CreateProfileInput): Profile {
    const existing = this.getProfile(name);
    if (!existing) {
      throw new NanitesError({
        code: "profile_not_found",
        message: `No profile named "${name}"`,
        retryable: false,
      });
    }
    // Re-resolve: defaults fill anything the patch leaves out, keeping the
    // current stored values for untouched fields.
    const mergedInput: CreateProfileInput = {
      ...existing,
      ...patch,
      machine_specs: { ...existing.machine_specs, ...patch.machine_specs },
      endpoint: { ...existing.endpoint, ...patch.endpoint },
      pricing: { ...existing.pricing, ...patch.pricing },
      ntfy: { ...existing.ntfy, ...patch.ntfy },
      inference: { ...existing.inference, ...patch.inference },
      tools: { ...(existing.tools ?? DEFAULT_TOOLS), ...patch.tools },
    };
    const now = new Date().toISOString();
    const updated: Profile = { ...resolveProfile(mergedInput, now), name, created_at: existing.created_at };
    this.writeProfileFile(updated);
    return updated;
  }

  deleteProfile(name: string): void {
    // Validated here rather than at the HTTP route, so every caller is
    // covered and the traversal cannot be reintroduced by a new route.
    if (!isSafeProfileName(name)) {
      throw new NanitesError({
        code: "invalid_profile_name",
        message: "Profile name may only contain letters, digits, '_', '.', '-'",
        retryable: false,
      });
    }
    if (name === this.readActive()) {
      throw new NanitesError({
        code: "profile_active",
        message: `Cannot delete the active profile "${name}"`,
        retryable: false,
      });
    }
    const file = this.profilePath(name);
    if (!fs.existsSync(file)) {
      throw new NanitesError({
        code: "profile_not_found",
        message: `No profile named "${name}"`,
        retryable: false,
      });
    }
    // Defence in depth: even with a validated name, assert the resolved path
    // is a direct child of the profiles dir before removing anything.
    if (path.dirname(path.resolve(file)) !== path.resolve(this.layout.profilesDir)) {
      throw new NanitesError({
        code: "invalid_profile_name",
        message: "Refusing to delete a path outside the profiles directory",
        retryable: false,
      });
    }
    fs.unlinkSync(file);
  }

  get home(): string {
    return this.layout.home;
  }

  private profilePath(name: string): string {
    return path.join(this.layout.profilesDir, `${name}.json`);
  }

  private writeProfileFile(profile: Profile): void {
    const file = this.profilePath(profile.name);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(profile, null, 2));
    fs.renameSync(tmp, file);
  }

  private readProfileFile(file: string, name: string): Profile {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      throw new NanitesError({
        code: "profile_corrupt",
        message: `Profile "${name}" is not readable JSON`,
        retryable: false,
      });
    }
    const result = profileSchema.safeParse(parsed);
    if (!result.success) {
      throw new NanitesError({
        code: "profile_corrupt",
        message: `Profile "${name}" is missing or malformed required fields`,
        retryable: false,
      });
    }
    // Older profile files predate the dynamic_model field / system_prompt; the
    // schema accepts their absence, so fill the documented defaults on read so
    // callers always see a complete Profile. Concurrency is re-derived from the
    // stored machine specs + a still-valid override, so a hand-edit that moves a
    // profile across VRAM tiers never leaves a stale pair in effect: an override
    // outside the (possibly lowered) tier's allowed set degrades to the tier
    // default rather than bricking the read.
    const data = result.data as Profile;
    const spec = data.machine_specs;
    let override: ConcurrencyOverride | null = data.concurrency_override ?? null;
    if (override && !validateConcurrencyOverride(spec.vram_gb, override).ok) override = null;
    return {
      ...data,
      dynamic_model: data.dynamic_model ?? DEFAULT_DYNAMIC_MODEL,
      vision_capable: data.vision_capable ?? DEFAULT_VISION_CAPABLE,
      tools: data.tools ?? DEFAULT_TOOLS,
      inference: data.inference
        ? { ...data.inference, system_prompt: data.inference.system_prompt ?? null }
        : data.inference,
      concurrency: concurrencyWithOverride(spec, override),
      concurrency_override: override,
    };
  }

  private writeActive(name: string): void {
    const tmp = `${this.activeFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ name }));
    fs.renameSync(tmp, this.activeFile);
  }

  private readActive(): string | null {
    if (!fs.existsSync(this.activeFile)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.activeFile, "utf8")) as { name?: unknown };
      return typeof parsed.name === "string" ? parsed.name : null;
    } catch {
      return null;
    }
  }
}
