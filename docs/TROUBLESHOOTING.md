# Troubleshooting — When Comet breaks

Opinionated playbook. Follow top-to-bottom. Most breakage is one of these five symptoms.

---

## 0. First thing to do, always

```bash
cd /Users/integrale/code/perplexity-comet-mcp
git status                                  # any uncommitted local patches?
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:9223/json/version
                                            # 200 = Comet debug port reachable; non-200 = Comet not started or wrong port
node dist/index.js < /dev/null 2>&1 | head -5
                                            # should print nothing and exit cleanly — if it throws on startup, the MCP is busted
```

Then restart Claude Code so the freshly built `dist/` loads. The MCP is spawned once per Claude Code session and pinned.

---

## 1. `/comet` returns an empty response or times out

**Most common cause:** Perplexity changed its DOM. `comet_mode` is clicking the wrong thing or finding nothing, and the prompt gets sent in the wrong mode (or not at all).

**Diagnose.** Open Comet manually, navigate to `https://www.perplexity.ai/`, then in a terminal:

```bash
# Replace <PAGE_ID> with the id of the Perplexity tab from /json/list
curl -s http://localhost:9223/json/list | jq '.[] | select(.url | contains("perplexity.ai")) | .id'
```

Then open Chrome DevTools against that tab (or just run the discovery snippet via the MCP's `comet_screenshot` then `evaluate` path) and paste this in the console:

```js
(() => {
  const out = { buttons: [] };
  const input = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
  if (!input) return { error: 'no input element' };
  let p = input.parentElement;
  for (let i = 0; i < 8 && p; i++) {
    for (const btn of p.querySelectorAll('button')) {
      if (btn.offsetParent === null) continue;
      out.buttons.push({
        text: btn.innerText.trim().slice(0, 30),
        aria: btn.getAttribute('aria-label') || '',
        testId: btn.getAttribute('data-testid') || '',
      });
    }
    p = p.parentElement;
  }
  return out;
})();
```

The output lists every visible button near the input. Find the "+" / attach / options button and the mode menu items; update the selectors in `src/index.ts` `case "comet_mode":` (MENU_SELS array + the regex matchers).

**Fix.** Edit `src/index.ts`, run `npm run build`, restart Claude Code.

---

## 2. `comet_connect` fails with "Failed to connect to Comet browser"

**Cause:** Comet isn't running on port 9223, OR another process (Chrome, Edge) grabbed the port, OR Comet's CDP endpoint moved.

**Diagnose.**

```bash
lsof -iTCP:9223 -sTCP:LISTEN                 # which process owns the port?
ps aux | grep -i comet                       # is Comet even running?
ls /Applications/Comet.app                   # installed?
```

**Fix.**

- If port taken by Chrome: quit Chrome, or relaunch Comet on a different port (would require editing `cdp-client.ts` where it hardcodes 9223 — not recommended, just quit Chrome).
- If Comet isn't running: `open -a Comet --args --remote-debugging-port=9223` then retry.
- If Comet isn't installed: download from perplexity.ai/comet.

---

## 3. Deep Research "completes" immediately with a thin one-line answer

**Cause:** `comet_mode` didn't actually switch to Research — the prompt got submitted in Search mode.

**Diagnose.** Before firing the query, open Comet manually, go to perplexity.ai, and check whether the "+" popover contains a "Deep research" option at all (it may be renamed again). Also check whether an already-checked mode indicator appears in the composer.

**Fix.**

1. Run the discovery snippet from §1 to see current mode labels.
2. Update the `matchers` regex in `src/index.ts` `case "comet_mode":` — currently:
   ```ts
   'research': /^(deep\s*research|research)$/i
   ```
   Extend it with whatever Perplexity renamed "Deep research" to.
3. `npm run build` → restart Claude Code.

---

## 4. Main session outputs the full Comet report inline instead of just a path

**Cause:** The skill's subagent-only contract was violated. The main session called `mcp__perplexity-comet__*` directly.

**Diagnose.** Look at the recent Claude Code transcript. If you see an `mcp__perplexity-comet__comet_*` tool call in the main session (not inside an Agent block), the contract broke.

**Fix.** Tighten `~/.claude/skills/comet/SKILL.md` STEP 0 — make the BLOCKING notice more emphatic, or add a worked example showing the Agent dispatch. There is no hook that enforces this; it's prompt-level only.

---

## 5. Claude doesn't see the new tool shape after I rebuilt

**Cause:** The MCP server is spawned once per Claude Code session. `dist/` changes don't hot-reload.

**Fix.** Restart Claude Code (quit fully, relaunch). Then verify by asking Claude to list `mcp__perplexity-comet__*` tool names — `comet_deep_research`, `comet_connectors`, and `comet_ask` with `deepResearch` param must be present.

To verify without restarting, from a separate shell:

```bash
cd /Users/integrale/code/perplexity-comet-mcp
node -e '
const { spawn } = require("child_process");
const p = spawn("node", ["dist/index.js"]);
let out = "";
p.stdout.on("data", d => { out += d.toString();
  for (const line of out.split("\n")) {
    try { const msg = JSON.parse(line); if (msg.id === 2) { console.log(JSON.stringify(msg.result.tools.map(t => t.name))); process.exit(0); } } catch {}
  }
});
p.stdin.write(JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2024-11-05",clientInfo:{name:"t",version:"1"},capabilities:{}}}) + "\n");
p.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"}) + "\n");
p.stdin.write(JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/list"}) + "\n");
setTimeout(() => { console.error("timeout"); process.exit(1); }, 5000);
'
```

If the output array includes `comet_deep_research` and `comet_connectors`, the dist is good — only Claude Code needs a restart.

---

## 6. Build fails after editing a `.ts` file

```bash
cd /Users/integrale/code/perplexity-comet-mcp
npm run build           # runs tsc with strict mode
```

TypeScript errors print directly. Most common: forgetting `as string` casts on `args?.foo`, or hitting `noUnusedParameters`. Just fix and rerun.

---

## 7. Push fails with 403 / permission denied

You (`ammarshah1n`) don't have write access to `RapierCraft/perplexity-comet-mcp` (the `origin` remote). Push to your fork instead:

```bash
git push ammarshah1n main
```

The `ammarshah1n` remote is already configured. If it's missing for some reason:

```bash
git remote add ammarshah1n https://github.com/ammarshah1n/Perplexity-Comet-MCP.git
```

---

## When in doubt

1. Read `docs/ARCHITECTURE.md` to find which link in the chain is suspect.
2. Run the checks in §0.
3. The single most useful debugging move is the **discovery snippet in §1** — it tells you what the Perplexity DOM actually looks like right now, which is the variable that changes most often.
4. If the issue is in the skill / command / CLAUDE.md rule layer, those files are outside this repo — at `~/.claude/skills/comet/`, `~/.claude/commands/comet.md`, and `~/CLAUDE.md`. Grep there.
