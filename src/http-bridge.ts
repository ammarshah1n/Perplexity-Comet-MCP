#!/usr/bin/env node

/**
 * HTTP Bridge Server for Remote MCP Access
 *
 * Enables remote clients (e.g., n8n on Linux) to connect to a Comet instance
 * running on Windows/macOS over HTTP.
 *
 * Usage:
 *   COMET_BRIDGE_TOKEN=your-secret-token node dist/http-bridge.js
 *
 * Environment variables:
 *   - COMET_BRIDGE_TOKEN: Required. Authentication token for API access
 *   - COMET_BRIDGE_PORT: Optional. Port to listen on (default: 3210)
 *   - COMET_BRIDGE_HOST: Optional. Host to bind to (default: 0.0.0.0)
 */

import http from "http";
import { URL } from "url";
import { cometClient } from "./cdp-client.js";
import { cometAI } from "./comet-ai.js";

// ============================================================================
// Configuration
// ============================================================================

const BRIDGE_TOKEN = process.env.COMET_BRIDGE_TOKEN;
const BRIDGE_PORT = parseInt(process.env.COMET_BRIDGE_PORT || "3210", 10);
const BRIDGE_HOST = process.env.COMET_BRIDGE_HOST || "0.0.0.0";

if (!BRIDGE_TOKEN) {
  console.error("ERROR: COMET_BRIDGE_TOKEN environment variable is required");
  console.error("Usage: COMET_BRIDGE_TOKEN=your-secret-token node dist/http-bridge.js");
  process.exit(1);
}

// ============================================================================
// Session State (same as index.ts)
// ============================================================================

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

function generateTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

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

function completeTask(response: string): void {
  sessionState.lastResponse = response;
  sessionState.lastResponseTime = Date.now();
  sessionState.isActive = false;
}

function isSessionStale(): boolean {
  if (!sessionState.taskStartTime) return true;
  return Date.now() - sessionState.taskStartTime > 5 * 60 * 1000;
}

// ============================================================================
// Tool Handlers (extracted from index.ts for reuse)
// ============================================================================

type ToolResult = {
  success: boolean;
  content: string | { type: string; data?: string; mimeType?: string }[];
  error?: string;
};

async function handleConnect(): Promise<ToolResult> {
  const startResult = await cometClient.startComet(9223);
  const targets = await cometClient.listTargets();
  const perplexityTab = targets.find(t => t.type === 'page' && t.url.includes('perplexity.ai'));
  const anyPage = perplexityTab || targets.find(t => t.type === 'page');

  if (anyPage) {
    await cometClient.connect(anyPage.id);
    if (!anyPage.url.includes('perplexity.ai')) {
      await cometClient.navigate("https://www.perplexity.ai/", true);
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    return { success: true, content: `${startResult}\nConnected to Perplexity` };
  }

  const newTab = await cometClient.newTab("https://www.perplexity.ai/");
  await new Promise(resolve => setTimeout(resolve, 2000));
  await cometClient.connect(newTab.id);
  return { success: true, content: `${startResult}\nCreated new tab and navigated to Perplexity` };
}

async function handleAsk(args: {
  prompt: string;
  context?: string;
  newChat?: boolean;
  timeout?: number;
}): Promise<ToolResult> {
  let prompt = args.prompt;
  const context = args.context;
  const maxTimeout = args.timeout || 120000;
  const newChat = args.newChat || false;

  if (!prompt || prompt.trim().length === 0) {
    return { success: false, content: "", error: "prompt cannot be empty" };
  }

  // Prepend context if provided
  if (context && context.trim().length > 0) {
    const contextPrefix = `Context for this task:\n\`\`\`\n${context.trim()}\n\`\`\`\n\nBased on the above context, `;
    prompt = contextPrefix + prompt;
  }

  const taskId = startNewTask(prompt);

  // Pre-operation check
  try {
    await cometClient.preOperationCheck();
  } catch {
    try {
      await cometClient.startComet(9223);
      const targets = await cometClient.listTargets();
      const page = targets.find(t => t.type === 'page');
      if (page) await cometClient.connect(page.id);
    } catch {
      return { success: false, content: "", error: "Failed to establish connection to Comet browser" };
    }
  }

  // Normalize prompt
  prompt = prompt
    .replace(/^[-*•]\s*/gm, '')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Transform for agentic browsing
  const hasUrl = /https?:\/\/[^\s]+/.test(prompt);
  const hasWebsiteRef = /\b(go to|visit|navigate|open|browse|check|look at|read from|click|fill|submit|login|sign in|download from)\b/i.test(prompt);
  const hasSiteNames = /\b(\.com|\.org|\.io|\.net|\.ai|website|webpage|page|site)\b/i.test(prompt);
  const needsAgenticBrowsing = hasUrl || hasWebsiteRef || hasSiteNames;

  if (needsAgenticBrowsing) {
    const alreadyAgentic = /^(use your browser|using your browser|open a browser|navigate to|browse to)/i.test(prompt);
    if (!alreadyAgentic) {
      if (hasUrl) {
        const urlMatch = prompt.match(/https?:\/\/[^\s]+/);
        if (urlMatch) {
          const url = urlMatch[0];
          const restOfPrompt = prompt.replace(url, '').trim();
          prompt = `Use your browser to navigate to ${url} and ${restOfPrompt || 'tell me what you find there'}`;
        }
      } else {
        prompt = `Use your browser to ${prompt.toLowerCase().startsWith('go') ? '' : 'go and '}${prompt}`;
      }
    }
  }

  // Handle newChat navigation
  if (newChat) {
    await cometClient.ensureConnection();
    try {
      await cometClient.navigate("https://www.perplexity.ai/", true);
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch {
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
    const tabs = await cometClient.listTabsCategorized();
    if (tabs.main) {
      await cometClient.connect(tabs.main.id);
    }

    const urlResult = await cometClient.evaluate('window.location.href');
    const currentUrl = urlResult.result.value as string;
    if (!currentUrl?.includes('perplexity.ai')) {
      await cometClient.navigate("https://www.perplexity.ai/", true);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  cometAI.resetStabilityTracking();

  // Capture old state
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

  // Send prompt
  await cometAI.sendPrompt(prompt);

  // Smart polling
  const startTime = Date.now();
  const stepsCollected: string[] = [];
  let sawNewResponse = false;
  let lastActivityTime = Date.now();
  let previousResponse = '';
  const POLL_INTERVAL = 1500;
  const IDLE_TIMEOUT = 6000;
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 5;

  while (Date.now() - startTime < maxTimeout) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));

    try {
      const isOnPerplexity = await cometClient.isOnPerplexityTab();
      if (!isOnPerplexity) {
        const switched = await cometClient.ensureOnPerplexityTab();
        if (!switched) {
          consecutiveErrors++;
          continue;
        }
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

      // Completion conditions
      if (status.status === 'completed' && sawNewResponse && status.response) {
        completeTask(status.response);
        return { success: true, content: status.response };
      }

      if (status.isStable && sawNewResponse && status.response && !status.hasStopButton) {
        completeTask(status.response);
        return { success: true, content: status.response };
      }

      const idleTime = Date.now() - lastActivityTime;
      if (idleTime > IDLE_TIMEOUT && sawNewResponse && status.response &&
          status.response.length > 100 && !status.hasStopButton) {
        completeTask(status.response);
        return { success: true, content: status.response };
      }
    } catch {
      consecutiveErrors++;

      try {
        const recovered = await cometClient.ensureOnPerplexityTab();
        if (recovered) {
          consecutiveErrors = Math.max(0, consecutiveErrors - 1);
          continue;
        }
      } catch {
        // continue
      }

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
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

  // Max timeout reached
  const finalStatus = await cometAI.getAgentStatus();
  if (finalStatus.response && finalStatus.response.length > 50) {
    completeTask(finalStatus.response);
    return { success: true, content: finalStatus.response };
  }

  let inProgressMsg = `Task may still be in progress (max timeout reached).\n`;
  inProgressMsg += `Status: ${finalStatus.status.toUpperCase()}\n`;
  if (finalStatus.currentStep) {
    inProgressMsg += `Current: ${finalStatus.currentStep}\n`;
  }
  if (stepsCollected.length > 0) {
    inProgressMsg += `\nSteps:\n${stepsCollected.map(s => `  • ${s}`).join('\n')}\n`;
  }
  inProgressMsg += `\nUse comet_poll to check progress or comet_stop to cancel.`;

  sessionState.steps = stepsCollected;
  return { success: true, content: inProgressMsg };
}

async function handlePoll(): Promise<ToolResult> {
  if (!sessionState.isActive && !sessionState.currentTaskId) {
    return { success: true, content: "Status: IDLE\nNo active task. Use comet_ask to start a new task." };
  }

  if (isSessionStale() && !sessionState.isActive) {
    return { success: true, content: "Status: IDLE\nPrevious task session expired. Use comet_ask to start a new task." };
  }

  if (!sessionState.isActive && sessionState.lastResponse) {
    const timeSinceComplete = sessionState.lastResponseTime
      ? Math.round((Date.now() - sessionState.lastResponseTime) / 1000)
      : 0;
    return { success: true, content: `Status: COMPLETED (${timeSinceComplete}s ago)\n\n${sessionState.lastResponse}` };
  }

  await cometClient.ensureOnPerplexityTab();
  const status = await cometAI.getAgentStatus();

  if (status.status === 'completed' && status.response) {
    completeTask(status.response);
    return { success: true, content: status.response };
  }

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

  const allSteps = [...new Set([...sessionState.steps, ...status.steps])];
  if (allSteps.length > 0) {
    output += `\nSteps:\n${allSteps.map(s => `  • ${s}`).join('\n')}\n`;
  }
  if (status.status === 'working' || sessionState.isActive) {
    output += `\n[Use comet_stop to interrupt, or comet_screenshot to see current page]`;
  }

  return { success: true, content: output };
}

async function handleStop(): Promise<ToolResult> {
  const stopped = await cometAI.stopAgent();
  if (stopped) {
    sessionState.isActive = false;
  }
  return { success: true, content: stopped ? "Agent stopped" : "No active agent to stop" };
}

async function handleScreenshot(): Promise<ToolResult> {
  const result = await cometClient.screenshot("png");
  return {
    success: true,
    content: [{ type: "image", data: result.data, mimeType: "image/png" }]
  };
}

async function handleTabs(args: { action?: string; domain?: string; tabId?: string }): Promise<ToolResult> {
  const action = args.action || 'list';
  const domain = args.domain;
  const tabId = args.tabId;

  switch (action) {
    case 'list': {
      const summary = await cometClient.getTabSummary();
      return { success: true, content: summary };
    }

    case 'switch': {
      if (tabId) {
        await cometClient.connect(tabId);
        return { success: true, content: `Switched to tab: ${tabId}` };
      }
      if (domain) {
        const tab = await cometClient.findTabByDomain(domain);
        if (tab) {
          await cometClient.connect(tab.id);
          return { success: true, content: `Switched to ${tab.domain} (${tab.url})` };
        }
        return { success: false, content: "", error: `No tab found for domain: ${domain}` };
      }
      return { success: false, content: "", error: "Specify domain or tabId to switch" };
    }

    case 'close': {
      const allTabs = await cometClient.getTabContexts();
      if (allTabs.length <= 1) {
        return { success: false, content: "", error: "Cannot close - this is the only browsing tab" };
      }

      if (tabId) {
        const success = await cometClient.closeTab(tabId);
        return { success, content: success ? `Closed tab: ${tabId}` : "Failed to close tab" };
      }
      if (domain) {
        const tab = await cometClient.findTabByDomain(domain);
        if (tab && tab.purpose !== 'main') {
          const success = await cometClient.closeTab(tab.id);
          return { success, content: success ? `Closed ${tab.domain}` : "Failed to close tab" };
        }
        if (tab?.purpose === 'main') {
          return { success: false, content: "", error: "Cannot close main Perplexity tab" };
        }
        return { success: false, content: "", error: `No tab found for domain: ${domain}` };
      }
      return { success: false, content: "", error: "Specify domain or tabId to close" };
    }

    default:
      return { success: false, content: "", error: `Unknown action: ${action}. Use: list, switch, close` };
  }
}

async function handleMode(args: { mode?: string }): Promise<ToolResult> {
  const mode = args.mode;

  if (!mode) {
    const result = await cometClient.evaluate(`
      (() => {
        const modes = ['Search', 'Research', 'Labs', 'Learn'];
        for (const mode of modes) {
          const btn = document.querySelector('button[aria-label="' + mode + '"]');
          if (btn && btn.getAttribute('data-state') === 'checked') {
            return mode.toLowerCase();
          }
        }
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

    return { success: true, content: output };
  }

  const modeMap: Record<string, string> = {
    search: "Search",
    research: "Research",
    labs: "Labs",
    learn: "Learn",
  };
  const ariaLabel = modeMap[mode];
  if (!ariaLabel) {
    return { success: false, content: "", error: `Invalid mode: ${mode}. Use: search, research, labs, learn` };
  }

  const state = cometClient.currentState;
  if (!state.currentUrl?.includes("perplexity.ai")) {
    await cometClient.navigate("https://www.perplexity.ai/", true);
  }

  const clickResult = await cometClient.evaluate(`
    (() => {
      const btn = document.querySelector('button[aria-label="${ariaLabel}"]');
      if (btn) {
        btn.click();
        return { success: true, method: 'button' };
      }
      const allButtons = document.querySelectorAll('button');
      for (const b of allButtons) {
        const text = b.innerText.toLowerCase();
        if ((text.includes('search') || text.includes('research') ||
             text.includes('labs') || text.includes('learn')) &&
            b.querySelector('svg')) {
          b.click();
          return { success: true, method: 'dropdown-open', needsSelect: true };
        }
      }
      return { success: false, error: "Mode selector not found" };
    })()
  `);

  const result = clickResult.result.value as { success: boolean; method?: string; needsSelect?: boolean; error?: string };

  if (result.success && result.needsSelect) {
    await new Promise(resolve => setTimeout(resolve, 300));
    const selectResult = await cometClient.evaluate(`
      (() => {
        const items = document.querySelectorAll('[role="menuitem"], [role="option"], button');
        for (const item of items) {
          if (item.innerText.toLowerCase().includes('${mode}')) {
            item.click();
            return { success: true };
          }
        }
        return { success: false, error: "Mode option not found in dropdown" };
      })()
    `);
    const selectRes = selectResult.result.value as { success: boolean; error?: string };
    if (selectRes.success) {
      return { success: true, content: `Switched to ${mode} mode` };
    } else {
      return { success: false, content: "", error: selectRes.error };
    }
  }

  if (result.success) {
    return { success: true, content: `Switched to ${mode} mode` };
  } else {
    return { success: false, content: "", error: result.error };
  }
}

// ============================================================================
// HTTP Server
// ============================================================================

function sendJSON(res: http.ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(data));
}

function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function validateToken(req: http.IncomingMessage): boolean {
  const authHeader = req.headers.authorization;
  if (!authHeader) return false;

  // Support both "Bearer <token>" and just "<token>"
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader;

  return token === BRIDGE_TOKEN;
}

const server = http.createServer(async (req, res) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const path = url.pathname;

  // Health check endpoint (no auth required)
  if (path === "/health" && req.method === "GET") {
    sendJSON(res, 200, {
      status: "ok",
      version: "2.7.0",
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // API info endpoint (no auth required)
  if (path === "/" && req.method === "GET") {
    sendJSON(res, 200, {
      name: "comet-bridge",
      version: "2.7.0",
      description: "HTTP Bridge for Remote Comet MCP Access",
      endpoints: {
        "GET /health": "Health check",
        "GET /tools": "List available tools",
        "POST /tool/:name": "Execute a tool",
        "POST /rpc": "JSON-RPC style endpoint",
      },
    });
    return;
  }

  // All other endpoints require authentication
  if (!validateToken(req)) {
    sendJSON(res, 401, { error: "Unauthorized", message: "Invalid or missing token" });
    return;
  }

  try {
    // List tools
    if (path === "/tools" && req.method === "GET") {
      sendJSON(res, 200, {
        tools: [
          { name: "comet_connect", description: "Connect to Comet browser" },
          { name: "comet_ask", description: "Send a prompt and get response" },
          { name: "comet_poll", description: "Check agent status" },
          { name: "comet_stop", description: "Stop current task" },
          { name: "comet_screenshot", description: "Capture screenshot" },
          { name: "comet_tabs", description: "Manage browser tabs" },
          { name: "comet_mode", description: "Switch Perplexity mode" },
        ],
      });
      return;
    }

    // Execute tool via /tool/:name
    const toolMatch = path.match(/^\/tool\/(\w+)$/);
    if (toolMatch && req.method === "POST") {
      const toolName = toolMatch[1];
      const args = await parseBody(req) as Record<string, unknown>;
      const result = await executeToolByName(toolName, args);
      sendJSON(res, result.success ? 200 : 400, result);
      return;
    }

    // JSON-RPC style endpoint
    if (path === "/rpc" && req.method === "POST") {
      const body = await parseBody(req) as { method?: string; params?: Record<string, unknown> };
      if (!body.method) {
        sendJSON(res, 400, { error: "Bad Request", message: "Missing 'method' field" });
        return;
      }
      const result = await executeToolByName(body.method, body.params || {});
      sendJSON(res, result.success ? 200 : 400, result);
      return;
    }

    // 404 for unknown routes
    sendJSON(res, 404, { error: "Not Found", message: `Unknown endpoint: ${path}` });

  } catch (error) {
    console.error("Server error:", error);
    sendJSON(res, 500, {
      error: "Internal Server Error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

async function executeToolByName(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case "comet_connect":
      return handleConnect();
    case "comet_ask":
      return handleAsk(args as { prompt: string; context?: string; newChat?: boolean; timeout?: number });
    case "comet_poll":
      return handlePoll();
    case "comet_stop":
      return handleStop();
    case "comet_screenshot":
      return handleScreenshot();
    case "comet_tabs":
      return handleTabs(args as { action?: string; domain?: string; tabId?: string });
    case "comet_mode":
      return handleMode(args as { mode?: string });
    default:
      return { success: false, content: "", error: `Unknown tool: ${name}` };
  }
}

// ============================================================================
// Start Server
// ============================================================================

server.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║           Comet MCP HTTP Bridge Server v2.7.0                 ║
╠═══════════════════════════════════════════════════════════════╣
║                                                               ║
║  Status:    RUNNING                                           ║
║  Host:      ${BRIDGE_HOST.padEnd(45)}║
║  Port:      ${String(BRIDGE_PORT).padEnd(45)}║
║  Auth:      Token-based (Authorization header)                ║
║                                                               ║
║  Endpoints:                                                   ║
║    GET  /health     - Health check (no auth)                  ║
║    GET  /tools      - List available tools                    ║
║    POST /tool/:name - Execute a tool                          ║
║    POST /rpc        - JSON-RPC style calls                    ║
║                                                               ║
║  Example:                                                     ║
║    curl -X POST http://localhost:${String(BRIDGE_PORT).padEnd(24)}║
║         -H "Authorization: Bearer YOUR_TOKEN"                 ║
║         -H "Content-Type: application/json"                   ║
║         -d '{"method":"comet_connect"}'                       ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down HTTP bridge...");
  server.close(() => {
    process.exit(0);
  });
});

process.on("SIGTERM", () => {
  console.log("\nReceived SIGTERM, shutting down...");
  server.close(() => {
    process.exit(0);
  });
});
