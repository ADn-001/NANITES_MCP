---
description: Bulk-register the canonical Cloudflare agentic models + default role pins for a profile
argument-hint: ""
---
_Session boot (once per session): if the Nanites dashboard preview is not open yet, open it — use the preview tools to start/attach the `nanites-dashboard` server (`.claude/launch.json`), then navigate to `http://127.0.0.1:4700/#/providers?maximize=1` so the providers table is on screen._


Register the canonical Cloudflare agentic models for a profile in one call: catalog registration with each model's manifest capabilities, registry role-tagging (vision models carry the `vision` role), and the default role pins. Idempotent — re-running never duplicates; a custom pin you set is preserved, never overwritten.

1. Call `get_active_profile` on the Nanites MCP server to resolve the active profile (or note the explicit profile name to target).
2. Call `seed_provider_models` with that profile (omit to use the active one). Omit `provider` for the Cloudflare default; omit `model_ids` to seed the full manifest.
3. Report the registered count, the role-tagged registry entries, and which default pins were written vs preserved. An unknown `model_id` is refused before anything is written — never insert a model that is not in the manifest.
