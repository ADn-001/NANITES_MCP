# Security Policy

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue. Use
GitHub's **Security → Report a vulnerability** on this repository.

Include: what you did, what you expected, what happened, and the version or commit
you tested. A proof of concept helps a lot.

You can expect an acknowledgement within a few days. Fixes for confirmed issues are
released as quickly as practical, and you are welcome to be credited in the
release notes (or not, if you prefer).

## Scope

In scope: the MCP server, the plugin, the dashboard HTTP server, the cloud-provider
tool loop, and the storage layer.

Out of scope: issues in LM Studio itself, in the upstream models, or in Claude Code.
Also out of scope: running Nanites with `tools.enabled: true` and a shell-granting
MCP integration attached, which is a deliberate, documented capability rather than a
vulnerability.

## Threat model worth understanding

Nanites holds real credentials and can execute real work on your machine, so a few
properties are load-bearing and worth preserving in any patch:

- **The dashboard is loopback-only by default.** Broadcast mode is opt-in, and in
  that mode it is read-only unless the caller presents the per-boot LAN token. The
  token is held in memory, rotates on restart, and is never persisted.
- **Secrets are never returned in the clear.** Profile fields carrying credentials
  are masked for non-loopback callers, and provider keys are projected away from
  every response shape.
- **Mutations require a same-origin request.** Cross-origin writes are rejected, and
  the `Host` header is validated to close DNS rebinding.
- **The cloud filesystem tool loop is confined.** Paths are resolved with `realpath`
  and checked for containment before any read or write.
- **`nanites.db` stores provider API keys in plaintext.** It is created `0600` where
  the OS supports it. This is a known, documented property, not an oversight —
  treat the file as a secret and keep it out of version control and backups you do
  not control.
