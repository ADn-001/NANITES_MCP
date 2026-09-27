/**
 * Broadcast (global) dashboard setting + helpers. "Global dashboard setting":
 * a single JSON file at <home>/dashboard-settings.json, owned by the UI server
 * (not per-profile), applied on the next dashboard start.
 *
 * Enabling broadcast binds the dashboard to 0.0.0.0 on a free port so another
 * device on the LAN can view it. SECURITY: that also exposes the dashboard to
 * the whole LAN — including /api/health, which returns the active profile's
 * LM Studio API token. The UI must warn when broadcast is on.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import dgram from "node:dgram";
export const BROADCAST_SETTINGS_FILE = "dashboard-settings.json";
export function readDashboardSettings(home) {
    try {
        const raw = fs.readFileSync(path.join(home, BROADCAST_SETTINGS_FILE), "utf8");
        const parsed = JSON.parse(raw);
        return { broadcast: parsed.broadcast === true };
    }
    catch {
        return { broadcast: false };
    }
}
export function writeDashboardSettings(home, settings) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, BROADCAST_SETTINGS_FILE), JSON.stringify({ broadcast: settings.broadcast === true }, null, 2), "utf8");
}
/** A candidate that other LAN devices could plausibly route to. */
function plausibleLanAddress(ip) {
    if (!ip)
        return false;
    const octets = ip.split(".").map(Number);
    const [a, b] = octets;
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255))
        return false;
    // Skip loopback, link-local, and the common VM/virtual NAT ranges (WSL, Docker).
    if (a === 127)
        return false;
    if (a === 169 && b === 254)
        return false;
    if (a === 172 && b !== undefined && b >= 16 && b <= 31)
        return false;
    if (a === 100 && b !== undefined && b >= 64 && b <= 127)
        return false; // CGNAT
    return true;
}
/**
 * Resolve the source IPv4 the OS picks for default-route (internet) traffic.
 * The UDP connect sends no packets; it only makes the stack select a local
 * address for the route, which is the uplink the phone/other LAN devices share.
 */
function defaultRouteIPv4() {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (ip) => {
            if (settled)
                return;
            settled = true;
            try {
                sock.close();
            }
            catch {
                /* already closed */
            }
            resolve(ip);
        };
        const sock = dgram.createSocket("udp4");
        sock.unref();
        sock.on("error", () => finish(null));
        sock.connect(80, "8.8.8.8", () => finish(plausibleLanAddress(sock.address().address) ? sock.address().address : null));
        // Guard: never hang on an unroutable default route.
        const timer = setTimeout(() => finish(null), 1500);
        timer.unref?.();
    });
}
/** First non-internal IPv4 address, or null if none (e.g. offline). */
export async function lanIPv4() {
    // Prefer the default-route source address — iterating interfaces returns the
    // first adapter, which is often a wired/VPN NIC on a different subnet than the
    // phone. Only fall back to a scan when no plausible default route exists.
    const uplink = await defaultRouteIPv4();
    if (uplink)
        return uplink;
    const ifaces = os.networkInterfaces();
    for (const list of Object.values(ifaces)) {
        for (const netAddr of list ?? []) {
            if (netAddr.family === "IPv4" && plausibleLanAddress(netAddr.address))
                return netAddr.address;
        }
    }
    return null;
}
/** Bind `preferred` on 0.0.0.0; if taken, grab an ephemeral free port. */
export function findFreePort(preferred) {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once("error", (err) => {
            if (err.code === "EADDRINUSE") {
                srv.close();
                const srv2 = net.createServer();
                srv2.once("error", reject);
                srv2.listen(0, "0.0.0.0", () => {
                    const p = srv2.address().port;
                    srv2.close(() => resolve(p));
                });
            }
            else {
                reject(err);
            }
        });
        srv.listen(preferred, "0.0.0.0", () => {
            const p = srv.address().port;
            srv.close(() => resolve(p));
        });
    });
}
/**
 * Project what the dashboard would bind to given the persisted setting.
 * `preferred` is the configured port (NANITES_UI_PORT / PORT / 4700). When
 * broadcast is on, we resolve an actually-free port now so the projected URL
 * is realistic; the real bind happens on next dashboard start.
 */
export async function projectBroadcast(home, preferred) {
    const { broadcast } = readDashboardSettings(home);
    if (!broadcast) {
        return { enabled: false, host: "127.0.0.1", port: preferred, url: null };
    }
    const port = await findFreePort(preferred);
    const ip = await lanIPv4();
    return {
        enabled: true,
        host: "0.0.0.0",
        port,
        url: ip ? `http://${ip}:${port}` : null,
    };
}
