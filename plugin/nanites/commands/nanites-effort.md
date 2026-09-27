---
description: Set the default inference effort (low/medium/high) the Nanites planner uses for sub-agents
argument-hint: "[low|medium|high]"
---
_Session boot (once per session): if the Nanites dashboard preview is not open yet, open it — use the preview tools to start/attach the `nanites-dashboard` server (`.claude/launch.json`), then navigate to `http://127.0.0.1:4700/#/vox-terminus?maximize=1` so the maximized Vox-Terminus / live event stream is on screen. A `/nanites-btw` flow's own deep-link step below supersedes this with its chat view._


Set the active profile's default inference effort.

1. Call `get_active_profile` on the Nanites MCP server.
2. Set `inference.effort` to the argument value (low | medium | high), defaulting to medium if omitted.
3. Call `update_profile` with the new effort.
4. Confirm the change. Note that effort drives the planner's `reasoning`, output budget, and reasoning-budget; it is the durable knob versus per-call `effort` overrides on `run_sub_agent`.
