/**
 * Dashboard open-planning for toolkit tool results. Pure + stateful halves:
 *
 * - `openPlan(toolName, cfg, seen)` is pure: decides whether a tool call should
 *   ask the host to open the dashboard, at what view, and whether a reload is
 *   needed. Non-mutation tools navigate ONCE per tool kind per process;
 *   mutation tools navigate + reload EVERY call (the page must refetch the data
 *   it just changed — and a reload rebinds the SSE stream to the active profile).
 * - `planOpen` + `resetOpenState` wrap a module-level seen-map so toolkit
 *   handlers need no per-handler state.
 *
 * The host agent performs the actual open: the toolkit decorator attaches
 * `dashboard_url` + `dashboard_action` to the tool result, and CLAUDE.md/SKILL
 * direct the host to navigate the embedded preview pane to it (the /nanites-btw
 * deep-link pattern, generalized). Reloads are forced by a fresh `r` nonce in
 * the hash — the SPA's route handler reloads once when it sees a new one.
 */
import { configuredUiPort } from "../helpers/uiPort.js";

export type UiView = "live" | "registry" | "hardware" | "cost" | "health" | "settings" | "providers" | "errors";

export const VIEW_HASH: Record<UiView, string> = {
  live: "/vox-terminus?maximize=1",
  registry: "/registry",
  hardware: "/hardware",
  cost: "/cost",
  health: "/health",
  settings: "/settings",
  providers: "/providers",
  errors: "/errors",
};

export interface UiPlanConfig {
  view: UiView;
  /** Mutation tools navigate + reload on EVERY call (see header). */
  mutation?: boolean;
}

export interface OpenPlan {
  /** Whether the tool result should carry a dashboard_url at all. */
  navigate: boolean;
  /** Whether the URL carries a fresh `r` nonce that forces an SPA reload. */
  reload: boolean;
  /** The deep link to open (present when `navigate`). */
  url?: string;
}

export function dashboardDeepLink(view: UiView, reload: boolean, now = Date.now()): string {
  const hash = VIEW_HASH[view];
  const separator = hash.includes("?") ? "&" : "?";
  const nonce = reload ? `${separator}r=${now}` : "";
  return `http://127.0.0.1:${configuredUiPort()}/#${hash}${nonce}`;
}

/** Pure decision. `seen` is the set of non-mutation tool kinds already opened. */
export function openPlan(toolName: string, cfg: UiPlanConfig, seen: Set<string>): OpenPlan {
  if (cfg.mutation) {
    seen.add(toolName);
    return { navigate: true, reload: true, url: dashboardDeepLink(cfg.view, true) };
  }
  if (seen.has(toolName)) {
    return { navigate: false, reload: false };
  }
  seen.add(toolName);
  return { navigate: true, reload: false, url: dashboardDeepLink(cfg.view, false) };
}

// Module-level per-process seen-map. Reset between tests via `resetOpenState`.
const openedKinds = new Set<string>();

export function planOpen(toolName: string, cfg: UiPlanConfig): OpenPlan {
  return openPlan(toolName, cfg, openedKinds);
}

export function resetOpenState(): void {
  openedKinds.clear();
}
