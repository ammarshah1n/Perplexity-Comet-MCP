# docs/ — Runbook for when Comet breaks

`cd` here. Start with whichever matches your situation:

- **Something isn't working** → `TROUBLESHOOTING.md` (opinionated, top-to-bottom)
- **You need the map** → `ARCHITECTURE.md` (how `/comet` flows end-to-end)

## What this folder exists for

The Perplexity web UI changes often (the whole reason this MCP needs patching), the chain has many links (slash command → skill → subagent → MCP → CDP → Comet → Perplexity → file), and each link lives in a different location on disk. When something breaks it's rarely obvious which link failed. These two documents tell you:

1. **Which link** owns which responsibility (architecture)
2. **Which symptom** maps to which fix (troubleshooting)

## Most likely thing to break

Perplexity ships UI changes more often than this MCP can track. 90% of the time the fix is:

1. Run the discovery snippet in `TROUBLESHOOTING.md` §1 against the live Perplexity DOM
2. Update the selectors / regex matchers in `src/index.ts` `case "comet_mode":`
3. `npm run build` → restart Claude Code
