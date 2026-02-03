import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import type { AnyAgentTool } from "./common.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { jsonResult, readStringParam } from "./common.js";

const ProgressToolSchema = Type.Object({
  action: Type.Union([Type.Literal("update"), Type.Literal("complete"), Type.Literal("clear")], {
    description:
      'Action to perform. "update" sends/edits a progress message, "complete" finalizes it (delete unless persist=true), "clear" removes without finalizing.',
  }),
  id: Type.Optional(
    Type.String({
      description:
        "Progress message ID. Auto-generated on first update; pass the returned ID for subsequent updates to the same message.",
    }),
  ),
  text: Type.Optional(
    Type.String({
      description: "Progress message text. Required for update action.",
    }),
  ),
  persist: Type.Optional(
    Type.Boolean({
      description:
        "If true, message stays after turn ends or complete. Default: false (auto-delete).",
    }),
  ),
  intervalMs: Type.Optional(
    Type.Number({
      description: "Minimum milliseconds between updates. Clamped to config floor. Default: 2000.",
    }),
  ),
});

export type ProgressToolOptions = {
  /** Run ID for event emission. */
  runId?: string;
  /** Session key for event routing. */
  sessionKey?: string;
  /** Channel provider (e.g., "discord"). */
  channelProvider?: string;
  /** Channel ID for message routing. */
  channelId?: string;
};

/**
 * Create the progress tool.
 *
 * The tool emits "progress" events that are handled by channel-specific
 * listeners (e.g., Discord monitor) to send actual messages.
 */
export function createProgressTool(options?: ProgressToolOptions): AnyAgentTool {
  return {
    label: "Progress",
    name: "progress",
    description:
      "Send incremental status updates to the user mid-turn. Use for long-running tasks to show progress. Messages auto-delete when the turn ends unless persist=true. Rate-limited to avoid spam.",
    parameters: ProgressToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      // Generate or use provided progress ID
      const progressId =
        readStringParam(params, "id") ?? `progress-${crypto.randomUUID().slice(0, 8)}`;

      // Check if we have channel context
      if (!options?.channelId || !options?.channelProvider) {
        return jsonResult({
          ok: false,
          error: "Progress tool not available: no channel context",
        });
      }

      // Emit progress event
      const eventData: Record<string, unknown> = {
        action,
        progressId,
        channelProvider: options.channelProvider,
        channelId: options.channelId,
        sessionKey: options.sessionKey,
      };

      switch (action) {
        case "update": {
          const text = readStringParam(params, "text");
          if (!text) {
            return jsonResult({
              ok: false,
              error: "text is required for update action",
            });
          }
          const persist = typeof params.persist === "boolean" ? params.persist : false;
          const intervalMs = typeof params.intervalMs === "number" ? params.intervalMs : undefined;

          eventData.text = text;
          eventData.persist = persist;
          if (intervalMs !== undefined) {
            eventData.intervalMs = intervalMs;
          }

          emitAgentEvent({
            runId: options.runId ?? "unknown",
            stream: "progress",
            sessionKey: options.sessionKey,
            data: eventData,
          });

          return jsonResult({
            ok: true,
            id: progressId,
            hint: "Pass this id to update the same message",
          });
        }

        case "complete": {
          const persist = typeof params.persist === "boolean" ? params.persist : false;
          const finalText = readStringParam(params, "text");

          eventData.persist = persist;
          if (finalText) {
            eventData.finalText = finalText;
          }

          emitAgentEvent({
            runId: options.runId ?? "unknown",
            stream: "progress",
            sessionKey: options.sessionKey,
            data: eventData,
          });

          return jsonResult({
            ok: true,
            id: progressId,
            action: persist ? "persisted" : "deleted",
          });
        }

        case "clear": {
          emitAgentEvent({
            runId: options.runId ?? "unknown",
            stream: "progress",
            sessionKey: options.sessionKey,
            data: eventData,
          });

          return jsonResult({
            ok: true,
            id: progressId,
            action: "cleared",
          });
        }

        default:
          return jsonResult({
            ok: false,
            error: `Unknown action: ${action}. Use "update", "complete", or "clear".`,
          });
      }
    },
  };
}

/**
 * Check if a tool name is the progress tool.
 */
export function isProgressToolName(toolName: string): boolean {
  return toolName === "progress";
}

/**
 * Progress event data structure (for type safety in handlers).
 */
export type ProgressEventData = {
  action: "update" | "complete" | "clear";
  progressId: string;
  channelProvider: string;
  channelId: string;
  sessionKey?: string;
  text?: string;
  finalText?: string;
  persist?: boolean;
  intervalMs?: number;
};

/**
 * Type guard for progress event data.
 */
export function isProgressEventData(data: unknown): data is ProgressEventData {
  if (!data || typeof data !== "object") {
    return false;
  }
  const record = data as Record<string, unknown>;
  return (
    typeof record.action === "string" &&
    ["update", "complete", "clear"].includes(record.action) &&
    typeof record.progressId === "string" &&
    typeof record.channelProvider === "string" &&
    typeof record.channelId === "string"
  );
}
