---
description: Compact this session into a /nanites-btw working-memory chat and open it in the dashboard
argument-hint: "[profile name] [initial question]"
---
_Session boot (once per session): if the Nanites dashboard preview is not open yet, open it — use the preview tools to start/attach the `nanites-dashboard` server (`.claude/launch.json`), then navigate to `http://127.0.0.1:4700/#/vox-terminus?maximize=1` so the maximized Vox-Terminus / live event stream is on screen. A `/nanites-btw` flow's own deep-link step below supersedes this with its chat view._


Compact this session's working context into a Nanites /nanites-btw chat (btw-spec-v2 §5) so the user can keep talking to it in the dashboard chat mode.

1. Call `get_active_profile` on the Nanites MCP server to resolve the active profile name.
2. Call `start_btw_chat`, passing:
   - `profile` = the resolved active profile name (the argument overrides when given),
   - `messages` = this session's transcript as role/content pairs — each message's actual content, not a summary,
   - `initial_question` = the user's question to the compacted session, when one was given.
3. The result returns `deep_link_url` and `status`. Open `deep_link_url` in the preview pane; the dashboard enters /nanites-btw chat mode. If `status` is `processing`, tell the user the chat is open and warming up — never fabricate an answer the tool did not return inline.
