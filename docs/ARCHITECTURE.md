# Architecture — How a `/comet` query flows end-to-end

This is your map. When something breaks, use this to figure out which link in the chain failed, then go to `docs/TROUBLESHOOTING.md` for the fix.

## The chain

```
Ammar types "/comet <query>"           (or natural language like "deep research X")
  │
  ▼
Claude Code main session                (reads ~/.claude/commands/comet.md)
  │ classifies mode / model / Space / focus per ~/.claude/skills/comet/SKILL.md
  │
  ▼
Agent tool (subagent_type=general-purpose)
  │ receives a brief with prompt + mode + output contract
  │
  ▼
perplexity-comet MCP                    (this repo → dist/index.js)
  │ spawned by Claude Code per ~/.claude.json mcpServers.perplexity-comet
  │
  ▼ CDP over ws://localhost:9223/devtools/browser/...
Comet browser                           (/Applications/Comet.app, started with --remote-debugging-port=9223)
  │ loads perplexity.ai, clicks the "+" popover, selects Deep Research, types prompt, submits
  │
  ▼
Perplexity.ai                           (Feb 2026 UI — modes behind "+" panel)
  │
  ▼ response streams back, status polled via comet-ai.ts getAgentStatus
Subagent captures full text
  │ writes to ~/Downloads/comet-reports/<ISO>-<slug>.md with YAML frontmatter
  │
  ▼
Main session                            (receives ONLY {report_path, headline, mode_used})
  │
  ▼
Ammar                                   (sees: headline + path; opens file if he wants content)
```

## Where each piece lives

| Piece | Path |
|---|---|
| Slash command | `~/.claude/commands/comet.md` |
| Skill (routing logic + subagent brief) | `~/.claude/skills/comet/SKILL.md` |
| Capability reference | `~/.claude/docs/perplexity-comet-capabilities.md` |
| Global CLAUDE.md rule (auto-routes any research query) | `~/CLAUDE.md` → Tool Dispatch item #1 |
| MCP server source | `./src/` (index.ts, comet-ai.ts, cdp-client.ts, types.ts) |
| MCP server compiled | `./dist/index.js` |
| MCP server config | `~/.claude.json` → `mcpServers.perplexity-comet` |
| Local checkout | `/Users/integrale/code/perplexity-comet-mcp` |
| Git remotes | `origin` = `RapierCraft/perplexity-comet-mcp` (upstream), `ammarshah1n` = `ammarshah1n/Perplexity-Comet-MCP` (Ammar's fork, push here) |
| Report outputs | `~/Downloads/comet-reports/` |

## The MCP tool surface (current)

| Tool | What it does |
|---|---|
| `comet_connect` | Verify / start Comet with debug port 9223, connect CDP |
| `comet_ask` | Send a prompt, block until done (default 2 min timeout). Supports `deepResearch: true` to flip mode + bump timeout to 5 min |
| `comet_poll` | Check status of a running task (for long-running tasks fired then polled) |
| `comet_stop` | Abort the current task |
| `comet_screenshot` | Capture PNG of current page |
| `comet_tabs` | List / switch / close browser tabs |
| `comet_mode` | Switch mode — handles Feb 2026 "+" popover UI, matches renamed labels |
| `comet_connectors` | Toggle YouTube / Reddit / Academic / GitHub / etc. connectors |
| `comet_deep_research` | One-shot: flip to Deep Research, send prompt, poll to completion (5 min default) |
| `comet_upload` | Upload a file to the composer |

## Critical assumptions (break these and the whole chain fails)

1. **Comet installed** at `/Applications/Comet.app`. The MCP tries to auto-start it.
2. **Debug port 9223 not taken** by another Chrome-family browser. If Chrome is running with `--remote-debugging-port=9223`, the MCP will attach to the wrong browser.
3. **Perplexity DOM shape**. Most fragile link. Selectors assume `[contenteditable="true"]` input, `[class*="prose"]` response containers, and the "+" popover for mode selection. See `docs/TROUBLESHOOTING.md` → "Perplexity changed its UI again".
4. **~/.claude.json mcpServers.perplexity-comet.args[0]** points at `./dist/index.js`. If the path moves, the server won't load.
5. **The main session never calls `mcp__perplexity-comet__*` tools directly.** If it does, the output floods context. Enforcement is prompt-level (in SKILL.md) — there's no hook that blocks it. If you notice the rule being violated, tighten the SKILL.md with stronger language.
