// Comet AI interaction module
// Handles sending prompts to Comet's AI assistant and reading responses

import { cometClient } from "./cdp-client.js";

// Input selectors - contenteditable div is primary for Perplexity
const INPUT_SELECTORS = [
  '[contenteditable="true"]',
  'textarea[placeholder*="Ask"]',
  'textarea[placeholder*="Search"]',
  'textarea',
  'input[type="text"]',
];

export class CometAI {
  /**
   * Find the first matching element from a list of selectors
   */
  private async findInputElement(): Promise<string | null> {
    for (const selector of INPUT_SELECTORS) {
      const result = await cometClient.evaluate(`
        document.querySelector(${JSON.stringify(selector)}) !== null
      `);
      if (result.result.value === true) {
        return selector;
      }
    }
    return null;
  }

  /**
   * Send a prompt to Comet's AI (Perplexity)
   * Uses CDP Input.insertText as primary method (fires real browser InputEvents
   * that React's synthetic event system captures), with execCommand as fallback.
   */
  async sendPrompt(prompt: string): Promise<string> {
    const inputSelector = await this.findInputElement();

    if (!inputSelector) {
      throw new Error("Could not find input element. Navigate to Perplexity first.");
    }

    // Dismiss any modals/interstitials before typing
    await cometClient.evaluate(`
      (() => {
        for (const sel of ['button[aria-label="Close"]', 'button[aria-label="Dismiss"]', '[data-testid*="modal"] button']) {
          const el = document.querySelector(sel);
          if (el) el.click();
        }
      })()
    `);

    // Get input element coordinates for CDP mouse click (required for proper focus)
    const coords = await cometClient.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()
    `);

    const pos = coords.result.value as { x: number; y: number } | null;
    let typed = false;

    // Primary method: CDP Input.insertText (fires trusted InputEvents that React captures)
    if (pos) {
      try {
        // Focus via CDP mouse click (not JS .focus() — CDP click is trusted)
        await cometClient.cdpMouseClick(pos.x, pos.y);
        await new Promise(resolve => setTimeout(resolve, 200));

        // Select all existing text
        await cometClient.cdpSelectAll();
        await new Promise(resolve => setTimeout(resolve, 100));

        // Insert text via CDP — generates trusted InputEvent with inputType: "insertText"
        await cometClient.cdpInsertText(prompt);
        await new Promise(resolve => setTimeout(resolve, 200));
        typed = true;
      } catch {
        typed = false;
      }
    }

    // Fallback: execCommand (deprecated but still functional in Chromium for contenteditable)
    if (!typed) {
      const result = await cometClient.evaluate(`
        (() => {
          const el = document.querySelector('[contenteditable="true"]');
          if (el) {
            el.focus();
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, ${JSON.stringify(prompt)});
            return { success: true };
          }
          const textarea = document.querySelector('textarea');
          if (textarea) {
            textarea.focus();
            textarea.value = ${JSON.stringify(prompt)};
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            return { success: true };
          }
          return { success: false };
        })()
      `);
      typed = (result.result.value as { success: boolean })?.success ?? false;
    }

    if (!typed) {
      throw new Error("Failed to type into input element");
    }

    // Submit the prompt
    await this.submitPrompt();

    return `Prompt sent: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`;
  }

  /**
   * Submit the current prompt
   */
  private async submitPrompt(): Promise<void> {
    // Wait for React to process the typed content
    await new Promise(resolve => setTimeout(resolve, 300));

    // Verify text was typed before attempting submit.
    // Check ALL contenteditable elements (Perplexity uses nested Lexical editor)
    // and all textareas. Also check innerText/textContent/value across the subtree.
    const hasContent = await cometClient.evaluate(`
      (() => {
        const editables = document.querySelectorAll('[contenteditable="true"]');
        for (const el of editables) {
          const text = (el.innerText || el.textContent || '').trim();
          if (text.length > 0) return true;
        }
        const textareas = document.querySelectorAll('textarea');
        for (const ta of textareas) {
          if (ta.value && ta.value.trim().length > 0) return true;
        }
        const inputs = document.querySelectorAll('input[type="text"], input[type="search"]');
        for (const inp of inputs) {
          if (inp.value && inp.value.trim().length > 0) return true;
        }
        return false;
      })()
    `);

    if (!hasContent.result.value) {
      // Don't throw — Perplexity's DOM can hide typed text in child editors that
      // innerText/textContent don't surface. Submit anyway; an empty input is a
      // no-op server-side, and this avoids false-negatives from selector drift.
      console.error("[perplexity-comet] verify step saw no text — submitting anyway");
    }

    // Strategy 1: Simulate Enter key via DOM events (most reliable for contenteditable)
    const enterResult = await cometClient.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]') ||
                   document.querySelector('textarea');
        if (!el) return { success: false, reason: 'no input element' };

        el.focus();

        // Create and dispatch Enter key events
        const enterEvent = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        });

        el.dispatchEvent(enterEvent);

        // Also dispatch keyup
        const keyupEvent = new KeyboardEvent('keyup', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true
        });
        el.dispatchEvent(keyupEvent);

        return { success: true };
      })()
    `);

    await new Promise(resolve => setTimeout(resolve, 800));

    // Check if submission worked
    const submitted = await cometClient.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]');
        // If input is empty or nearly empty, submission worked
        if (el && el.innerText.trim().length < 5) return true;
        // Check for loading indicators
        const hasLoading = document.querySelector('[class*="animate-spin"], [class*="animate-pulse"]') !== null;
        const hasThinking = document.body.innerText.includes('Thinking');
        return hasLoading || hasThinking;
      })()
    `);
    if (submitted.result.value) return;

    // Strategy 2: Click the submit button directly
    const clickResult = await cometClient.evaluate(`
      (() => {
        // Try specific submit button selectors first
        const selectors = [
          'button[aria-label*="Submit"]',
          'button[aria-label*="Send"]',
          'button[aria-label*="Ask"]',
          'button[type="submit"]',
          'form button[type="button"]:last-of-type',
        ];

        for (const sel of selectors) {
          const btn = document.querySelector(sel);
          if (btn && !btn.disabled && btn.offsetParent !== null) {
            btn.click();
            return { success: true, method: 'selector', selector: sel };
          }
        }

        // Find the submit button by position (usually rightmost button near input)
        const inputEl = document.querySelector('[contenteditable="true"]') ||
                        document.querySelector('textarea');
        if (inputEl) {
          const inputRect = inputEl.getBoundingClientRect();
          let parent = inputEl.parentElement;
          let candidates = [];

          // Search up the DOM tree
          for (let i = 0; i < 5 && parent; i++) {
            const btns = parent.querySelectorAll('button');
            for (const btn of btns) {
              if (btn.disabled || btn.offsetParent === null) continue;

              const btnRect = btn.getBoundingClientRect();
              const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();

              // Skip mode/attach/voice/menu buttons (including post-Feb 2026 labels)
              if (ariaLabel.includes('search') || ariaLabel.includes('research') ||
                  ariaLabel.includes('labs') || ariaLabel.includes('learn') ||
                  ariaLabel.includes('attach') || ariaLabel.includes('voice') ||
                  ariaLabel.includes('menu') || ariaLabel.includes('more') ||
                  ariaLabel.includes('option') || ariaLabel.includes('council') ||
                  ariaLabel.includes('create files') || ariaLabel.includes('step by step')) {
                continue;
              }

              // Button should be visible and to the right of input
              if (btnRect.width > 0 && btnRect.height > 0) {
                candidates.push({ btn, x: btnRect.right, y: btnRect.top });
              }
            }
            parent = parent.parentElement;
          }

          // Click the rightmost button (usually submit)
          if (candidates.length > 0) {
            candidates.sort((a, b) => b.x - a.x);
            candidates[0].btn.click();
            return { success: true, method: 'position' };
          }
        }

        return { success: false, reason: 'no button found' };
      })()
    `);

    await new Promise(resolve => setTimeout(resolve, 500));

    // Final verification and last resort
    const finalCheck = await cometClient.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]');
        if (el && el.innerText.trim().length < 5) return true;
        const hasLoading = document.querySelector('[class*="animate"]') !== null;
        const hasThinking = document.body.innerText.includes('Thinking');
        return hasLoading || hasThinking;
      })()
    `);

    if (!finalCheck.result.value) {
      // Last resort: try form submit
      await cometClient.evaluate(`
        (() => {
          const form = document.querySelector('form');
          if (form) {
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          }
        })()
      `);
    }
  }

  // Track response stability for completion detection
  private lastResponseText: string = '';
  private stableResponseCount: number = 0;
  private readonly STABILITY_THRESHOLD: number = 2; // Response must be same for 2 checks

  /**
   * Check if response has stabilized (same content for multiple polls)
   */
  isResponseStable(currentResponse: string): boolean {
    if (currentResponse && currentResponse.length > 50) {
      if (currentResponse === this.lastResponseText) {
        this.stableResponseCount++;
      } else {
        this.stableResponseCount = 0;
        this.lastResponseText = currentResponse;
      }
      return this.stableResponseCount >= this.STABILITY_THRESHOLD;
    }
    return false;
  }

  /**
   * Reset stability tracking (call when starting new prompt)
   */
  resetStabilityTracking(): void {
    this.lastResponseText = '';
    this.stableResponseCount = 0;
  }

  /**
   * Get current agent status and progress (for polling)
   */
  async getAgentStatus(): Promise<{
    status: "idle" | "working" | "completed";
    steps: string[];
    currentStep: string;
    response: string;
    hasStopButton: boolean;
    agentBrowsingUrl: string;
    isStable: boolean;
  }> {
    // Get browsing URL from agent's tab
    let agentBrowsingUrl = '';
    try {
      const tabs = await cometClient.listTabsCategorized();
      if (tabs.agentBrowsing) {
        agentBrowsingUrl = tabs.agentBrowsing.url;
      }
    } catch {
      // Continue without URL
    }

    const result = await cometClient.safeEvaluate(`
      (() => {
        const body = document.body.innerText;

        // Check for active stop button (more comprehensive check)
        let hasActiveStopButton = false;
        for (const btn of document.querySelectorAll('button')) {
          const rect = btn.querySelector('rect');
          const svg = btn.querySelector('svg');
          const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          const btnText = btn.innerText.toLowerCase();

          // Stop button indicators: square icon (rect), "stop" label, or specific SVG patterns
          const isStopButton = rect ||
                              ariaLabel.includes('stop') ||
                              ariaLabel.includes('cancel') ||
                              btnText === 'stop';

          if (isStopButton && btn.offsetParent !== null && !btn.disabled) {
            hasActiveStopButton = true;
            break;
          }
        }

        // More comprehensive loading detection
        const hasLoadingSpinner = document.querySelector(
          '[class*="animate-spin"], [class*="animate-pulse"], [class*="loading"], [class*="thinking"]'
        ) !== null;

        // Check for "Thinking" indicator specifically
        const hasThinkingIndicator = body.includes('Thinking') && !body.includes('Thinking about');

        const hasStepsCompleted = /\\d+ steps? completed/i.test(body);
        const hasFinishedMarker = body.includes('Finished') && !hasActiveStopButton;
        const hasReviewedSources = /Reviewed \\d+ sources?/i.test(body);
        const hasSourcesIndicator = /\\d+\\s*sources?/i.test(body); // "10 sources" etc
        const hasAskFollowUp = body.includes('Ask a follow-up') ||
                               body.includes('Ask follow-up') ||
                               body.includes('Continue the conversation');
        // Deep Research specific completion signals (Feb 2026 UI)
        const hasDeepResearchDone = /Deep research complete/i.test(body) ||
                                     /Research complete/i.test(body) ||
                                     body.includes('Export to PDF') ||
                                     body.includes('Share report');

        // Check for prose content (actual response) - lowered threshold for short answers
        const proseEls = [...document.querySelectorAll('[class*="prose"]')];
        const hasProseContent = proseEls.some(el => {
          const text = el.innerText.trim();
          // Must have some content, not just UI text (lowered from 50 to 15 for short answers)
          return text.length > 15 && !text.startsWith('Library') && !text.startsWith('Discover');
        });

        // Check if input is focused (user might be typing, not agent working)
        const inputFocused = document.activeElement?.matches('[contenteditable], textarea, input');

        const workingPatterns = [
          'Working', 'Searching', 'Reviewing sources', 'Preparing to assist',
          'Clicking', 'Typing:', 'Navigating to', 'Reading', 'Analyzing',
          'Browsing', 'Looking at', 'Checking', 'Opening', 'Scrolling',
          'Waiting', 'Processing',
          'Running deep research', 'Synthesizing', 'Compiling report'
        ];
        const hasWorkingText = workingPatterns.some(p => body.includes(p));

        // Determine status with improved logic
        let status = 'idle';

        // FIRST: Check if actively working (stop button is the strongest indicator)
        if (hasActiveStopButton) {
          status = 'working';
        } else if (hasLoadingSpinner || hasThinkingIndicator) {
          status = 'working';
        }
        // SECOND: Check completion indicators BEFORE working text
        // (because completed pages still show historical step text)
        else if (hasDeepResearchDone && hasProseContent) {
          status = 'completed';
        } else if (hasStepsCompleted || hasFinishedMarker) {
          status = 'completed';
        } else if (hasAskFollowUp && hasProseContent) {
          status = 'completed';
        } else if (hasSourcesIndicator && hasProseContent && !hasActiveStopButton) {
          status = 'completed';
        } else if (hasReviewedSources && !hasActiveStopButton) {
          status = 'completed';
        }
        // THIRD: Fall back to working text patterns (only if no completion signals)
        else if (hasWorkingText) {
          status = 'working';
        }

        // Extract steps
        const steps = [];
        const stepPatterns = [
          /Preparing to assist[^\\n]*/g, /Clicking[^\\n]*/g, /Typing:[^\\n]*/g,
          /Navigating[^\\n]*/g, /Reading[^\\n]*/g, /Searching[^\\n]*/g, /Found[^\\n]*/g
        ];
        for (const pattern of stepPatterns) {
          const matches = body.match(pattern);
          if (matches) steps.push(...matches.map(s => s.trim().substring(0, 100)));
        }

        // Extract response - get the FULL FINAL response after agent completes
        let response = '';
        if (status === 'completed') {
          const mainContent = document.querySelector('main') || document.body;
          const bodyText = mainContent.innerText;

          // Strategy 1: Find content after "X steps completed" marker (agent's final response)
          const stepsMatch = bodyText.match(/(\\d+)\\s*steps?\\s*completed/i);
          if (stepsMatch) {
            const markerIndex = bodyText.indexOf(stepsMatch[0]);
            if (markerIndex !== -1) {
              // Get everything after the marker
              let afterMarker = bodyText.substring(markerIndex + stepsMatch[0].length).trim();

              // Remove the ">" or arrow that often follows
              afterMarker = afterMarker.replace(/^[>›→\\s]+/, '').trim();

              // Find where the response ends (before input area or UI elements)
              const endMarkers = ['Ask anything', 'Ask a follow-up', 'Ask follow-up', 'Add details', 'Type a message', 'Continue the conversation', 'Export to PDF', 'Share report'];
              let endIndex = afterMarker.length;
              for (const marker of endMarkers) {
                const idx = afterMarker.indexOf(marker);
                if (idx !== -1 && idx < endIndex) {
                  endIndex = idx;
                }
              }

              response = afterMarker.substring(0, endIndex).trim();
            }
          }

          // Strategy 2: If no steps marker, look for content after source citations
          if (!response || response.length < 50) {
            const sourcesMatch = bodyText.match(/Reviewed\\s+\\d+\\s+sources?/i);
            if (sourcesMatch) {
              const markerIndex = bodyText.indexOf(sourcesMatch[0]);
              if (markerIndex !== -1) {
                let afterMarker = bodyText.substring(markerIndex + sourcesMatch[0].length).trim();
                const endMarkers = ['Ask anything', 'Ask a follow-up', 'Ask follow-up', 'Add details', 'Continue the conversation', 'Export to PDF', 'Share report'];
                let endIndex = afterMarker.length;
                for (const marker of endMarkers) {
                  const idx = afterMarker.indexOf(marker);
                  if (idx !== -1 && idx < endIndex) endIndex = idx;
                }
                response = afterMarker.substring(0, endIndex).trim();
              }
            }
          }

          // Strategy 3: Fallback - get all prose content combined
          if (!response || response.length < 50) {
            const allProseEls = [...mainContent.querySelectorAll('[class*="prose"]')];
            const validTexts = allProseEls
              .filter(el => {
                if (el.closest('nav, aside, header, footer, form, [contenteditable]')) return false;
                const text = el.innerText.trim();
                const isUIText = ['Library', 'Discover', 'Spaces', 'Finance', 'Account',
                                  'Upgrade', 'Home', 'Search'].some(ui => text.startsWith(ui));
                return !isUIText && text.length > 30;
              })
              .map(el => el.innerText.trim());

            // Combine all valid prose texts, taking the last/most recent ones
            if (validTexts.length > 0) {
              // Take last 3 prose blocks max (most recent response)
              response = validTexts.slice(-3).join('\\n\\n');
            }
          }

          // Clean up response - preserve formatting but remove UI artifacts
          if (response) {
            response = response
              .replace(/View All/gi, '')
              .replace(/Show more/gi, '')
              .replace(/Ask a follow-up/gi, '')
              .replace(/Ask anything\\.*/gi, '')
              .replace(/Add details to this task\\.*/gi, '')
              .replace(/\\d+\\s*sources?\\s*$/gi, '')
              .replace(/[\\u{1F300}-\\u{1F9FF}]/gu, '') // Remove most emojis from UI
              .replace(/^[>›→\\s]+/gm, '') // Remove leading arrows
              .replace(/\\n{3,}/g, '\\n\\n') // Collapse multiple newlines
              .trim();
          }
        }

        return {
          status,
          steps: [...new Set(steps)].slice(-5),
          currentStep: steps.length > 0 ? steps[steps.length - 1] : '',
          response: response.substring(0, 8000),
          hasStopButton: hasActiveStopButton
        };
      })()
    `);

    const statusResult = result.result.value as {
      status: "idle" | "working" | "completed";
      steps: string[];
      currentStep: string;
      response: string;
      hasStopButton: boolean;
    };

    // Check response stability
    const isStable = this.isResponseStable(statusResult.response);

    // If response is stable and has content, override status to completed
    if (isStable && statusResult.response.length > 50 && !statusResult.hasStopButton) {
      statusResult.status = 'completed';
    }

    return {
      ...statusResult,
      agentBrowsingUrl,
      isStable,
    };
  }

  /**
   * Stop the current agent task
   */
  async stopAgent(): Promise<boolean> {
    const result = await cometClient.evaluate(`
      (() => {
        // Try aria-label buttons first
        for (const btn of document.querySelectorAll('button[aria-label*="Stop"], button[aria-label*="Cancel"]')) {
          btn.click();
          return true;
        }
        // Try square stop icon
        for (const btn of document.querySelectorAll('button')) {
          if (btn.querySelector('svg rect')) {
            btn.click();
            return true;
          }
        }
        return false;
      })()
    `);
    return result.result.value as boolean;
  }
}

export const cometAI = new CometAI();
