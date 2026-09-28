# Phase R7 — Transport and Exposure

**Goal:** direct port listening (done in R0) plus opt-in cloudflared tunnelling, with the
security posture that a real inference endpoint with spend behind it requires.

**Depends on:** R0, R4.
**Deliberately small.** Tunnelling is a shell-out, not a protocol.

---

## What is being built

```
cloudflared tunnel --url http://localhost:4800
```

Quick Tunnels need no Cloudflare account and no config file. Cloudflare assigns a
`https://random-words.trycloudflare.com` URL and prints it to stderr. The lifecycle is
start / show URL / stop.

**Explicitly out of scope:** named tunnels, DNS records, ingress rules, Cloudflare Access, any
`config.yml`. If a user needs those, they should run cloudflared themselves and point
`NANITES_ROUTER_BIND` at the result.

---

## Why this phase exists at all

The existing dashboard has a broadcast mode that rebinds `127.0.0.1` → `0.0.0.0` with a per-boot
token, and it warns. That model is **not** appropriate here, and the difference is worth stating
plainly rather than reusing the pattern:

| | Dashboard broadcast | Router tunnelled |
|---|---|---|
| Exposes | registry, ledger, profile edits | a working inference endpoint |
| Behind it | local LM Studio | real provider accounts |
| Risk of misuse | reading the user's own data | spending the user's money |
| Exposure | trusted LAN | the public internet |

So: **no broadcast on the router by default, ever.** Tunnelling is explicit, logs a warning, and
is visible in the dashboard and in `/v1/health`.

---

## Implementation directions

### R7.1 — Tunnel supervisor

`src/router/transport/tunnel.ts`:

```ts
export interface TunnelState {
  enabled: boolean;
  running: boolean;
  url: string | null;
  pid: number | null;
  last_error: string | null;
  started_at: string | null;
}
```

- Spawn `cloudflared` detached, capture stderr.
- Parse the assigned hostname from stderr. **Probe before parse** — run it once and read the
  actual output rather than assuming the format. The URL is emitted on a line containing
  `trycloudflare.com`.
- Poll until the URL appears, with a bounded timeout. If `cloudflared` is not on PATH, report
  `cloudflared_not_found` with the install hint — do not fail the router.
- Persist state in `router_config` (`tunnel_enabled`, `tunnel_url`) so a restart can clean up an
  orphaned process, matching the repo's existing stale-dashboard-kill pattern.
- Stop: SIGTERM, then SIGKILL after a grace period. Verify the process is actually gone.

### R7.2 — Health exposure

`GET /v1/health` gains tunnel state. `nanites_router_config` reports it. The dashboard's Router tab
shows the URL with a copy button and a clear "your API key is the only thing protecting this"
warning whenever the tunnel is live.

The warning is not decoration. A public inference endpoint with a leaked key is a billing
incident.

### R7.3 — Bind and exposure control

- `NANITES_ROUTER_BIND` defaults to `127.0.0.1`.
- `0.0.0.0` is honoured, logs a warning, and sets a `broadcast` flag in `/v1/health` that the UI
  surfaces. It is not blocked — a user on a trusted network may want it — but it is never silent.
- With a tunnel running, the warning escalates.

### R7.4 — Rate limiting

A tunnelled endpoint is internet-facing, and the virtual key is the only defence. Add a
**per-virtual-key** request rate limit: a token bucket in memory, default 60 requests/minute,
configurable. Exceeding it returns 429 in the caller's dialect.

This is deliberately not the multi-tenant quota system that was ruled out of scope. It is one
bucket, defending one key, against a script. `nanites_addProviderKey` already validates
`gateway_url` through `outboundUrlSchema`; the router applies the same guard to every outbound
call so a tunnelled router cannot be used as an SSRF proxy into the operator's LAN.

### R7.5 — Key hygiene

- The virtual key is never logged, at any level, including debug.
- Startup prints it exactly once when auto-generated.
- `/v1/keys` and `/v1/health` return `key_present: true`, never the key.
- If the tunnel is enabled, the startup banner repeats the key requirement.

---

## E2E test plan

`test/phaseR7/transport.test.ts`

1. **Default bind** — the server listens on `127.0.0.1` and is **not** reachable from a
   non-loopback local address. Assert with an actual connection attempt to the host's LAN
   address, not by reading the config.
2. **Explicit `0.0.0.0`** — reachable, `/v1/health` reports `broadcast: true`, and the warning is
   logged. Assert on the log, not just the flag.
3. **Rate limit** — 100 requests against a 60/min limit: the first 60 succeed, the 61st is 429 in
   the correct dialect shape. With a fake clock, not a sleep.
4. **Rate limit is per key** — with two virtual keys configured in a test fixture, one key's
   traffic does not exhaust the other's bucket.
5. **Tunnel absent** — with `cloudflared` not on PATH, enabling the tunnel reports
   `cloudflared_not_found` and the router keeps serving normally. **The router must not die
   because a tunnel failed to start.**
6. **Tunnel lifecycle** — with a fake `cloudflared` (a script that prints a URL to stderr and
   sleeps), start → URL is parsed and surfaced → stop → the process is gone. Assert with
   `process.kill(pid, 0)` throwing.
7. **Orphan cleanup** — persist `tunnel_enabled` with a stale pid, restart, assert the stale
   process is killed and the state reset.
8. **Malformed cloudflared output** — a fake that prints nothing useful. Times out with a clear
   error; no hang.
9. **No key leakage** — assert the virtual key does not appear in: the startup log, `/v1/health`,
   `/v1/keys`, the error responses, or the tunnel state.
10. **SSRF guard on outbound** — a request naming a model on a `generic` provider whose
    `gateway_url` is `http://169.254.169.254/latest/meta-data/` is rejected. Assert the metadata
    endpoint was never contacted. (Reuse `assertOutboundUrl`.)
11. **Tunnel + auth together** — with the tunnel "live", an unauthenticated request is still 401.
    A tunnel does not bypass auth.

**Non-vacuity.** Test 1 and test 11 both pass trivially if the server is unreachable for the wrong
reason (e.g. it never started). Each needs a positive control: the same request **with** auth on
the expected bind must succeed.

---

## Success criteria

- The router binds loopback by default and says so.
- `0.0.0.0` works, warns, and is visible in health.
- A cloudflared quick tunnel starts on demand, surfaces its URL, and stops cleanly.
- A missing or broken `cloudflared` never takes the router down.
- Rate limiting protects a tunnelled endpoint.
- The virtual key appears in no log, no health response, and no error body.
- Outbound calls pass the SSRF guard, so a tunnelled router cannot reach the operator's LAN.
- The existing suite is green and unchanged.
