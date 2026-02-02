import type { ImageContent } from "@mariozechner/pi-ai";
import type { TypingController } from "./reply/typing.js";

export type BlockReplyContext = {
  abortSignal?: AbortSignal;
  timeoutMs?: number;
};

/** Context passed to onModelSelected callback with actual model used. */
export type ModelSelectedContext = {
  provider: string;
  model: string;
  thinkLevel: string | undefined;
};

/** Status update during tool execution (for live progress messages). */
export type ToolStatusUpdate = {
  /** Tool name (e.g., "exec", "web_search") */
  toolName: string;
  /** Tool call ID */
  toolCallId: string;
  /** Current status */
  status: "running" | "completed" | "error";
  /** Human-readable summary (e.g., "Running command...", "3/7 agents completed") */
  summary?: string;
  /** Elapsed time in ms since tool started */
  elapsedMs?: number;
  /** Raw details from the tool (optional, for debugging) */
  details?: Record<string, unknown>;
  /** Last N chars of command output (for streaming display) */
  tail?: string;
};

export type GetReplyOptions = {
  /** Override run id for agent events (defaults to random UUID). */
  runId?: string;
  /** Abort signal for the underlying agent run. */
  abortSignal?: AbortSignal;
  /** Optional inbound images (used for webchat attachments). */
  images?: ImageContent[];
  /** Notifies when an agent run actually starts (useful for webchat command handling). */
  onAgentRunStart?: (runId: string) => void;
  onReplyStart?: () => Promise<void> | void;
  onTypingController?: (typing: TypingController) => void;
  isHeartbeat?: boolean;
  onPartialReply?: (payload: ReplyPayload) => Promise<void> | void;
  onReasoningStream?: (payload: ReplyPayload) => Promise<void> | void;
  onBlockReply?: (payload: ReplyPayload, context?: BlockReplyContext) => Promise<void> | void;
  onToolResult?: (payload: ReplyPayload) => Promise<void> | void;
  /** Called during long tool execution with status updates (for live progress). */
  onToolStatusUpdate?: (update: ToolStatusUpdate) => Promise<void> | void;
  /** Called when the actual model is selected (including after fallback).
   * Use this to get model/provider/thinkLevel for responsePrefix template interpolation. */
  onModelSelected?: (ctx: ModelSelectedContext) => void;
  disableBlockStreaming?: boolean;
  /** Timeout for block reply delivery (ms). */
  blockReplyTimeoutMs?: number;
  /** If provided, only load these skills for this session (empty = no skills). */
  skillFilter?: string[];
  /** Mutable ref to track if a reply was sent (for Slack "first" threading mode). */
  hasRepliedRef?: { value: boolean };
};

export type ReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
  replyToTag?: boolean;
  /** True when [[reply_to_current]] was present but not yet mapped to a message id. */
  replyToCurrent?: boolean;
  /** Send audio as voice message (bubble) instead of audio file. Defaults to false. */
  audioAsVoice?: boolean;
  isError?: boolean;
  /** Channel-specific payload data (per-channel envelope). */
  channelData?: Record<string, unknown>;
};
