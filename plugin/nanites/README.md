# Nanites — Claude Code plugin

Slash commands + delegation skill + MCP server for Claude Code, enabling
local LM Studio model delegation. Ships the full Nanites stack: MCP tools,
slash commands, skill, and dashboard UI for settings + provider management.

## What's included

| Component | Location | Role |
|---|---|---|
| MCP server | `dist/index.js` | Drives LM Studio, exposes 53 tools |
| Slash commands | `commands/*.md` | Profile CRUD, health, models, registry |
| Skill | `skills/nanites/SKILL.md` | Delegation judgment calls |
| Dashboard UI | Dashboard at `http://127.0.0.1:4700` | Settings + providers form UI |

## Requires

- **Node.js 22.5+** — the MCP server uses the built-in `node:sqlite`, which
  does not exist on Node 20
- **LM Studio** running locally (Nanites auto-checks health on boot)

## Installation (marketplace)

```bash
claude plugin marketplace add <owner>/<repo>
claude plugin install nanites@nanites
```

The plugin ships its compiled server in `dist/` and its runtime dependencies
in `package.json` / `package-lock.json`, so no build step is required after
install.

## Installation (local development)

```bash
git clone <repo-url>
npm install
npm run build          # from the repo root, not this directory
claude --plugin-dir ./plugin/nanites
```

`npm run build` compiles the server into the repo's `dist/` and copies it to
`plugin/nanites/dist/`, which is what `.mcp.json` launches
(`${CLAUDE_PLUGIN_ROOT}/dist/index.js`). Loading the plugin from a source
checkout without building first leaves the server entry pointing at a missing
file.

Validate a change with:

```bash
claude plugin validate ./plugin/nanites --strict
```

## Dashboard

Most plugin commands open the dashboard at `http://127.0.0.1:4700`. It is
launched on first use; the first run sets `NANITES_HOME` if needed.

Dashboard views:

- `#/vox-terminus` — Live execution stream
- `#/registry` — Tested models + performance scores
- `#/hardware` — Loaded models + concurrency slots
- `#/cost` — Token ledger + cost saved
- `#/health` — Endpoint health
- `#/settings` — Profile CRUD + endpoint/ntfy config
- `#/providers` — Cloud provider key management
- `#/errors` — Provider error log

## Commands

| Command | What it does |
|---|---|
| `/nanites-profiles` | List profiles + active one |
| `/nanites-new-profile` | Create + switch to a profile |
| `/nanites-switch-profile` | Switch to a named profile |
| `/nanites-models` | Available + loaded models |
| `/nanites-registry` | Tested models + scores |
| `/nanites-untested` | Untested models + run sweep |
| `/nanites-cost-saved` | Token usage + cost saved report |
| `/nanites-dynamic-model` | Toggle hot-load vs loaded-pool |
| `/nanites-effort` | Set inference effort level |
| `/nanites-pin` | Pin a role to a preferred model |
| `/nanites-seed-agents` | Bulk-register the canonical cloud agentic models |
| `/nanites-vision` | Delegate an image to a vision-capable model |
| `/nanites-health` | LM Studio reachability + health |
| `/nanites-btw` | Working-memory chat session |

`/nanites-btw` opens a side-conversation with a model mid-task — useful when
you want to ask a question without derailing the main thread.

## Skill

The `nanites` skill covers inference-heavy judgment calls: when to delegate,
which role/model to pick, and how to read registry + judgment results.
