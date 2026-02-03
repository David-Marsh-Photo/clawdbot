import type { RequestClient } from "@buape/carbon";
import { isProgressEventData, type ProgressEventData } from "../../agents/tools/progress-tool.js";
import { loadConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { onAgentEvent, type AgentEventPayload } from "../../infra/agent-events.js";
import { resolveDiscordAccount } from "../accounts.js";
import { createDiscordClient } from "../send.shared.js";
import {
  clearChannelProgress,
  completeProgress,
  sendOrUpdateProgress,
  type ProgressConfig,
} from "./progress-manager.js";

// Track active sessions by runId for cleanup
const activeSessionsByRun = new Map<string, { channelId: string; sessionKey: string }>();

// Track Discord clients by account for reuse
const clientCache = new Map<string, { token: string; rest: RequestClient; expiresAt: number }>();

const CLIENT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getDiscordClient(accountId?: string): {
  token: string;
  rest: RequestClient;
} | null {
  const cfg = loadConfig();
  const cacheKey = accountId ?? "default";

  // Check cache
  const cached = clientCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { token: cached.token, rest: cached.rest };
  }

  // Create new client
  try {
    const accountInfo = resolveDiscordAccount({ cfg, accountId });
    const { token, rest } = createDiscordClient({ accountId }, cfg);

    // Cache the client
    clientCache.set(cacheKey, {
      token,
      rest,
      expiresAt: Date.now() + CLIENT_CACHE_TTL_MS,
    });

    return { token, rest };
  } catch (err) {
    logVerbose(`[progress-handler] Failed to create Discord client: ${String(err)}`);
    return null;
  }
}

function getProgressConfig(): ProgressConfig {
  // Use defaults for now - can be made configurable later
  return {
    minIntervalMs: 1000,
    defaultIntervalMs: 2000,
  };
}

async function handleProgressEvent(evt: AgentEventPayload) {
  if (evt.stream !== "progress") {
    return;
  }

  const data = evt.data;
  if (!isProgressEventData(data)) {
    logVerbose(`[progress-handler] Invalid progress event data`);
    return;
  }

  // Only handle Discord channels
  if (data.channelProvider !== "discord") {
    return;
  }

  const client = getDiscordClient();
  if (!client) {
    logVerbose("[progress-handler] No Discord client available");
    return;
  }

  const { channelId, progressId, sessionKey } = data;
  const opts = { token: client.token, rest: client.rest };
  const config = getProgressConfig();

  // Track session for cleanup
  if (sessionKey) {
    activeSessionsByRun.set(evt.runId, { channelId, sessionKey });
  }

  try {
    switch (data.action) {
      case "update": {
        if (!data.text) {
          logVerbose("[progress-handler] update action missing text");
          return;
        }
        await sendOrUpdateProgress({
          channelId,
          sessionKey: sessionKey ?? evt.runId,
          progressId,
          text: data.text,
          persist: data.persist,
          intervalMs: data.intervalMs,
          opts,
          config,
        });
        break;
      }

      case "complete": {
        await completeProgress(channelId, progressId, {
          rest: client.rest,
          persist: data.persist,
          finalText: data.finalText,
        });
        break;
      }

      case "clear": {
        await completeProgress(channelId, progressId, {
          rest: client.rest,
          persist: false,
        });
        break;
      }
    }
  } catch (err) {
    logVerbose(`[progress-handler] Error handling ${data.action}: ${String(err)}`);
  }
}

/**
 * Handle lifecycle events to clean up progress messages on turn end.
 */
async function handleLifecycleEvent(evt: AgentEventPayload) {
  if (evt.stream !== "lifecycle") {
    return;
  }

  const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";

  // Clean up on turn end
  if (phase === "end" || phase === "error") {
    const session = activeSessionsByRun.get(evt.runId);
    if (!session) {
      return;
    }

    const client = getDiscordClient();
    if (client) {
      await clearChannelProgress(session.channelId, {
        rest: client.rest,
      });
    }

    activeSessionsByRun.delete(evt.runId);
  }
}

let initialized = false;

/**
 * Initialize the progress event handler.
 * Call this once at startup to begin listening for progress events.
 */
export function initProgressHandler() {
  if (initialized) {
    return;
  }
  initialized = true;

  onAgentEvent((evt) => {
    if (evt.stream === "progress") {
      void handleProgressEvent(evt);
    } else if (evt.stream === "lifecycle") {
      void handleLifecycleEvent(evt);
    }
  });

  logVerbose("[progress-handler] Initialized");
}

/**
 * Clean up cached clients (call periodically to prevent memory leaks).
 */
export function cleanupProgressHandler() {
  const now = Date.now();
  for (const [key, cached] of clientCache) {
    if (cached.expiresAt < now) {
      clientCache.delete(key);
    }
  }
}
