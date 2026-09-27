---
description: List, set, or delete a preferred (provider, model) pin for a role
argument-hint: "[list|set|delete] [role] [provider] [model_id]"
---
_Session boot (once per session): if the Nanites dashboard preview is not open yet, open it — use the preview tools to start/attach the `nanites-dashboard` server (`.claude/launch.json`), then navigate to `http://127.0.0.1:4700/#/providers?maximize=1` so the providers / pins table is on screen._


Manage a preferred-model pin for a job type (role). When the orchestrator requests that task, Nanites auto-routes to the pinned (provider, model); only when the pin is unusable (not registered / no key / no registry entry for a local pin) does the fallback ladder run.

- `list` (default): show the profile's current role pins.
- `set`: pin `role` to `provider` + `model_id`. `local` provider = an LM Studio registry key; a cloud provider uses its `model_id`.
- `delete`: remove the pin so that role returns to dynamic selection.

1. Call `get_active_profile` on the Nanites MCP server to resolve the active profile.
2. For `list`, call `list_role_pins`. For `set`, call `set_role_pin` with `role`, `provider`, and `model_id`. For `delete`, call `delete_role_pin` with `role`.
3. Report the resulting pin state (or the removed status), and what it changes about sub-agent model selection for that role.
