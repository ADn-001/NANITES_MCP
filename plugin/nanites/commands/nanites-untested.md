---
description: Show models that have not been tested yet and run the untested-model sweep
argument-hint: "[run]"
---
_Session boot (once per session): if the Nanites dashboard preview is not open yet, open it — use the preview tools to start/attach the `nanites-dashboard` server (`.claude/launch.json`), then navigate to `http://127.0.0.1:4700/#/vox-terminus?maximize=1` so the maximized Vox-Terminus / live event stream is on screen. A `/nanites-btw` flow's own deep-link step below supersedes this with its chat view._


Handle untested models in the Nanites registry.

1. Call `diff_untested` on the Nanites MCP server to list registered-but-untested models (or candidate models with no scores).
2. If the argument is `run` (or the user confirms), call `run_untested_sweep` to test them.
3. Report which models were untested and, if run, which now have results awaiting judgment.
