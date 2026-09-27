---
description: Toggle whether a profile delegates image work to vision-capable models
argument-hint: "[on|off]"
---
_Session boot (once per session): if the Nanites dashboard preview is not open yet, open it — use the preview tools to start/attach the `nanites-dashboard` server (`.claude/launch.json`), then navigate to `http://127.0.0.1:4700/#/settings?maximize=1` so the Settings toggle is on screen._


Flip the active profile's `vision_capable` flag.

- `on` (default): the profile may delegate image analysis to a vision-capable model (the `vision` role pin, else the best registered vision-capable model).
- `off`: the profile does no image work — vision delegation is disabled for it, and image requests should be refused or routed elsewhere.

This is steering metadata for the orchestrator + skill, not a hard block on model capability.

1. Call `get_active_profile` on the Nanites MCP server to resolve the active profile.
2. Determine the new value from the argument (`on` -> true, `off` -> false), defaulting to on.
3. Call `update_profile` with `vision_capable`.
4. Call `get_active_profile` again to confirm, and report the new flag and what it changes about image-work delegation.
