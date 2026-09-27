---
description: List Nanites profiles and the active one, with their machine specs and settings
argument-hint: ""
---
_Session boot (once per session): if the Nanites dashboard preview is not open yet, open it — use the preview tools to start/attach the `nanites-dashboard` server (`.claude/launch.json`), then navigate to `http://127.0.0.1:4700/#/vox-terminus?maximize=1` so the maximized Vox-Terminus / live event stream is on screen. A `/nanites-btw` flow's own deep-link step below supersedes this with its chat view._


Use the Nanites MCP server tools to report profile state:

1. Call `list_profiles` and `get_active_profile` on the Nanites MCP server.
2. Report every profile name, the active one (clearly flagged), and each profile's machine specs (cpu, gpu, vram_gb, ram_gb, storage), concurrency tier, and `dynamic_model` flag.
3. If none exists, say no profiles are created yet and suggest `/nanites-new-profile`.
