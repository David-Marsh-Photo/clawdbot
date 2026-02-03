import type { RequestClient } from "@buape/carbon";
import { logVerbose } from "../../globals.js";
import { deleteMessageDiscord, editMessageDiscord, sendMessageDiscord } from "../send.js";

type ProgressEntry = {
  messageId: string;
  channelId: string;
  createdAt: number;
  lastText: string;
  persist: boolean;
};

/** Max age for progress entries (5 minutes). */
const PROGRESS_TTL_MS = 5 * 60 * 1000;

/** Default minimum interval between updates (1 second floor). */
const MIN_INTERVAL_MS = 1000;

/** Default interval between updates. */
const DEFAULT_INTERVAL_MS = 2000;

/** Sweep interval for removing stale entries (2 minutes). */
const SWEEP_INTERVAL_MS = 2 * 60 * 1000;

/** Max content length with buffer for Discord's 2000 char limit. */
const MAX_CONTENT_LENGTH = 1900;

// Track active progress messages by "channelId:progressId" key
const activeProgressMessages = new Map<string, ProgressEntry>();

// Track pending creation promises to prevent race conditions
const pendingCreates = new Map<string, Promise<string>>();

// Track last update times for throttling (per progress ID)
const lastUpdateTimes = new Map<string, number>();

// Track closed sessions to prevent ghost messages after cleanup
const closedSessions = new Set<string>();

function isStale(entry: ProgressEntry): boolean {
  return Date.now() - entry.createdAt > PROGRESS_TTL_MS;
}

function sweepStaleEntries(): void {
  const now = Date.now();
  for (const [key, entry] of activeProgressMessages) {
    if (now - entry.createdAt > PROGRESS_TTL_MS) {
      activeProgressMessages.delete(key);
      lastUpdateTimes.delete(key);
    }
  }
}

// Start periodic sweep on module load
setInterval(sweepStaleEntries, SWEEP_INTERVAL_MS);

export type ProgressConfig = {
  minIntervalMs?: number;
  defaultIntervalMs?: number;
};

export type SendProgressParams = {
  channelId: string;
  sessionKey: string;
  progressId: string;
  text: string;
  persist?: boolean;
  intervalMs?: number;
  opts: { token: string; rest?: RequestClient };
  config?: ProgressConfig;
};

/**
 * Send a new progress message or update an existing one.
 * Throttles updates with last-write-wins coalescing.
 * Returns the progress ID for subsequent updates.
 */
export async function sendOrUpdateProgress(params: SendProgressParams): Promise<string> {
  const key = `${params.channelId}:${params.progressId}`;
  const minInterval = Math.max(MIN_INTERVAL_MS, params.config?.minIntervalMs ?? MIN_INTERVAL_MS);
  const effectiveInterval = Math.max(
    minInterval,
    params.intervalMs ?? params.config?.defaultIntervalMs ?? DEFAULT_INTERVAL_MS,
  );

  // Skip if session was already closed
  if (closedSessions.has(key)) {
    return params.progressId;
  }

  // Truncate content if needed
  let text = params.text;
  if (text.length > MAX_CONTENT_LENGTH) {
    text = text.slice(0, MAX_CONTENT_LENGTH - 3) + "...";
  }

  // Check throttle
  const lastUpdate = lastUpdateTimes.get(key) ?? 0;
  const now = Date.now();
  const timeSinceUpdate = now - lastUpdate;

  const existing = activeProgressMessages.get(key);

  // If we have an existing message and haven't waited long enough, skip (last-write-wins)
  if (existing && !isStale(existing) && timeSinceUpdate < effectiveInterval) {
    logVerbose(`[progress] throttled update for ${params.progressId}`);
    return params.progressId;
  }

  // Try to update existing message
  if (existing && !isStale(existing)) {
    try {
      await editMessageDiscord(
        existing.channelId,
        existing.messageId,
        { content: text },
        { rest: params.opts.rest },
      );
      existing.lastText = text;
      existing.persist = params.persist ?? existing.persist;
      lastUpdateTimes.set(key, Date.now());
      logVerbose(`[progress] edited message ${existing.messageId}`);
      return params.progressId;
    } catch (err) {
      // Message gone, remove tracking
      logVerbose(`[progress] edit failed: ${String(err)}`);
      activeProgressMessages.delete(key);
      lastUpdateTimes.delete(key);
    }
  }

  // If creation is already in progress, wait for it then retry
  const pendingCreate = pendingCreates.get(key);
  if (pendingCreate) {
    await pendingCreate;
    return sendOrUpdateProgress(params);
  }

  // Create new message
  let resolveCreate: (id: string) => void;
  const createPromise = new Promise<string>((resolve) => {
    resolveCreate = resolve;
  });
  pendingCreates.set(key, createPromise);

  try {
    const result = await sendMessageDiscord(`channel:${params.channelId}`, text, params.opts);

    activeProgressMessages.set(key, {
      messageId: result.messageId,
      channelId: result.channelId,
      createdAt: Date.now(),
      lastText: text,
      persist: params.persist ?? false,
    });
    lastUpdateTimes.set(key, Date.now());
    logVerbose(`[progress] created message ${result.messageId}`);

    resolveCreate!(params.progressId);
    return params.progressId;
  } catch (err) {
    logVerbose(`[progress] send failed: ${String(err)}`);
    resolveCreate!(params.progressId);
    return params.progressId;
  } finally {
    pendingCreates.delete(key);
  }
}

/**
 * Complete a progress message (optionally persist it, otherwise delete).
 */
export async function completeProgress(
  channelId: string,
  progressId: string,
  opts?: {
    rest?: RequestClient;
    persist?: boolean;
    finalText?: string;
  },
): Promise<void> {
  const key = `${channelId}:${progressId}`;
  const entry = activeProgressMessages.get(key);

  if (!entry) {
    return;
  }

  // Update with final text if provided
  if (opts?.finalText && opts.rest) {
    try {
      await editMessageDiscord(
        entry.channelId,
        entry.messageId,
        { content: opts.finalText },
        { rest: opts.rest },
      );
    } catch (err) {
      logVerbose(`[progress] final edit failed: ${String(err)}`);
    }
  }

  const shouldPersist = opts?.persist ?? entry.persist;

  if (!shouldPersist && opts?.rest) {
    try {
      await deleteMessageDiscord(entry.channelId, entry.messageId, { rest: opts.rest });
      logVerbose(`[progress] deleted message ${entry.messageId}`);
    } catch (err) {
      logVerbose(`[progress] delete failed: ${String(err)}`);
    }
  }

  activeProgressMessages.delete(key);
  lastUpdateTimes.delete(key);
}

/**
 * Clear all progress messages for a channel prefix (called on turn end).
 */
export async function clearChannelProgress(
  channelId: string,
  opts?: { rest?: RequestClient },
): Promise<void> {
  const prefix = `${channelId}:`;

  // Mark as closed to prevent new messages
  for (const key of activeProgressMessages.keys()) {
    if (key.startsWith(prefix)) {
      closedSessions.add(key);
    }
  }

  // Delete non-persisted messages
  const toDelete: ProgressEntry[] = [];
  for (const [key, entry] of activeProgressMessages) {
    if (key.startsWith(prefix) && !entry.persist) {
      toDelete.push(entry);
      activeProgressMessages.delete(key);
      lastUpdateTimes.delete(key);
    }
  }

  if (opts?.rest) {
    await Promise.all(
      toDelete.map(async (entry) => {
        try {
          await deleteMessageDiscord(entry.channelId, entry.messageId, { rest: opts.rest });
        } catch (err) {
          logVerbose(`[progress] cleanup delete failed: ${String(err)}`);
        }
      }),
    );
  }

  // Clean up closed session markers after delay
  setTimeout(() => {
    for (const key of closedSessions) {
      if (key.startsWith(prefix)) {
        closedSessions.delete(key);
      }
    }
  }, 30000);
}
