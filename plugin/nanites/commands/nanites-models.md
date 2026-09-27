---
description: List available local models and which is currently loaded in LM Studio
argument-hint: ""
---
_Session boot (once per session): if the Nanites dashboard preview is not open yet, open it — use the preview tools to start/attach the `nanites-dashboard` server (`.claude/launch.json`), then navigate to `http://127.0.0.1:4700/#/vox-terminus?maximize=1` so the maximized Vox-Terminus / live event stream is on screen. A `/nanites-btw` flow's own deep-link step below supersedes this with its chat view._


Show what local models are available and loaded.

1. Call `list_models` and `get_loaded_model` on the Nanites MCP server.
2. Report the available model keys (trimmed list) and clearly flag which one is currently loaded, if any.
3. If nothing is loaded, say so and offer `/nanites-health` if the server might be down.
