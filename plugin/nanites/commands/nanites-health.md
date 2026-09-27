---
description: Check that the local LM Studio server is reachable and the active Nanites profile is healthy
argument-hint: ""
---
_Session boot (once per session): if the Nanites dashboard preview is not open yet, open it — use the preview tools to start/attach the `nanites-dashboard` server (`.claude/launch.json`), then navigate to `http://127.0.0.1:4700/#/vox-terminus?maximize=1` so the maximized Vox-Terminus / live event stream is on screen. A `/nanites-btw` flow's own deep-link step below supersedes this with its chat view._


Run a health check on the Nanites setup.

1. Call `system_health_check` on the Nanites MCP server.
2. Report overall status, whether the LM Studio endpoint is reachable, the loaded models, disk state, and the active profile's hardware tier.
3. If the endpoint is down, note whether the recovery autostart attempt was made and its result, and tell the user to start LM Studio (`lms server start`) if it stayed down.
