import type { RequestClient } from "@buape/carbon";
import { logVerbose } from "../../globals.js";
import { deleteMessageDiscord, editMessageDiscord, sendMessageDiscord } from "../send.js";
import {
  appendThinking,
  getSummaryDisplay,
  clearSession as clearSummarizerSession,
  type SummarizerConfig,
} from "./reasoning-summarizer.js";

type ReasoningMessageEntry = {
  messageId: string;
  channelId: string;
  createdAt: number;
};

/** Max age for reasoning message entries (5 minutes). */
const REASONING_MESSAGE_TTL_MS = 5 * 60 * 1000;

/** Minimum time between updates to avoid rate limits (5 seconds for summarized display). */
const REASONING_THROTTLE_MS = 5000;

/** Default summarizer config (uses local vLLM with Qwen3-8B-AWQ). */
const DEFAULT_SUMMARIZER_CONFIG: SummarizerConfig = {
  baseUrl: "http://127.0.0.1:8000/v1",
  model: "Qwen/Qwen3-8B-AWQ",
  updateIntervalMs: 5000,
  timeoutMs: 15000, // vLLM can be slow on first request
};

/** Sweep interval for removing stale entries (2 minutes). */
const SWEEP_INTERVAL_MS = 2 * 60 * 1000;

/** Max content length with buffer for Discord's 2000 char limit. */
const MAX_CONTENT_LENGTH = 1900;

// Track active reasoning messages by "channelId:sessionKey" key
const activeReasoningMessages = new Map<string, ReasoningMessageEntry>();

// Track pending creation promises to prevent race conditions
const pendingCreates = new Map<string, Promise<void>>();

// Track last update times for throttling
const lastUpdateTimes = new Map<string, number>();

// Track closed sessions to prevent ghost messages after cleanup
const closedSessions = new Set<string>();

function isStale(entry: ReasoningMessageEntry): boolean {
  return Date.now() - entry.createdAt > REASONING_MESSAGE_TTL_MS;
}

function sweepStaleEntries(): void {
  const now = Date.now();
  for (const [key, entry] of activeReasoningMessages) {
    if (now - entry.createdAt > REASONING_MESSAGE_TTL_MS) {
      activeReasoningMessages.delete(key);
      lastUpdateTimes.delete(key);
    }
  }
}

// Start periodic sweep on module load
setInterval(sweepStaleEntries, SWEEP_INTERVAL_MS);

export type SendOrUpdateReasoningStreamParams = {
  channelId: string;
  sessionKey: string;
  content: string;
  isComplete?: boolean;
  opts: { token: string; rest?: RequestClient };
  summarizerConfig?: SummarizerConfig;
};

/**
 * Send a new reasoning stream message or edit an existing one.
 * Throttles updates to avoid Discord rate limits.
 * Uses vLLM summarization for a fixed-height display.
 */
export async function sendOrUpdateReasoningStream(
  params: SendOrUpdateReasoningStreamParams,
): Promise<void> {
  const key = `${params.channelId}:${params.sessionKey}`;
  const config = params.summarizerConfig ?? DEFAULT_SUMMARIZER_CONFIG;

  // Skip if session was already closed (prevents ghost messages)
  if (closedSessions.has(key)) {
    return;
  }

  // Append raw content to summarizer buffer (always, even if throttled)
  if (params.content) {
    appendThinking(key, params.content);
  }

  // Check throttle BEFORE async work to avoid race conditions
  const lastUpdate = lastUpdateTimes.get(key) ?? 0;
  const now = Date.now();
  const timeSinceUpdate = now - lastUpdate;

  // If we have an existing message and haven't waited long enough, skip
  const existing = activeReasoningMessages.get(key);
  if (
    existing &&
    !isStale(existing) &&
    timeSinceUpdate < REASONING_THROTTLE_MS &&
    !params.isComplete
  ) {
    console.log(`[reasoning-stream] throttled (${timeSinceUpdate}ms since last)`);
    return;
  }

  // Get formatted display (may trigger summarization)
  let displayContent = await getSummaryDisplay(key, config);

  // Re-check after async operation - session might have been closed
  if (closedSessions.has(key)) {
    return;
  }

  if (displayContent.length > MAX_CONTENT_LENGTH) {
    displayContent = displayContent.slice(0, MAX_CONTENT_LENGTH - 3) + "...";
  }

  // 1. Try to update existing message
  const existingAfterAsync = activeReasoningMessages.get(key);
  if (existingAfterAsync) {
    // Skip stale entries (treat as non-existent)
    if (isStale(existingAfterAsync)) {
      activeReasoningMessages.delete(key);
      lastUpdateTimes.delete(key);
    } else {
      console.log(`[reasoning-stream] editing message (${displayContent.length} chars)`);
      try {
        await editMessageDiscord(
          existingAfterAsync.channelId,
          existingAfterAsync.messageId,
          { content: displayContent },
          { rest: params.opts.rest },
        );
        lastUpdateTimes.set(key, Date.now());
      } catch (err) {
        // If message is gone (404) or other error, stop tracking it
        logVerbose(`discord: reasoning stream edit failed: ${String(err)}`);
        activeReasoningMessages.delete(key);
        lastUpdateTimes.delete(key);
      }

      if (params.isComplete) {
        activeReasoningMessages.delete(key);
        lastUpdateTimes.delete(key);
      }
      return;
    }
  }

  // 2. If creation is already in progress, wait for it
  if (pendingCreates.has(key)) {
    await pendingCreates.get(key);
    // Recursively retry - it should find the existing message now
    return sendOrUpdateReasoningStream(params);
  }

  // 3. Create new message (with lock)
  let resolveCreate: () => void;
  const createPromise = new Promise<void>((resolve) => {
    resolveCreate = resolve;
  });
  pendingCreates.set(key, createPromise);

  try {
    console.log(`[reasoning-stream] creating message (${displayContent.length} chars)`);
    const result = await sendMessageDiscord(
      `channel:${params.channelId}`,
      displayContent,
      params.opts,
    );

    const now = Date.now();
    // Only track if not immediately complete (rare but possible)
    if (!params.isComplete) {
      activeReasoningMessages.set(key, {
        messageId: result.messageId,
        channelId: result.channelId,
        createdAt: now,
      });
      lastUpdateTimes.set(key, now);
      console.log(`[reasoning-stream] message created (id=${result.messageId})`);
    }
  } catch (err) {
    // Log but don't block the main reply flow
    logVerbose(`discord: reasoning stream send failed: ${String(err)}`);
  } finally {
    pendingCreates.delete(key);
    resolveCreate!();
  }
}

/**
 * Clean up and delete a reasoning message (called when turn completes).
 */
export async function clearReasoningEntry(
  channelId: string,
  sessionKey: string,
  opts?: { rest?: RequestClient },
): Promise<void> {
  const key = `${channelId}:${sessionKey}`;

  // Mark session as closed to prevent any new messages
  closedSessions.add(key);

  const entry = activeReasoningMessages.get(key);

  // Delete the Discord message if it exists
  if (entry && opts) {
    try {
      await deleteMessageDiscord(entry.channelId, entry.messageId, { rest: opts.rest });
    } catch (err) {
      logVerbose(`discord: reasoning stream delete failed: ${String(err)}`);
    }
  }

  activeReasoningMessages.delete(key);
  lastUpdateTimes.delete(key);
  clearSummarizerSession(key);

  // Clean up closed session marker after a delay (allows in-flight requests to complete)
  setTimeout(() => closedSessions.delete(key), 30000);
}
