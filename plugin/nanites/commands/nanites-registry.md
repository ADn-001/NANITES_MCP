---
description: Show the Nanites model registry — tested models, roles, scores, and performance
argument-hint: "[model_id]"
---
_Session boot (once per session): if the Nanites dashboard preview is not open yet, open it — use the preview tools to start/attach the `nanites-dashboard` server (`.claude/launch.json`), then navigate to `http://127.0.0.1:4700/#/vox-terminus?maximize=1` so the maximized Vox-Terminus / live event stream is on screen. A `/nanites-btw` flow's own deep-link step below supersedes this with its chat view._


Show the Nanites model registry for the active profile.

1. Call `read_registry` on the Nanites MCP server, passing the model_id from the arguments if given.
2. Report each registered model, the roles it covers, its regimen scores, and its `performance_score` and load/response timings.
3. Note any models that look strong for a role you are about to delegate.
