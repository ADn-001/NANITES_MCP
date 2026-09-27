---
description: Report tokens used and estimated cost saved by offloading work to local models
argument-hint: "[all|day|week|month]"
---
_Session boot (once per session): if the Nanites dashboard preview is not open yet, open it — use the preview tools to start/attach the `nanites-dashboard` server (`.claude/launch.json`), then navigate to `http://127.0.0.1:4700/#/vox-terminus?maximize=1` so the maximized Vox-Terminus / live event stream is on screen. A `/nanites-btw` flow's own deep-link step below supersedes this with its chat view._


Report the cost saved by delegating sub-agent work to local models.

1. Call `get_active_profile` on the Nanites MCP server to resolve the active profile.
2. Call `get_cost_saved_report` on the Nanites MCP server, passing the active profile's name and the period from the arguments (one of `all` | `day` | `week` | `month`; default `all`).
3. Report total input/output tokens, estimated USD cost avoided vs frontier-model pricing, and the number of sub-agent runs that fed the report.
4. Keep it to a concise ledger-style summary.
