import type { RequestClient } from "@buape/carbon";
import { editMessageDiscord, sendMessageDiscord } from "../send.js";

type StatusMessageEntry = {
  messageId: string;
  channelId: string;
  createdAt: number;
};

/** Max age for status message entries (30 minutes). */
const STATUS_MESSAGE_TTL_MS = 30 * 60 * 1000;

/** Sweep interval for removing stale entries (5 minutes). */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

// Track active status messages by "channelId:toolCallId" key
const activeStatusMessages = new Map<string, StatusMessageEntry>();

function isStale(entry: StatusMessageEntry): boolean {
  return Date.now() - entry.createdAt > STATUS_MESSAGE_TTL_MS;
}

function sweepStaleEntries(): void {
  const now = Date.now();
  for (const [key, entry] of activeStatusMessages) {
    if (now - entry.createdAt > STATUS_MESSAGE_TTL_MS) {
      activeStatusMessages.delete(key);
    }
  }
}

// Start periodic sweep on module load
setInterval(sweepStaleEntries, SWEEP_INTERVAL_MS);

// Track pending creation promises to prevent race conditions
const pendingCreates = new Map<string, Promise<void>>();

export type SendOrUpdateToolStatusParams = {
  channelId: string;
  toolCallId: string;
  content: string;
  isComplete?: boolean;
  opts: { token: string; rest?: RequestClient };
};

/**
 * Send a new tool status message or edit an existing one.
 * Tracks message IDs to avoid spamming the channel.
 */
export async function sendOrUpdateToolStatus(params: SendOrUpdateToolStatusParams): Promise<void> {
  const key = `${params.channelId}:${params.toolCallId}`;

  // 1. Try to update existing message
  const existing = activeStatusMessages.get(key);
  if (existing) {
    // Skip stale entries (treat as non-existent)
    if (isStale(existing)) {
      activeStatusMessages.delete(key);
    } else {
      try {
        await editMessageDiscord(
          existing.channelId,
          existing.messageId,
          { content: params.content },
          { rest: params.opts.rest },
        );
      } catch (err) {
        // If message is gone (404) or other error, stop tracking it so we might send a new one or stop failing
        // For now, assuming if edit fails, we should drop the entry to avoid infinite error loops
        activeStatusMessages.delete(key);
        // Optional: re-throw if you want the caller to know, but usually we want to be resilient
        // console.error("Failed to edit tool status message:", err);
      }

      if (params.isComplete) {
        activeStatusMessages.delete(key);
      }
      return;
    }
  }

  // 2. If creation is already in progress, wait for it
  if (pendingCreates.has(key)) {
    await pendingCreates.get(key);
    // Recursively retry - it should find the existing message now
    return sendOrUpdateToolStatus(params);
  }

  // 3. Create new message (with lock)
  let resolveCreate: () => void;
  const createPromise = new Promise<void>((resolve) => {
    resolveCreate = resolve;
  });
  pendingCreates.set(key, createPromise);

  try {
    const result = await sendMessageDiscord(
      `channel:${params.channelId}`,
      params.content,
      params.opts,
    );

    // Only track if not immediately complete (rare but possible)
    if (!params.isComplete) {
      activeStatusMessages.set(key, {
        messageId: result.messageId,
        channelId: result.channelId,
        createdAt: Date.now(),
      });
    }
  } catch (err) {
    // console.error("Failed to send tool status message:", err);
  } finally {
    pendingCreates.delete(key);
    resolveCreate!();
  }
}

/**
 * Clean up a status message entry (for error cases or manual cleanup).
 */
export function clearToolStatusEntry(channelId: string, toolCallId: string): void {
  const key = `${channelId}:${toolCallId}`;
  activeStatusMessages.delete(key);
}
