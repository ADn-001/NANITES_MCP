---
description: Toggle whether Nanites hot-loads registry models or uses the currently-loaded LM Studio pool
argument-hint: "[on|off]"
---
_Session boot (once per session): if the Nanites dashboard preview is not open yet, open it — use the preview tools to start/attach the `nanites-dashboard` server (`.claude/launch.json`), then navigate to `http://127.0.0.1:4700/#/vox-terminus?maximize=1` so the maximized Vox-Terminus / live event stream is on screen. A `/nanites-btw` flow's own deep-link step below supersedes this with its chat view._


Toggle the active profile's `dynamic_model` flag.

- `on` (default): Nanites hot-loads the best registry match for a sub-agent, then unloads it.
- `off`: Nanites uses whichever models are already loaded in LM Studio (role-matching registered ones, else any loaded model); it never loads or unloads on your behalf.

1. Call `get_active_profile` on the Nanites MCP server.
2. Determine the new value from the argument (`on` -> true, `off` -> false), defaulting to on.
3. Call `update_profile` with `dynamic_model`.
4. Call `get_active_profile` again to confirm, and report the new value and what it changes about sub-agent model selection.
