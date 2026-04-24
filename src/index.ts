#!/usr/bin/env node

// Comet Browser MCP Server
// Claude Code ↔ Perplexity Comet bidirectional interaction
// Simplified to 6 essential tools

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { cometClient } from "./cdp-client.js";
import { cometAI } from "./comet-ai.js";

// Session state for tracking task progress and preventing stale responses
interface SessionState {
  currentTaskId: string | null;
  taskStartTime: number | null;
  lastPrompt: string | null;
  lastResponse: string | null;
  lastResponseTime: number | null;
  steps: string[];
  isActive: boolean;
}

const sessionState: SessionState = {
  currentTaskId: null,
  taskStartTime: null,
  lastPrompt: null,
  lastResponse: null,
  lastResponseTime: null,
  steps: [],
  isActive: false,
};

// Helper to generate task ID
function generateTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

// Helper to reset session for new task
function startNewTask(prompt: string): string {
  const taskId = generateTaskId();
  sessionState.currentTaskId = taskId;
  sessionState.taskStartTime = Date.now();
  sessionState.lastPrompt = prompt;
  sessionState.lastResponse = null;
  sessionState.lastResponseTime = null;
  sessionState.steps = [];
  sessionState.isActive = true;
  cometAI.resetStabilityTracking();
  return taskId;
}

// Helper to complete task
function completeTask(response: string): void {
  sessionState.lastResponse = response;
  sessionState.lastResponseTime = Date.now();
  sessionState.isActive = false;
}

// Helper to check if session is stale
function isSessionStale(): boolean {
  if (!sessionState.taskStartTime) return true;
  // Consider session stale if no activity for 5 minutes
  return Date.now() - sessionState.taskStartTime > 5 * 60 * 1000;
}

const TOOLS: Tool[] = [
  {
    name: "comet_connect",
    description: "Connect to Comet browser (auto-starts if needed)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_ask",
    description: "Send a prompt to Comet/Perplexity and wait for the complete response (blocking). Ideal for tasks requiring real browser interaction (login walls, dynamic content, filling forms) or deep research with agentic browsing.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Question or task for Comet - focus on goals and context" },
        context: { type: "string", description: "Optional context to include (e.g., file contents, codebase info, marketing guidelines). This will be prefixed to the prompt to give Comet full context." },
        newChat: { type: "boolean", description: "Start a fresh conversation (default: false)" },
        deepResearch: { type: "boolean", description: "Activate Deep Research mode before sending (adds 3-45 min to completion time, prefer comet_deep_research for a larger default timeout)" },
        timeout: { type: "number", description: "Max wait time in ms (default: 120000 = 2min)" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "comet_poll",
    description: "Check agent status and progress. Call repeatedly to monitor agentic tasks.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_stop",
    description: "Stop the current agent task if it's going off track",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_screenshot",
    description: "Capture a screenshot of current page",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_tabs",
    description: "View and manage browser tabs. Shows all open tabs with their purpose, domain, and status. Helps coordinate multi-tab workflows without creating duplicate tabs.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "switch", "close"],
          description: "Action to perform: 'list' (default) shows all tabs, 'switch' activates a tab, 'close' closes a tab",
        },
        domain: {
          type: "string",
          description: "For switch/close: domain to match (e.g., 'github.com')",
        },
        tabId: {
          type: "string",
          description: "For switch/close: specific tab ID",
        },
      },
    },
  },
  {
    name: "comet_mode",
    description: "Switch Perplexity search mode. Modes: 'search' (basic), 'research' (deep research), 'labs' (analytics/visualization), 'learn' (educational). Call without mode to see current mode.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["search", "research", "labs", "learn"],
          description: "Mode to switch to (optional - omit to see current mode)",
        },
      },
    },
  },
  {
    name: "comet_connectors",
    description: "Toggle Perplexity data connectors (e.g., YouTube, Reddit, Academic, X/Twitter, GitHub, Wolfram Alpha) for the current search. Connectors focus results on specific sources. Call without args to list available connectors and their current state.",
    inputSchema: {
      type: "object",
      properties: {
        enable: {
          type: "array",
          items: { type: "string" },
          description: "Connector names to enable (e.g., ['YouTube', 'Reddit', 'Academic'])",
        },
        disable: {
          type: "array",
          items: { type: "string" },
          description: "Connector names to disable",
        },
      },
    },
  },
  {
    name: "comet_deep_research",
    description: "Switch to Deep Research mode and send a prompt in one call. Equivalent to comet_mode('research') + comet_ask, but with a longer default timeout (5 min) suitable for deep research tasks. Returns the full research report.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Research question or topic" },
        context: { type: "string", description: "Optional context to include" },
        timeout: { type: "number", description: "Max wait time in ms (default: 300000 = 5min)" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "comet_upload",
    description: "Upload a file to a file input on the current page. Use this to attach images, documents, or other files to forms, posts, or upload dialogs. The file must exist on the local filesystem.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "Absolute path to the file to upload (e.g., '/home/user/image.png' or 'C:\\Users\\user\\image.png')",
        },
        selector: {
          type: "string",
          description: "Optional CSS selector for the file input element. If not provided, auto-detects the first file input on the page.",
        },
        checkOnly: {
          type: "boolean",
          description: "If true, only checks if file inputs exist on the page without uploading",
        },
      },
      required: ["filePath"],
    },
  },
];

const server = new Server(
  { name: "comet-bridge", version: "2.5.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "comet_connect": {
        // Auto-start Comet with debug port (will restart if running without it)
        const startResult = await cometClient.startComet(9223);

        // Get all tabs - DON'T clean up tabs, as closing them can crash Comet
        const targets = await cometClient.listTargets();
        const freshTargets = targets; // Use the same list, no cleanup

        // Prefer connecting to existing Perplexity tab, or any page tab
        const perplexityTab = freshTargets.find(t => t.type === 'page' && t.url.includes('perplexity.ai'));
        const anyPage = perplexityTab || freshTargets.find(t => t.type === 'page');

        if (anyPage) {
          await cometClient.connect(anyPage.id);

          // Only navigate to Perplexity if not already there
          if (!anyPage.url.includes('perplexity.ai')) {
            await cometClient.navigate("https://www.perplexity.ai/", true);
            await new Promise(resolve => setTimeout(resolve, 1500));
          }

          return { content: [{ type: "text", text: `${startResult}\nConnected to Perplexity` }] };
        }

        // No tabs at all - create a new one
        const newTab = await cometClient.newTab("https://www.perplexity.ai/");
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for page load
        await cometClient.connect(newTab.id);
        return { content: [{ type: "text", text: `${startResult}\nCreated new tab and navigated to Perplexity` }] };
      }

      case "comet_ask": {
        let prompt = args?.prompt as string;
        const context = args?.context as string | undefined;
        const deepResearch = (args?.deepResearch as boolean) || false;
        const maxTimeout = (args?.timeout as number) || (deepResearch ? 300000 : 120000); // 5min for deep research, 2min default
        const newChat = (args?.newChat as boolean) || false;

        // Validate prompt
        if (!prompt || prompt.trim().length === 0) {
          return { content: [{ type: "text", text: "Error: prompt cannot be empty" }] };
        }

        // If context is provided, prepend it to the prompt
        if (context && context.trim().length > 0) {
          // Format context as a clear prefix
          const contextPrefix = `Context for this task:\n\`\`\`\n${context.trim()}\n\`\`\`\n\nBased on the above context, `;
          prompt = contextPrefix + prompt;
        }

        // Start new task session - resets state and prevents stale poll responses
        const taskId = startNewTask(prompt);

        // CRITICAL: Pre-operation connection check for one-shot reliability
        try {
          await cometClient.preOperationCheck();
        } catch (preCheckError) {
          // If pre-check fails, try to recover
          try {
            await cometClient.startComet(9223);
            const targets = await cometClient.listTargets();
            const page = targets.find(t => t.type === 'page');
            if (page) await cometClient.connect(page.id);
          } catch {
            return { content: [{ type: "text", text: "Error: Failed to establish connection to Comet browser" }] };
          }
        }

        // Normalize prompt - convert markdown/bullets to natural text
        prompt = prompt
          .replace(/^[-*•]\s*/gm, '')  // Remove bullet points
          .replace(/\n+/g, ' ')         // Collapse newlines to spaces
          .replace(/\s+/g, ' ')         // Collapse multiple spaces
          .trim();

        // Transform prompt to trigger agentic browsing when needed
        // Detect if prompt requires browser actions (URLs, action verbs, website references)
        const hasUrl = /https?:\/\/[^\s]+/.test(prompt);
        const hasWebsiteRef = /\b(go to|visit|navigate|open|browse|check|look at|read from|click|fill|submit|login|sign in|download from)\b/i.test(prompt);
        const hasSiteNames = /\b(\.com|\.org|\.io|\.net|\.ai|website|webpage|page|site)\b/i.test(prompt);
        const needsAgenticBrowsing = hasUrl || hasWebsiteRef || hasSiteNames;

        // If prompt needs browser action but doesn't have agentic language, add it
        if (needsAgenticBrowsing) {
          const alreadyAgentic = /^(use your browser|using your browser|open a browser|navigate to|browse to)/i.test(prompt);
          if (!alreadyAgentic) {
            // Transform to agentic prompt
            if (hasUrl) {
              // Extract URL and restructure prompt
              const urlMatch = prompt.match(/https?:\/\/[^\s]+/);
              if (urlMatch) {
                const url = urlMatch[0];
                const restOfPrompt = prompt.replace(url, '').trim();
                prompt = `Use your browser to navigate to ${url} and ${restOfPrompt || 'tell me what you find there'}`;
              }
            } else {
              // Add agentic prefix for site references
              prompt = `Use your browser to ${prompt.toLowerCase().startsWith('go') ? '' : 'go and '}${prompt}`;
            }
          }
        }

        // For newChat: navigate to fresh Perplexity home (don't aggressively close tabs)
        if (newChat) {
          // Ensure we're connected
          await cometClient.ensureConnection();

          // Just navigate to Perplexity home for a fresh start
          try {
            await cometClient.navigate("https://www.perplexity.ai/", true);
            await new Promise(resolve => setTimeout(resolve, 2000));
          } catch (navError) {
            // If navigation fails, try to reconnect and retry
            const targets = await cometClient.listTargets();
            const mainTab = targets.find(t => t.type === 'page' && t.url.includes('perplexity'));
            if (mainTab) {
              await cometClient.connect(mainTab.id);
            } else {
              const anyPage = targets.find(t => t.type === 'page');
              if (anyPage) {
                await cometClient.connect(anyPage.id);
                await cometClient.navigate("https://www.perplexity.ai/", true);
              }
            }
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        } else {
          // Not newChat - just ensure we're on Perplexity
          const tabs = await cometClient.listTabsCategorized();
          if (tabs.main) {
            await cometClient.connect(tabs.main.id);
          }

          const urlResult = await cometClient.evaluate('window.location.href');
          const currentUrl = urlResult.result.value as string;
          const isOnPerplexity = currentUrl?.includes('perplexity.ai');

          if (!isOnPerplexity) {
            await cometClient.navigate("https://www.perplexity.ai/", true);
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }

        // Reset stability tracking for new prompt
        cometAI.resetStabilityTracking();

        // Optional: flip Deep Research mode on before sending. Swallows failures —
        // mode switch is best-effort; the prompt still sends in whatever mode is active.
        if (args?.deepResearch === true) {
          try {
            await cometClient.evaluate(`
              (() => {
                const MENU_SELS = [
                  'button[aria-label*="attach" i]',
                  'button[aria-label*="plus" i]',
                  'button[aria-label*="more" i]',
                  'button[aria-label*="options" i]',
                  'button[aria-label*="connector" i]',
                  '[data-testid*="attach" i]',
                ];
                for (const sel of MENU_SELS) {
                  const btn = document.querySelector(sel);
                  if (btn && btn.offsetParent !== null) { btn.click(); return; }
                }
                const inputEl = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
                if (inputEl) {
                  let parent = inputEl.parentElement;
                  for (let i = 0; i < 6 && parent; i++) {
                    for (const btn of parent.querySelectorAll('button')) {
                      const t = btn.innerText.trim();
                      if ((t === '+' || t === '＋') && btn.offsetParent !== null) { btn.click(); return; }
                    }
                    parent = parent.parentElement;
                  }
                }
              })()
            `);
            await new Promise(resolve => setTimeout(resolve, 500));
            await cometClient.evaluate(`
              (() => {
                const regex = /^(deep\\s*research|research)$/i;
                for (const sel of ['[role="menuitem"]', '[role="option"]', 'li', 'button', 'a']) {
                  for (const el of document.querySelectorAll(sel)) {
                    const text = el.textContent?.trim() ?? '';
                    if (el.offsetParent !== null && regex.test(text)) { el.click(); return; }
                  }
                }
                for (const sel of ['[role="menuitem"]', '[role="option"]', 'li', 'button', 'a']) {
                  for (const el of document.querySelectorAll(sel)) {
                    if (el.offsetParent !== null && el.textContent?.toLowerCase().includes('research')) { el.click(); return; }
                  }
                }
              })()
            `);
            await new Promise(resolve => setTimeout(resolve, 800));
          } catch {
            // Best-effort — fall through and send prompt anyway
          }
        }

        // Capture old response state BEFORE sending prompt (for follow-up detection)
        const oldStateResult = await cometClient.evaluate(`
          (() => {
            const proseEls = document.querySelectorAll('[class*="prose"]');
            const lastProse = proseEls[proseEls.length - 1];
            return {
              count: proseEls.length,
              lastText: lastProse ? lastProse.innerText.substring(0, 100) : ''
            };
          })()
        `);
        const oldState = oldStateResult.result.value as { count: number; lastText: string };

        // Send the prompt
        await cometAI.sendPrompt(prompt);

        // Smart polling - detect completion based on activity, not fixed timeout
        const startTime = Date.now();
        const stepsCollected: string[] = [];
        let sawNewResponse = false;
        let lastActivityTime = Date.now();
        let previousResponse = '';
        const POLL_INTERVAL = 1500; // Poll every 1.5 seconds for balance
        const IDLE_TIMEOUT = 6000; // If no activity for 6s and we have a response, consider done
        let consecutiveErrors = 0;
        const MAX_CONSECUTIVE_ERRORS = 5;

        while (Date.now() - startTime < maxTimeout) {
          await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));

          try {
            // CRITICAL: Ensure we're on Perplexity tab during agentic browsing
            // Comet may have opened new tabs which can break our connection
            const isOnPerplexity = await cometClient.isOnPerplexityTab();
            if (!isOnPerplexity) {
              const switched = await cometClient.ensureOnPerplexityTab();
              if (!switched) {
                consecutiveErrors++;
                continue; // Try again next poll
              }
            }

            // Check if we have a NEW response (more prose elements or different text)
            const currentStateResult = await cometClient.withAutoReconnect(async () => {
              return await cometClient.evaluate(`
                (() => {
                  const proseEls = document.querySelectorAll('[class*="prose"]');
                  const lastProse = proseEls[proseEls.length - 1];
                  return {
                    count: proseEls.length,
                    lastText: lastProse ? lastProse.innerText.substring(0, 100) : ''
                  };
                })()
              `);
            });
            const currentState = currentStateResult.result.value as { count: number; lastText: string };

            // Detect new response
            if (!sawNewResponse) {
              if (currentState.count > oldState.count ||
                  (currentState.lastText && currentState.lastText !== oldState.lastText)) {
                sawNewResponse = true;
              }
            }

            const status = await cometAI.getAgentStatus();
            consecutiveErrors = 0; // Reset error count on success

            // Track activity - if response changed, update activity time
            if (status.response !== previousResponse) {
              lastActivityTime = Date.now();
              previousResponse = status.response;
            }

            // Collect steps
            for (const step of status.steps) {
              if (!stepsCollected.includes(step)) {
                stepsCollected.push(step);
                lastActivityTime = Date.now(); // New step = activity
              }
            }

            // Track steps in session state
            sessionState.steps = stepsCollected;

            // COMPLETION CONDITIONS (return immediately when any are met):

            // 1. Explicit completion detected by status checker
            if (status.status === 'completed' && sawNewResponse && status.response) {
              completeTask(status.response);
              return { content: [{ type: "text", text: status.response }] };
            }

            // 2. Response is stable (same content for 2+ polls) and no stop button
            if (status.isStable && sawNewResponse && status.response && !status.hasStopButton) {
              completeTask(status.response);
              return { content: [{ type: "text", text: status.response }] };
            }

            // 3. Idle timeout - no activity for 6s but we have a substantial response
            const idleTime = Date.now() - lastActivityTime;
            if (idleTime > IDLE_TIMEOUT && sawNewResponse && status.response &&
                status.response.length > 100 && !status.hasStopButton) {
              completeTask(status.response);
              return { content: [{ type: "text", text: status.response }] };
            }
          } catch (pollError) {
            consecutiveErrors++;

            // Try to recover by switching to Perplexity tab
            try {
              const recovered = await cometClient.ensureOnPerplexityTab();
              if (recovered) {
                consecutiveErrors = Math.max(0, consecutiveErrors - 1);
                continue;
              }
            } catch {
              // Continue to fallback
            }

            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              // Too many errors, try harder to recover
              try {
                await cometClient.ensureConnection();
                await cometClient.ensureOnPerplexityTab();
                consecutiveErrors = 0;
              } catch {
                // If still failing, exit loop and return partial result
                break;
              }
            }
            // Continue polling despite temporary errors
            continue;
          }
        }

        // Max timeout reached - return whatever we have
        const finalStatus = await cometAI.getAgentStatus();
        if (finalStatus.response && finalStatus.response.length > 50) {
          completeTask(finalStatus.response);
          return { content: [{ type: "text", text: finalStatus.response }] };
        }

        // No response - return progress info (task still active)
        let inProgressMsg = `Task may still be in progress (max timeout reached).\n`;
        inProgressMsg += `Status: ${finalStatus.status.toUpperCase()}\n`;
        if (finalStatus.currentStep) {
          inProgressMsg += `Current: ${finalStatus.currentStep}\n`;
        }
        if (stepsCollected.length > 0) {
          inProgressMsg += `\nSteps:\n${stepsCollected.map(s => `  • ${s}`).join('\n')}\n`;
        }
        inProgressMsg += `\nUse comet_poll to check progress or comet_stop to cancel.`;

        // Keep task active since it may still be running
        sessionState.steps = stepsCollected;
        return { content: [{ type: "text", text: inProgressMsg }] };
      }

      case "comet_poll": {
        // Check if there's an active task session
        if (!sessionState.isActive && !sessionState.currentTaskId) {
          return { content: [{ type: "text", text: "Status: IDLE\nNo active task. Use comet_ask to start a new task." }] };
        }

        // Check for stale session (no activity for 5+ minutes)
        if (isSessionStale() && !sessionState.isActive) {
          return { content: [{ type: "text", text: "Status: IDLE\nPrevious task session expired. Use comet_ask to start a new task." }] };
        }

        // If task was already completed, return the cached response
        if (!sessionState.isActive && sessionState.lastResponse) {
          const timeSinceComplete = sessionState.lastResponseTime
            ? Math.round((Date.now() - sessionState.lastResponseTime) / 1000)
            : 0;
          return { content: [{ type: "text", text: `Status: COMPLETED (${timeSinceComplete}s ago)\n\n${sessionState.lastResponse}` }] };
        }

        // Active task - get fresh status from Perplexity
        await cometClient.ensureOnPerplexityTab();
        const status = await cometAI.getAgentStatus();

        // If completed, update session state and return response
        if (status.status === 'completed' && status.response) {
          completeTask(status.response);
          return { content: [{ type: "text", text: status.response }] };
        }

        // Still working - return progress info
        let output = `Status: ${status.status.toUpperCase()}\n`;
        if (sessionState.currentTaskId) {
          output += `Task: ${sessionState.currentTaskId}\n`;
        }

        if (status.agentBrowsingUrl) {
          output += `Browsing: ${status.agentBrowsingUrl}\n`;
        }

        if (status.currentStep) {
          output += `Current: ${status.currentStep}\n`;
        }

        // Combine session steps with current status steps
        const allSteps = [...new Set([...sessionState.steps, ...status.steps])];
        if (allSteps.length > 0) {
          output += `\nSteps:\n${allSteps.map(s => `  • ${s}`).join('\n')}\n`;
        }

        if (status.status === 'working' || sessionState.isActive) {
          output += `\n[Use comet_stop to interrupt, or comet_screenshot to see current page]`;
        }

        return { content: [{ type: "text", text: output }] };
      }

      case "comet_stop": {
        const stopped = await cometAI.stopAgent();
        if (stopped) {
          sessionState.isActive = false;
        }
        return {
          content: [{
            type: "text",
            text: stopped ? "Agent stopped" : "No active agent to stop",
          }],
        };
      }

      case "comet_screenshot": {
        const result = await cometClient.withAutoReconnect(async () => {
          return await cometClient.screenshot("png");
        });
        return {
          content: [{ type: "image", data: result.data, mimeType: "image/png" }],
        };
      }

      case "comet_tabs": {
        const action = (args?.action as string) || 'list';
        const domain = args?.domain as string | undefined;
        const tabId = args?.tabId as string | undefined;

        switch (action) {
          case 'list': {
            const summary = await cometClient.getTabSummary();
            return { content: [{ type: "text", text: summary }] };
          }

          case 'switch': {
            if (tabId) {
              await cometClient.connect(tabId);
              return { content: [{ type: "text", text: `Switched to tab: ${tabId}` }] };
            }
            if (domain) {
              const tab = await cometClient.findTabByDomain(domain);
              if (tab) {
                await cometClient.connect(tab.id);
                return { content: [{ type: "text", text: `Switched to ${tab.domain} (${tab.url})` }] };
              }
              return { content: [{ type: "text", text: `No tab found for domain: ${domain}` }], isError: true };
            }
            return { content: [{ type: "text", text: "Specify domain or tabId to switch" }], isError: true };
          }

          case 'close': {
            // Safety check: don't close if it would leave no browsing tabs
            const allTabs = await cometClient.getTabContexts();

            // allTabs now only contains external tabs (Perplexity is filtered as internal)
            if (allTabs.length <= 1) {
              return { content: [{ type: "text", text: "Cannot close - this is the only browsing tab. Comet needs at least one external tab open." }], isError: true };
            }

            if (tabId) {
              const success = await cometClient.closeTab(tabId);
              return { content: [{ type: "text", text: success ? `Closed tab: ${tabId}` : `Failed to close tab` }] };
            }
            if (domain) {
              const tab = await cometClient.findTabByDomain(domain);
              if (tab && tab.purpose !== 'main') {
                const success = await cometClient.closeTab(tab.id);
                return { content: [{ type: "text", text: success ? `Closed ${tab.domain}` : `Failed to close tab` }] };
              }
              if (tab?.purpose === 'main') {
                return { content: [{ type: "text", text: "Cannot close main Perplexity tab" }], isError: true };
              }
              return { content: [{ type: "text", text: `No tab found for domain: ${domain}` }], isError: true };
            }
            return { content: [{ type: "text", text: "Specify domain or tabId to close" }], isError: true };
          }

          default:
            return { content: [{ type: "text", text: `Unknown action: ${action}. Use: list, switch, close` }], isError: true };
        }
      }

      case "comet_mode": {
        const mode = args?.mode as string | undefined;

        // If no mode provided, show current mode
        if (!mode) {
          const result = await cometClient.evaluate(`
            (() => {
              // Try button group first (wide screen)
              const modes = ['Search', 'Research', 'Labs', 'Learn'];
              for (const mode of modes) {
                const btn = document.querySelector('button[aria-label="' + mode + '"]');
                if (btn && btn.getAttribute('data-state') === 'checked') {
                  return mode.toLowerCase();
                }
              }
              // Try dropdown (narrow screen) - look for the mode selector button
              const dropdownBtn = document.querySelector('button[class*="gap"]');
              if (dropdownBtn) {
                const text = dropdownBtn.innerText.toLowerCase();
                if (text.includes('search')) return 'search';
                if (text.includes('research')) return 'research';
                if (text.includes('labs')) return 'labs';
                if (text.includes('learn')) return 'learn';
              }
              return 'search';
            })()
          `);

          const currentMode = result.result.value as string;
          const descriptions: Record<string, string> = {
            search: 'Basic web search',
            research: 'Deep research with comprehensive analysis',
            labs: 'Analytics, visualizations, and coding',
            learn: 'Educational content and explanations'
          };

          let output = `Current mode: ${currentMode}\n\nAvailable modes:\n`;
          for (const [m, desc] of Object.entries(descriptions)) {
            const marker = m === currentMode ? "→" : " ";
            output += `${marker} ${m}: ${desc}\n`;
          }

          return { content: [{ type: "text", text: output }] };
        }

        // Switch mode
        const modeMap: Record<string, string> = {
          search: "Search",
          research: "Research",
          labs: "Labs",
          learn: "Learn",
        };
        const ariaLabel = modeMap[mode];
        if (!ariaLabel) {
          return {
            content: [{ type: "text", text: `Invalid mode: ${mode}. Use: search, research, labs, learn` }],
            isError: true,
          };
        }

        // Navigate to Perplexity first if not there
        const state = cometClient.currentState;
        if (!state.currentUrl?.includes("perplexity.ai")) {
          await cometClient.navigate("https://www.perplexity.ai/", true);
        }

        // Dismiss any modals before mode switch
        await cometClient.evaluate(`
          (() => {
            for (const sel of ['button[aria-label="Close"]', 'button[aria-label="Dismiss"]', '[data-testid*="modal"] button']) {
              const el = document.querySelector(sel);
              if (el) el.click();
            }
          })()
        `);

        // Strategy: click + button → select mode from dropdown (Feb 2026 UI: + opens popover)
        const plusResult = await cometClient.evaluate(`
          (() => {
            const MENU_SELS = [
              'button[aria-label*="attach" i]',
              'button[aria-label*="plus" i]',
              'button[aria-label*="more" i]',
              'button[aria-label*="options" i]',
              'button[aria-label*="connector" i]',
              '[data-testid*="attach" i]',
            ];
            for (const sel of MENU_SELS) {
              const btn = document.querySelector(sel);
              if (btn && btn.offsetParent !== null) { btn.click(); return { success: true, method: sel }; }
            }
            // Fallback: literal + button near input
            const inputEl = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
            if (inputEl) {
              let parent = inputEl.parentElement;
              for (let i = 0; i < 6 && parent; i++) {
                for (const btn of parent.querySelectorAll('button')) {
                  const t = btn.innerText.trim();
                  if ((t === '+' || t === '＋') && btn.offsetParent !== null) {
                    btn.click();
                    return { success: true, method: 'plus-text' };
                  }
                }
                parent = parent.parentElement;
              }
            }
            return { success: false, error: 'No + button found' };
          })()
        `);

        await new Promise(resolve => setTimeout(resolve, 500));

        // Match mode by text — resilient to class/ID churn. Handle renames (e.g., "Deep Research" → "Research")
        const selectResult = await cometClient.evaluate(`
          (() => {
            const target = '${mode.toLowerCase()}';
            const matchers = {
              'research': /^(deep\\s*research|research)$/i,
              'search': /^search$/i,
              'labs': /^(labs|create files|create files and apps)$/i,
              'learn': /^(learn|learn step by step)$/i,
            };
            const regex = matchers[target] || new RegExp('^' + target + '$', 'i');

            for (const sel of ['[role="menuitem"]', '[role="option"]', 'li', 'button', 'a']) {
              for (const el of document.querySelectorAll(sel)) {
                const text = el.textContent?.trim() ?? '';
                if (el.offsetParent !== null && regex.test(text)) {
                  el.click();
                  return { success: true, text };
                }
              }
            }
            // Loose fallback: partial match
            for (const sel of ['[role="menuitem"]', '[role="option"]', 'li', 'button', 'a']) {
              for (const el of document.querySelectorAll(sel)) {
                if (el.offsetParent !== null && el.textContent?.toLowerCase().includes(target)) {
                  el.click();
                  return { success: true, text: el.textContent.trim() };
                }
              }
            }
            const visible = [...document.querySelectorAll('[role="menuitem"],[role="option"],li,button')]
              .filter(e => e.offsetParent !== null)
              .map(e => e.textContent?.trim().substring(0, 40))
              .filter(t => t && t.length > 0 && t.length < 30);
            return { success: false, error: 'Mode option not found', visible: [...new Set(visible)].slice(0, 10) };
          })()
        `);

        const plusRes = plusResult.result.value as { success: boolean; method?: string; error?: string };
        const selectRes = selectResult.result.value as { success: boolean; text?: string; error?: string; visible?: string[] };

        if (selectRes.success) {
          // Poll to confirm React actually committed the mode change
          let confirmed = false;
          for (let i = 0; i < 5; i++) {
            await new Promise(resolve => setTimeout(resolve, 300));
            const check = await cometClient.evaluate(`
              (() => {
                const modes = ['Search', 'Research', 'Labs', 'Learn'];
                for (const m of modes) {
                  const btn = document.querySelector('button[aria-label="' + m + '"]');
                  if (btn && btn.getAttribute('data-state') === 'checked') return m.toLowerCase();
                }
                const dropdownBtn = document.querySelector('button[class*="gap"]');
                if (dropdownBtn) {
                  const text = dropdownBtn.innerText.toLowerCase();
                  for (const m of ['search', 'research', 'labs', 'learn']) {
                    if (text.includes(m)) return m;
                  }
                }
                return null;
              })()
            `);
            if (check.result.value === mode) { confirmed = true; break; }
          }
          return { content: [{ type: "text", text: confirmed
            ? `Switched to ${mode} mode (confirmed)`
            : `Switched to ${mode} mode (clicked: "${selectRes.text}" — state unconfirmed, may need retry)` }] };
        }

        if (!plusRes.success) {
          return { content: [{ type: "text", text: `Failed to switch mode: ${plusRes.error}` }], isError: true };
        }

        return {
          content: [{ type: "text", text: `Failed to switch mode: mode option not found in dropdown. Visible: [${(selectRes.visible || []).join(', ')}]` }],
          isError: true,
        };
      }

      case "comet_connectors": {
        const enable = (args?.enable as string[]) || [];
        const disable = (args?.disable as string[]) || [];

        // Ensure we're on Perplexity
        await cometClient.ensureConnection();
        const urlCheck = await cometClient.evaluate('window.location.href');
        const currentUrl = urlCheck.result.value as string;
        if (!currentUrl?.includes('perplexity.ai')) {
          await cometClient.navigate("https://www.perplexity.ai/", true);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        // If no args, list available connectors and their state
        if (enable.length === 0 && disable.length === 0) {
          const listResult = await cometClient.evaluate(`
            (() => {
              // Perplexity connectors are typically in a toolbar/panel near the search input
              // Look for connector buttons/toggles
              const connectors = [];

              // Strategy 1: Look for labeled buttons with connector names
              const knownConnectors = ['YouTube', 'Reddit', 'Academic', 'X', 'GitHub', 'Wolfram Alpha', 'Wikipedia', 'News'];
              const allButtons = document.querySelectorAll('button, [role="checkbox"], [role="switch"]');
              for (const btn of allButtons) {
                const text = btn.innerText?.trim() || btn.getAttribute('aria-label') || '';
                for (const name of knownConnectors) {
                  if (text.toLowerCase().includes(name.toLowerCase())) {
                    const isActive = btn.getAttribute('data-state') === 'checked' ||
                                     btn.getAttribute('aria-checked') === 'true' ||
                                     btn.classList.contains('active') ||
                                     btn.closest('[data-state="checked"]') !== null;
                    connectors.push({ name, active: isActive });
                  }
                }
              }

              // Strategy 2: Look for a "Focus" or "Sources" button that opens connector panel
              const focusBtn = [...document.querySelectorAll('button')].find(b =>
                b.innerText.toLowerCase().includes('focus') ||
                b.innerText.toLowerCase().includes('source') ||
                b.getAttribute('aria-label')?.toLowerCase().includes('focus')
              );

              return {
                connectors,
                hasFocusButton: !!focusBtn,
                focusButtonText: focusBtn?.innerText?.trim() || null
              };
            })()
          `);

          const result = listResult.result.value as {
            connectors: { name: string; active: boolean }[];
            hasFocusButton: boolean;
            focusButtonText: string | null;
          };

          let output = 'Perplexity Connectors:\n';
          if (result.connectors.length > 0) {
            for (const c of result.connectors) {
              output += `  ${c.active ? '✓' : '○'} ${c.name}\n`;
            }
          } else {
            output += '  No connectors detected in current view.\n';
            if (result.hasFocusButton) {
              output += `  Found "${result.focusButtonText}" button — try clicking it first to reveal connectors.\n`;
            }
            output += '\n  Tip: Connectors appear near the search bar as "Focus" toggles.\n';
            output += '  Known connectors: YouTube, Reddit, Academic, X, GitHub, Wolfram Alpha, Wikipedia, News\n';
          }

          return { content: [{ type: "text", text: output }] };
        }

        // Toggle connectors
        const toToggle = [
          ...enable.map(n => ({ name: n, targetState: true })),
          ...disable.map(n => ({ name: n, targetState: false })),
        ];

        const toggleResult = await cometClient.evaluate(`
          (() => {
            const results = [];
            const toToggle = ${JSON.stringify(toToggle)};

            // First, try to open the Focus/Sources panel if it exists
            const focusBtn = [...document.querySelectorAll('button')].find(b =>
              b.innerText.toLowerCase().includes('focus') ||
              b.getAttribute('aria-label')?.toLowerCase().includes('focus')
            );
            if (focusBtn) focusBtn.click();

            // Wait a beat for panel to open
            return new Promise(resolve => {
              setTimeout(() => {
                for (const item of toToggle) {
                  const allBtns = document.querySelectorAll('button, [role="checkbox"], [role="switch"], label');
                  let found = false;
                  for (const btn of allBtns) {
                    const text = btn.innerText?.trim() || btn.getAttribute('aria-label') || '';
                    if (text.toLowerCase().includes(item.name.toLowerCase())) {
                      const isActive = btn.getAttribute('data-state') === 'checked' ||
                                       btn.getAttribute('aria-checked') === 'true' ||
                                       btn.classList.contains('active');
                      if (isActive !== item.targetState) {
                        btn.click();
                        results.push({ name: item.name, toggled: true, newState: item.targetState });
                      } else {
                        results.push({ name: item.name, toggled: false, alreadyCorrect: true });
                      }
                      found = true;
                      break;
                    }
                  }
                  if (!found) {
                    results.push({ name: item.name, toggled: false, notFound: true });
                  }
                }
                resolve(results);
              }, 500);
            });
          })()
        `);

        const toggleResults = toggleResult.result.value as Array<{
          name: string;
          toggled: boolean;
          newState?: boolean;
          alreadyCorrect?: boolean;
          notFound?: boolean;
        }>;

        let output = 'Connector updates:\n';
        for (const r of toggleResults) {
          if (r.toggled) {
            output += `  ✓ ${r.name}: ${r.newState ? 'enabled' : 'disabled'}\n`;
          } else if (r.alreadyCorrect) {
            output += `  ○ ${r.name}: already in target state\n`;
          } else if (r.notFound) {
            output += `  ✗ ${r.name}: not found in UI\n`;
          }
        }

        return { content: [{ type: "text", text: output }] };
      }

      case "comet_deep_research": {
        const prompt = args?.prompt as string;
        const context = args?.context as string | undefined;
        const timeout = (args?.timeout as number) || 300000; // 5 min default for deep research

        if (!prompt || prompt.trim().length === 0) {
          return { content: [{ type: "text", text: "Error: prompt cannot be empty" }] };
        }

        // Step 1: Ensure connection
        try {
          await cometClient.preOperationCheck();
        } catch {
          try {
            await cometClient.startComet(9223);
            const targets = await cometClient.listTargets();
            const page = targets.find(t => t.type === 'page');
            if (page) await cometClient.connect(page.id);
          } catch {
            return { content: [{ type: "text", text: "Error: Failed to connect to Comet browser" }] };
          }
        }

        // Step 2: Navigate to Perplexity fresh (forces SPA reset — prevents state corruption from previous research)
        await cometClient.navigate("https://www.perplexity.ai/", true);

        // Wait for page readiness — input element must be mounted before proceeding
        await cometClient.evaluate(`
          new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject('timeout waiting for input'), 15000);
            const check = () => {
              const ce = document.querySelector('[contenteditable="true"]');
              if (ce && document.readyState === 'complete') {
                clearTimeout(timeout);
                resolve(true);
              } else {
                setTimeout(check, 300);
              }
            };
            check();
          })
        `);

        // Dismiss any modals/interstitials
        await cometClient.evaluate(`
          (() => {
            for (const sel of ['button[aria-label="Close"]', 'button[aria-label="Dismiss"]', '[data-testid*="modal"] button']) {
              const el = document.querySelector(sel);
              if (el) el.click();
            }
          })()
        `);

        // Step 3: Switch to Research mode via + dropdown (Feb 2026 UI: + opens popover)
        await cometClient.evaluate(`
          (() => {
            const MENU_SELS = [
              'button[aria-label*="attach" i]',
              'button[aria-label*="plus" i]',
              'button[aria-label*="more" i]',
              'button[aria-label*="options" i]',
              'button[aria-label*="connector" i]',
              '[data-testid*="attach" i]',
            ];
            for (const sel of MENU_SELS) {
              const btn = document.querySelector(sel);
              if (btn && btn.offsetParent !== null) { btn.click(); return; }
            }
            const inputEl = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
            if (inputEl) {
              let parent = inputEl.parentElement;
              for (let i = 0; i < 6 && parent; i++) {
                for (const btn of parent.querySelectorAll('button')) {
                  const t = btn.innerText.trim();
                  if ((t === '+' || t === '＋') && btn.offsetParent !== null) { btn.click(); return; }
                }
                parent = parent.parentElement;
              }
            }
          })()
        `);

        await new Promise(resolve => setTimeout(resolve, 500));

        // Click Research mode — match both "Research" and "Deep Research" (Mar 2026 rename)
        await cometClient.evaluate(`
          (() => {
            const regex = /^(deep\\s*research|research)$/i;
            for (const sel of ['[role="menuitem"]', '[role="option"]', 'li', 'button', 'a']) {
              for (const el of document.querySelectorAll(sel)) {
                const text = el.textContent?.trim() ?? '';
                if (el.offsetParent !== null && regex.test(text)) {
                  el.click();
                  return;
                }
              }
            }
            // Loose fallback
            for (const sel of ['[role="menuitem"]', '[role="option"]', 'li', 'button', 'a']) {
              for (const el of document.querySelectorAll(sel)) {
                if (el.offsetParent !== null && el.textContent?.toLowerCase().includes('research')) {
                  el.click();
                  return;
                }
              }
            }
          })()
        `);

        // Poll to confirm Research mode is active before proceeding
        let modeConfirmed = false;
        for (let i = 0; i < 8; i++) {
          await new Promise(resolve => setTimeout(resolve, 400));
          const check = await cometClient.evaluate(`
            (() => {
              const btn = document.querySelector('button[aria-label="Research"]');
              if (btn && btn.getAttribute('data-state') === 'checked') return true;
              const dropdownBtn = document.querySelector('button[class*="gap"]');
              if (dropdownBtn && dropdownBtn.innerText.toLowerCase().includes('research')) return true;
              // Check page body for mode indicator
              const body = document.body.innerText;
              if (body.includes('Research mode') || body.includes('Deep Research')) return true;
              return false;
            })()
          `);
          if (check.result.value) { modeConfirmed = true; break; }
        }

        // Step 4: Build full prompt with context
        let fullPrompt = prompt;
        if (context && context.trim().length > 0) {
          fullPrompt = `Context for this research:\n\`\`\`\n${context.trim()}\n\`\`\`\n\nBased on the above context, ${prompt}`;
        }

        // Step 5: Send prompt and wait (reuse comet_ask logic but with longer timeout)
        const taskId = startNewTask(fullPrompt);
        cometAI.resetStabilityTracking();

        const oldStateResult = await cometClient.evaluate(`
          (() => {
            const proseEls = document.querySelectorAll('[class*="prose"]');
            const lastProse = proseEls[proseEls.length - 1];
            return {
              count: proseEls.length,
              lastText: lastProse ? lastProse.innerText.substring(0, 100) : ''
            };
          })()
        `);
        const oldState = oldStateResult.result.value as { count: number; lastText: string };

        // Normalize and send
        const normalizedPrompt = fullPrompt
          .replace(/^[-*•]\s*/gm, '')
          .replace(/\n+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        await cometAI.sendPrompt(normalizedPrompt);

        // Poll with longer patience for deep research
        const startTime = Date.now();
        const stepsCollected: string[] = [];
        let sawNewResponse = false;
        let lastActivityTime = Date.now();
        let previousResponse = '';
        const POLL_INTERVAL = 2000; // Slower poll for deep research
        const IDLE_TIMEOUT = 15000; // Longer idle tolerance for deep research
        let consecutiveErrors = 0;

        while (Date.now() - startTime < timeout) {
          await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));

          try {
            const isOnPerplexity = await cometClient.isOnPerplexityTab();
            if (!isOnPerplexity) {
              await cometClient.ensureOnPerplexityTab();
              continue;
            }

            const currentStateResult = await cometClient.withAutoReconnect(async () => {
              return await cometClient.evaluate(`
                (() => {
                  const proseEls = document.querySelectorAll('[class*="prose"]');
                  const lastProse = proseEls[proseEls.length - 1];
                  return {
                    count: proseEls.length,
                    lastText: lastProse ? lastProse.innerText.substring(0, 100) : ''
                  };
                })()
              `);
            });
            const currentState = currentStateResult.result.value as { count: number; lastText: string };

            if (!sawNewResponse) {
              if (currentState.count > oldState.count ||
                  (currentState.lastText && currentState.lastText !== oldState.lastText)) {
                sawNewResponse = true;
              }
            }

            const status = await cometAI.getAgentStatus();
            consecutiveErrors = 0;

            if (status.response !== previousResponse) {
              lastActivityTime = Date.now();
              previousResponse = status.response;
            }

            for (const step of status.steps) {
              if (!stepsCollected.includes(step)) {
                stepsCollected.push(step);
                lastActivityTime = Date.now();
              }
            }

            sessionState.steps = stepsCollected;

            if (status.status === 'completed' && sawNewResponse && status.response) {
              completeTask(status.response);
              return { content: [{ type: "text", text: `[Deep Research Complete]\n\n${status.response}` }] };
            }

            if (status.isStable && sawNewResponse && status.response && !status.hasStopButton) {
              completeTask(status.response);
              return { content: [{ type: "text", text: `[Deep Research Complete]\n\n${status.response}` }] };
            }

            const idleTime = Date.now() - lastActivityTime;
            if (idleTime > IDLE_TIMEOUT && sawNewResponse && status.response &&
                status.response.length > 200 && !status.hasStopButton) {
              completeTask(status.response);
              return { content: [{ type: "text", text: `[Deep Research Complete]\n\n${status.response}` }] };
            }
          } catch {
            consecutiveErrors++;
            if (consecutiveErrors >= 5) {
              try {
                await cometClient.ensureConnection();
                await cometClient.ensureOnPerplexityTab();
                consecutiveErrors = 0;
              } catch {
                break;
              }
            }
            continue;
          }
        }

        // Timeout - return partial
        const finalStatus = await cometAI.getAgentStatus();
        if (finalStatus.response && finalStatus.response.length > 50) {
          completeTask(finalStatus.response);
          return { content: [{ type: "text", text: `[Deep Research - Partial (timeout)]\n\n${finalStatus.response}` }] };
        }

        return { content: [{ type: "text", text: "Deep research timed out with no response. Use comet_poll to check if still running." }] };
      }

      case "comet_upload": {
        const filePath = args?.filePath as string;
        const selector = args?.selector as string | undefined;
        const checkOnly = args?.checkOnly as boolean | undefined;

        if (!filePath) {
          return { content: [{ type: "text", text: "Error: filePath is required" }], isError: true };
        }

        // Check if file exists
        const fs = await import('fs');
        if (!fs.existsSync(filePath)) {
          return { content: [{ type: "text", text: `Error: File not found: ${filePath}` }], isError: true };
        }

        // If checkOnly, just report what file inputs exist
        if (checkOnly) {
          const inputInfo = await cometClient.hasFileInput();
          if (inputInfo.found) {
            let msg = `Found ${inputInfo.count} file input(s) on the page:\n`;
            msg += inputInfo.selectors.map((s, i) => `  ${i + 1}. ${s}`).join('\n');
            msg += `\n\nUse comet_upload with filePath to upload to one of these inputs.`;
            return { content: [{ type: "text", text: msg }] };
          } else {
            return { content: [{ type: "text", text: "No file input elements found on the current page. Navigate to a page with a file upload form first." }] };
          }
        }

        // Perform the upload
        const result = await cometClient.uploadFile(filePath, selector);

        if (result.success) {
          return { content: [{ type: "text", text: result.message }] };
        } else {
          // If no input found, provide helpful info
          if (!result.inputFound) {
            const inputInfo = await cometClient.hasFileInput();
            let msg = result.message;
            if (inputInfo.found) {
              msg += `\n\nAvailable file inputs:\n${inputInfo.selectors.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`;
              msg += `\n\nTry specifying a selector parameter.`;
            }
            return { content: [{ type: "text", text: msg }], isError: true };
          }
          return { content: [{ type: "text", text: result.message }], isError: true };
        }
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : error}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
server.connect(transport);
