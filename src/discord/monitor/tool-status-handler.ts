import type { RequestClient } from "@buape/carbon";
import { loadConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { onAgentEvent, type AgentEventPayload } from "../../infra/agent-events.js";
import {
  clearChannelProgress,
  completeProgress,
  sendOrUpdateProgress,
} from "./progress-manager.js";

/**
 * Tool status handler - automatically shows progress for long-running tools.
 *
 * Listens for tool events and emits progress messages when:
 * - Tool has been running for > 3 seconds
 * - Tool is one of: exec, process, sessions_spawn, browser, web_fetch
 *
 * Messages auto-delete when tools complete.
 */

const LONG_RUNNING_TOOLS = new Set([
  "exec",
  "process",
  "sessions_spawn",
  "browser",
  "web_fetch",
  "web_search",
]);

// Minimum elapsed time before showing status (ms)
const MIN_ELAPSED_MS = 3000;

// Update interval (ms)
const UPDATE_INTERVAL_MS = 2000;

// Spinner frames for animation
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Track tool start times by runId:toolCallId
const toolStartTimes = new Map<string, { startedAt: number; toolName: string }>();

// Track which tools have had status messages sent
const toolStatusSent = new Map<string, number>(); // key -> last update time

// Track registered run contexts for channel routing
const runContexts = new Map<
  string,
  { channelId: string; sessionKey: string; token: string; rest: RequestClient }
>();

function isToolStatusEnabled(): boolean {
  const cfg = loadConfig();
  return cfg.channels?.discord?.toolStatusUpdates === true;
}

function formatToolStatus(toolName: string, elapsedMs: number): string {
  const spinnerIdx = Math.floor(elapsedMs / 500) % SPINNER_FRAMES.length;
  const spinner = SPINNER_FRAMES[spinnerIdx];
  const seconds = Math.round(elapsedMs / 1000);
  return `${spinner} **${toolName}** running (${seconds}s)`;
}

async function handleToolEvent(evt: AgentEventPayload) {
  if (evt.stream !== "tool") {
    return;
  }

  if (!isToolStatusEnabled()) {
    return;
  }

  const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
  const toolName = typeof evt.data.name === "string" ? evt.data.name : "";
  const toolCallId = typeof evt.data.toolCallId === "string" ? evt.data.toolCallId : "";

  if (!toolCallId) {
    return;
  }

  // Only track long-running tools
  if (!LONG_RUNNING_TOOLS.has(toolName)) {
    return;
  }

  const key = `${evt.runId}:${toolCallId}`;

  if (phase === "start") {
    toolStartTimes.set(key, { startedAt: Date.now(), toolName });
    return;
  }

  if (phase === "update") {
    const startInfo = toolStartTimes.get(key);
    if (!startInfo) {
      return;
    }

    const now = Date.now();
    const elapsedMs = now - startInfo.startedAt;

    // Only show status after minimum elapsed time
    if (elapsedMs < MIN_ELAPSED_MS) {
      return;
    }

    // Throttle updates
    const lastUpdate = toolStatusSent.get(key) ?? 0;
    if (now - lastUpdate < UPDATE_INTERVAL_MS) {
      return;
    }

    // Get run context for channel routing
    const ctx = runContexts.get(evt.runId);
    if (!ctx) {
      return;
    }

    toolStatusSent.set(key, now);

    try {
      await sendOrUpdateProgress({
        channelId: ctx.channelId,
        sessionKey: ctx.sessionKey,
        progressId: `tool-${toolCallId}`,
        text: formatToolStatus(startInfo.toolName, elapsedMs),
        persist: false,
        intervalMs: UPDATE_INTERVAL_MS,
        opts: { token: ctx.token, rest: ctx.rest },
      });
    } catch (err) {
      logVerbose(`[tool-status] Failed to send update: ${String(err)}`);
    }
    return;
  }

  if (phase === "result" || phase === "end") {
    const startInfo = toolStartTimes.get(key);
    const hadStatus = toolStatusSent.has(key);
    toolStartTimes.delete(key);
    toolStatusSent.delete(key);

    // Only clean up if we actually sent a status message
    if (!hadStatus || !startInfo) {
      return;
    }

    const ctx = runContexts.get(evt.runId);
    if (!ctx) {
      return;
    }

    // Complete (delete) the progress message
    try {
      await completeProgress(ctx.channelId, `tool-${toolCallId}`, {
        rest: ctx.rest,
        persist: false,
      });
    } catch (err) {
      logVerbose(`[tool-status] Failed to clear status: ${String(err)}`);
    }
  }
}

let initialized = false;

/**
 * Initialize the tool status handler.
 * Call this once at startup to begin listening for tool events.
 */
export function initToolStatusHandler() {
  if (initialized) {
    return;
  }
  initialized = true;

  onAgentEvent((evt) => {
    if (evt.stream === "tool") {
      void handleToolEvent(evt);
    }
  });

  logVerbose("[tool-status] Initialized");
}

/**
 * Register a run context for tool status routing.
 * Call this before dispatching a message to enable tool status updates.
 */
export function registerToolStatusContext(
  runId: string,
  context: {
    channelId: string;
    sessionKey: string;
    token: string;
    rest: RequestClient;
  },
) {
  runContexts.set(runId, context);
}

/**
 * Unregister a run context after dispatch completes.
 */
export function unregisterToolStatusContext(runId: string) {
  runContexts.delete(runId);

  // Clean up any orphaned tool tracking for this run
  for (const key of toolStartTimes.keys()) {
    if (key.startsWith(`${runId}:`)) {
      toolStartTimes.delete(key);
      toolStatusSent.delete(key);
    }
  }
}

/**
 * Clear all tool status messages for a channel.
 * Call this when a dispatch completes to clean up any lingering messages.
 */
export async function clearToolStatusForChannel(
  channelId: string,
  opts: { rest: RequestClient },
): Promise<void> {
  await clearChannelProgress(channelId, opts);
}
