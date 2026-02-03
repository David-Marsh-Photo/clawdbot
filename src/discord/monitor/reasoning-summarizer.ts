/**
 * Simple reasoning summarizer - accumulates thinking content and formats for display.
 * This is a minimal implementation that truncates rather than summarizes.
 * A future enhancement could use a local LLM for actual summarization.
 */

export type SummarizerConfig = {
  baseUrl: string;
  model: string;
  updateIntervalMs: number;
  timeoutMs: number;
};

/** Max chars to keep in buffer before truncating from the front. */
const MAX_BUFFER_CHARS = 4000;

/** Max chars to display (leaves room for formatting). */
const MAX_DISPLAY_CHARS = 1800;

// Track accumulated thinking per session
const sessionBuffers = new Map<string, string>();

/**
 * Append new thinking content to a session's buffer.
 */
export function appendThinking(sessionKey: string, content: string): void {
  const existing = sessionBuffers.get(sessionKey) ?? "";
  let combined = existing + content;

  // Truncate from the front if buffer exceeds max
  if (combined.length > MAX_BUFFER_CHARS) {
    combined = "..." + combined.slice(combined.length - MAX_BUFFER_CHARS + 3);
  }

  sessionBuffers.set(sessionKey, combined);
}

/**
 * Get formatted display content for a session.
 * Shows the most recent thinking, truncated to fit Discord's limits.
 */
export async function getSummaryDisplay(
  sessionKey: string,
  _config: SummarizerConfig,
): Promise<string> {
  const buffer = sessionBuffers.get(sessionKey) ?? "";

  if (!buffer) {
    return "*thinking...*";
  }

  // Get the tail of the buffer for display
  let display = buffer;
  if (display.length > MAX_DISPLAY_CHARS) {
    display = "..." + display.slice(display.length - MAX_DISPLAY_CHARS + 3);
  }

  // Format as a quote block with italic header
  const lines = display.split("\n").map((line) => `> ${line}`);
  return `*reasoning:*\n${lines.join("\n")}`;
}

/**
 * Clear a session's buffer (called when turn completes).
 */
export function clearSession(sessionKey: string): void {
  sessionBuffers.delete(sessionKey);
}
