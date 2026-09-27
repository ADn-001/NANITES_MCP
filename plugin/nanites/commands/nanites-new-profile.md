---
description: Create and switch to a new Nanites profile for this machine
argument-hint: "[profile name] [vram_gb] [use_case]"
---
_Session boot (once per session): if the Nanites dashboard preview is not open yet, open it — use the preview tools to start/attach the `nanites-dashboard` server (`.claude/launch.json`), then navigate to `http://127.0.0.1:4700/#/vox-terminus?maximize=1` so the maximized Vox-Terminus / live event stream is on screen. A `/nanites-btw` flow's own deep-link step below supersedes this with its chat view._


Create a Nanites profile for the current machine so local-model delegation is tuned correctly.

1. Take the profile name from the arguments, or ask the user for one.
2. Ask the user for the **LM Studio API token** if their server requires one (enabled on the LM Studio Developer page). Pass it as `endpoint.auth_token` on `create_profile`. If the server is token-gated but the user has no token, tell them the profile can instead rely on the `NANITES_LMS_API_TOKEN` env var, or leave `endpoint.auth_token` null and set the env var.
3. Ask the user for an optional **LM Studio endpoint URL** (default `http://localhost:1234`). Pass it as `endpoint.url` on `create_profile`.
4. Call `create_profile` on the Nanites MCP server, passing the name, the machine specs, and `endpoint` (`url` + `auth_token`). Use the user's hardware if given (e.g. vram_gb); otherwise omit specs to use the machine baseline.
5. Call `switch_profile` to make it active.
6. Call `get_active_profile` to confirm, and report the resulting profile plus the guardrail concurrency pair it lands in (forced sequential 1×1 under 12GB VRAM — one sub-agent, one server slot, serialized; parallel pairs from 12GB up — 2×2 high, 4×2 ultra default) and why.
