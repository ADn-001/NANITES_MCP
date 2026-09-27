/** Resolve the dashboard port exactly as `ui/server.ts` binds it — the single
 * source for any code that must produce UI URLs (e.g. the `/nanites-btw` deep
 * link). Env override first, else the 4700 default. */
export function configuredUiPort() {
    const raw = Number(process.env.NANITES_UI_PORT ?? process.env.PORT ?? 4700);
    return Number.isFinite(raw) && raw > 0 ? raw : 4700;
}
