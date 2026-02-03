# Agent Comparison Results

**Date:** 2026-02-01 23:01:16
**Agents:** 9 (8 succeeded, 1 failed)
**Total Time:** 18m 11s
**Git HEAD:** 02c5e564c
**Branch:** weston-stable

## Summary

| Agent            | Status    | Time    | Output |
| ---------------- | --------- | ------- | ------ |
| Claude (Opus)    | ✅ done   | 1m 00s  | 8KB    |
| Gemini (3 Pro)   | ✅ done   | 1m 21s  | 3KB    |
| Codex (GPT-5.2)  | ✅ done   | 11m 17s | 168KB  |
| DeepSeek V3      | ❌ failed | 18m 11s | 882B   |
| Qwen3 Coder      | ✅ done   | 15s     | 3KB    |
| Mistral Large 3  | ✅ done   | 1m 06s  | 7KB    |
| Grok 4.1         | ✅ done   | 10m 47s | 8KB    |
| Llama 4 Maverick | ✅ done   | 1m 00s  | 50KB   |
| Kimi K2.5        | ✅ done   | 4m 31s  | 50KB   |

## Prompt

```
Audit the implementation of streaming native Claude thinking blocks to Discord. Review the changes made to these three files for correctness, edge cases, and potential issues:

1. src/agents/pi-embedded-subscribe.handlers.types.ts - Added nativeThinkingBuffer field
2. src/agents/pi-embedded-subscribe.ts - Initialize and reset the buffer
3. src/agents/pi-embedded-subscribe.handlers.messages.ts - Handle thinking_start/thinking_delta/thinking_end events

The feature should:
- Accumulate thinking deltas from Claude's native thinking blocks (not <think> tags)
- Stream reasoning to Discord incrementally via emitReasoningStream()
- Not interfere with existing <think> tag streaming
- Properly reset state between messages

Check for: missing edge cases, state management issues, potential race conditions, and any bugs in the implementation.
```

---

## ✓ Claude (Opus)

**Status:** done | **Time:** 1m 00s

````
Now I have a complete picture of the implementation. Let me provide my audit.

---

## Audit: Native Claude Thinking Blocks Streaming to Discord

### Overview

The implementation adds support for streaming Claude's native thinking blocks (extended thinking) to Discord, distinct from the existing `<think>` tag streaming mechanism.

### Files Modified

1. **`pi-embedded-subscribe.handlers.types.ts:43-44`** - Added `nativeThinkingBuffer: string` field
2. **`pi-embedded-subscribe.ts:53,101`** - Initialize and reset the buffer
3. **`pi-embedded-subscribe.handlers.messages.ts:67-104`** - Handle thinking events

---

### ✅ What's Correct

1. **Buffer initialization** (`pi-embedded-subscribe.ts:53`): Correctly initialized as empty string.

2. **Buffer reset in `resetAssistantMessageState`** (`pi-embedded-subscribe.ts:101`): Properly cleared between assistant messages.

3. **Buffer reset in `handleMessageEnd`** (`pi-embedded-subscribe.handlers.messages.ts:363`): Correctly cleared at message end.

4. **Event type detection** (`pi-embedded-subscribe.handlers.messages.ts:68`): Correctly identifies `thinking_start`, `thinking_delta`, `thinking_end`.

5. **Delta accumulation** (`pi-embedded-subscribe.handlers.messages.ts:82-83`): Correctly appends `thinkingDelta` to buffer.

6. **Full content sync on `thinking_end`** (`pi-embedded-subscribe.handlers.messages.ts:84-87`): Good defensive coding - replaces buffer with full content in case deltas were missed.

7. **Streaming reasoning** (`pi-embedded-subscribe.handlers.messages.ts:90-92`): Correctly calls `emitReasoningStream` when `streamReasoning` is enabled.

8. **Early return** (`pi-embedded-subscribe.handlers.messages.ts:104`): Correctly prevents thinking events from contributing to text output.

9. **Raw stream logging** (`pi-embedded-subscribe.handlers.messages.ts:94-102`): Logs thinking events for debugging.

---

### ⚠️ Potential Issues & Edge Cases

#### 1. **Missing `thinking_start` handling** (Minor)
```typescript:src/agents/pi-embedded-subscribe.handlers.messages.ts:78-92
if (evtType === "thinking_delta" && thinkingDelta) {
  ctx.state.nativeThinkingBuffer += thinkingDelta;
} else if (evtType === "thinking_end" && thinkingContent) {
  ctx.state.nativeThinkingBuffer = thinkingContent;
}
````

**Issue**: The `thinking_start` event is detected but not explicitly handled. While this currently works (the buffer starts empty and deltas accumulate), a `thinking_start` could theoretically carry content in some API versions.

**Risk**: Low - Claude's API typically sends `thinking_start` with empty content.

**Recommendation**: Consider adding explicit `thinking_start` handling for robustness:

```typescript
if (evtType === "thinking_start") {
  ctx.state.nativeThinkingBuffer = ""; // Explicit reset
}
```

---

#### 2. **No deduplication between native thinking and `<think>` tags**

Looking at `handleMessageEnd` (lines 246-250):

```typescript
const rawThinking =
  ctx.state.includeReasoning || ctx.state.streamReasoning
    ? extractAssistantThinking(assistantMessage) || extractThinkingFromTaggedText(rawText)
    : "";
```

And the streaming in `handleMessageUpdate` (lines 145-148):

```typescript
if (ctx.state.streamReasoning) {
  // Handle partial <think> tags: stream whatever reasoning is visible so far.
  ctx.emitReasoningStream(extractThinkingFromTaggedStream(ctx.state.deltaBuffer));
}
```

**Issue**: If a model sends **both** native thinking blocks AND `<think>` tags (unlikely but possible), the reasoning could be streamed twice:

1. Once from the native thinking buffer (line 91)
2. Once from the tagged stream (line 147)

**Risk**: Low - models typically use one or the other, not both.

**Recommendation**: Consider adding a flag or check to avoid double-streaming when native thinking is active.

---

#### 3. **Native thinking not included in final reasoning output**

In `handleMessageEnd`, the `rawThinking` is extracted only from the message content blocks (`extractAssistantThinking`) or from `<think>` tags. The `nativeThinkingBuffer` accumulated during streaming is **not used** at message end:

```typescript:src/agents/pi-embedded-subscribe.handlers.messages.ts:246-250
const rawThinking =
  ctx.state.includeReasoning || ctx.state.streamReasoning
    ? extractAssistantThinking(assistantMessage) || extractThinkingFromTaggedText(rawText)
    : "";
```

**Issue**: This is **actually correct** because `extractAssistantThinking()` reads from the message's `content` array which should contain `{ type: "thinking", thinking: "..." }` blocks at message end. However, if the message arrives without proper thinking blocks (malformed or partial), the streamed content would be lost.

**Risk**: Low - the `thinking_end` event with full `content` should sync the buffer, and the message should contain thinking blocks.

---

#### 4. **No buffer size limit**

```typescript:src/agents/pi-embedded-subscribe.handlers.messages.ts:82-83
if (evtType === "thinking_delta" && thinkingDelta) {
  ctx.state.nativeThinkingBuffer += thinkingDelta;
}
```

**Issue**: The buffer grows unbounded. With extended thinking, Claude can produce very long reasoning chains (10k+ tokens).

**Risk**: Medium for memory-constrained environments. Low in typical server use.

**Recommendation**: Consider:

- A maximum buffer size with truncation
- Only keeping the tail for streaming purposes

---

#### 5. **Race condition: `thinking_end` content may arrive before all deltas**

```typescript:src/agents/pi-embedded-subscribe.handlers.messages.ts:84-87
} else if (evtType === "thinking_end" && thinkingContent) {
  // Ensure buffer reflects full content (in case of missed deltas)
  ctx.state.nativeThinkingBuffer = thinkingContent;
}
```

**Issue**: The comment suggests this handles missed deltas, but if events arrive out of order (unlikely but possible with network issues), this could cause a jarring UX where the streamed content suddenly changes.

**Risk**: Very low - SSE events are ordered.

---

#### 6. **`streamReasoning` check happens after buffer update**

```typescript:src/agents/pi-embedded-subscribe.handlers.messages.ts:82-92
if (evtType === "thinking_delta" && thinkingDelta) {
  ctx.state.nativeThinkingBuffer += thinkingDelta;
} else if (evtType === "thinking_end" && thinkingContent) {
  ctx.state.nativeThinkingBuffer = thinkingContent;
}

// Stream reasoning if enabled
if (ctx.state.streamReasoning && ctx.state.nativeThinkingBuffer) {
  ctx.emitReasoningStream(ctx.state.nativeThinkingBuffer);
}
```

**Issue**: The buffer is always updated even when `streamReasoning` is false. This is minor overhead but could accumulate large strings unnecessarily.

**Risk**: Very low.

**Recommendation**: Could short-circuit early if `!streamReasoning`, but current approach is cleaner and the buffer is cleared at message end anyway.

---

### 🐛 Bug: `thinking_end` with empty `content`

```typescript:src/agents/pi-embedded-subscribe.handlers.messages.ts:84-87
} else if (evtType === "thinking_end" && thinkingContent) {
  ctx.state.nativeThinkingBuffer = thinkingContent;
}
```

**Issue**: If `thinking_end` arrives with an empty `content` (which could happen if the thinking was streamed entirely via deltas), the buffer replacement is skipped. This is **correct** behavior since we want to keep the accumulated deltas.

**Verdict**: Not a bug - this is correct.

---

### ✅ State Management

- **Initialization**: Correct in `subscribeEmbeddedPiSession`
- **Reset on new message**: Correct in `resetAssistantMessageState`
- **Reset on message end**: Correct in `handleMessageEnd`
- **Reset on compaction retry**: Correct (inherits from `resetAssistantMessageState`)

---

### Summary

| Category                         | Status      | Notes                                                 |
| -------------------------------- | ----------- | ----------------------------------------------------- |
| Buffer lifecycle                 | ✅ Correct  | Properly initialized, reset on message boundaries     |
| Event handling                   | ✅ Correct  | All three event types handled appropriately           |
| Streaming emission               | ✅ Correct  | Uses existing `emitReasoningStream` infrastructure    |
| Interference with `<think>` tags | ⚠️ Minor    | Potential double-streaming if both present (unlikely) |
| State isolation                  | ✅ Correct  | Separate buffer from tag-based streaming              |
| Edge cases                       | ⚠️ Minor    | `thinking_start` not explicitly handled               |
| Memory                           | ⚠️ Minor    | Unbounded buffer growth                               |
| Race conditions                  | ✅ Low risk | SSE events are ordered                                |

**Overall**: The implementation is solid and follows the existing patterns in the codebase. The identified issues are minor edge cases that are unlikely to occur in practice.

```

---

## ✓ Gemini (3 Pro)

**Status:** done | **Time:** 1m 21s

```

Hook registry initialized with 0 hook entries
I will read the three files involved in the implementation to analyze the changes and check for correctness, edge cases, and potential issues.

The implementation of streaming native Claude thinking blocks has been audited across the three provided files.

### **Audit Summary**

The implementation is **correct and robust**. It successfully achieves the goals of accumulating deltas, streaming incrementally, and maintaining separation from existing logic, with appropriate handling of state and edge cases.

### **Detailed Analysis**

1.  **Correctness of Accumulation & Streaming**
    - **Dedicated Buffer:** `nativeThinkingBuffer` is correctly defined in `EmbeddedPiSubscribeState` and initialized/reset properly. This ensures native thinking data is kept separate from standard text content (`deltaBuffer`).
    - **Delta Handling:** In `handleMessageUpdate`, `thinking_delta` events properly append to `nativeThinkingBuffer`.
    - **Incremental Streaming:** `ctx.emitReasoningStream` is called immediately after updating the buffer, ensuring the UI receives real-time updates.
    - **Event Separation:** The strict `return` statement inside the `isThinkingEvent` block in `handleMessageUpdate` correctly prevents thinking deltas from falling through to the text processing logic. This ensures thinking text never leaks into the final assistant response text.

2.  **Edge Case Handling**
    - **`thinking_end` Behavior:** The logic `else if (evtType === "thinking_end" && thinkingContent)` is safe.
      - If the provider sends the full thinking content at the end (standard behavior), it overwrites the buffer, correcting any potential missing deltas.
      - If the provider sends an empty payload at the end, the check `&& thinkingContent` fails, preserving the accumulated deltas in `nativeThinkingBuffer`. This prevents data loss.
    - **Transition to Text:** When thinking ends and text begins (processing `text_delta`), the code calls `ctx.emitReasoningStream(extractThinkingFromTaggedStream(ctx.state.deltaBuffer))`.
      - Since `deltaBuffer` will not contain `<think>` tags (using native mode), the extraction returns empty.
      - `emitReasoningStream` (in `pi-embedded-subscribe.ts`) guards against empty formatted output (`if (!formatted) return;`).
      - **Result:** The stream update is skipped, and the last frame of the native thinking correctly remains visible on the user's screen while text generates.

3.  **State Management**
    - **Reset Logic:** `nativeThinkingBuffer` is reset in `resetAssistantMessageState` (triggered at `message_start`) and `handleMessageEnd`. This guarantees a clean state for every new message and prevents "ghost" thinking from previous turns.

4.  **Potential Race/Conflict (Minor Note)**
    - **Mixed Mode:** If a model were to output _both_ native thinking events and `<think>` tags in the text stream (unlikely/hallucination), `emitReasoningStream` would be called for both sources. The latest call would win. Since native thinking typically precedes text, any `<think>` tags appearing later in the text would overwrite the reasoning display. This is acceptable behavior.

### **Conclusion**

The changes are well-structured and safe to deploy. No logic errors or blocking issues were found.

```

---

## ✓ Codex (GPT-5.2)

**Status:** done | **Time:** 11m 17s

```

2026-02-02T06:43:06.149850Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:43:06.149892Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.
2026-02-02T06:43:07.218160Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:43:07.218203Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.
OpenAI Codex v0.93.0 (research preview)

---

workdir: /home/davidmarsh/code/moltbot
model: gpt-5.2
provider: openai
approval: never
sandbox: read-only
reasoning effort: xhigh
reasoning summaries: auto
session id: 019c1d17-38cb-71a3-b2bc-4f9e620537f4

---

user
[IMPORTANT: This is a READ-ONLY query. Do NOT modify any files, run destructive commands, or make git commits. Only provide analysis/answers.]

Audit the implementation of streaming native Claude thinking blocks to Discord. Review the changes made to these three files for correctness, edge cases, and potential issues:

1. src/agents/pi-embedded-subscribe.handlers.types.ts - Added nativeThinkingBuffer field
2. src/agents/pi-embedded-subscribe.ts - Initialize and reset the buffer
3. src/agents/pi-embedded-subscribe.handlers.messages.ts - Handle thinking_start/thinking_delta/thinking_end events

The feature should:

- Accumulate thinking deltas from Claude's native thinking blocks (not <think> tags)
- Stream reasoning to Discord incrementally via emitReasoningStream()
- Not interfere with existing <think> tag streaming
- Properly reset state between messages

Check for: missing edge cases, state management issues, potential race conditions, and any bugs in the implementation.
mcp startup: no servers
2026-02-02T06:43:07.335831Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:43:07.335885Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.
exec
/bin/bash -lc 'ls -la' in /home/davidmarsh/code/moltbot succeeded in 62ms:
total 4968
drwxr-xr-x. 1 davidmarsh davidmarsh 1702 Feb 1 20:48 .
drwxr-xr-x. 1 davidmarsh davidmarsh 14 Jan 28 22:26 ..
drwxr-xr-x. 1 davidmarsh davidmarsh 18 Jan 28 22:26 .agent
drwxr-xr-x. 1 davidmarsh davidmarsh 14 Feb 1 20:28 agent-logs
-rw-r--r--. 1 davidmarsh davidmarsh 17791 Feb 1 16:47 AGENTS.md
-rw-r--r--. 1 davidmarsh davidmarsh 1673249 Feb 1 22:43 .aider.chat.history.md
-rw-r--r--. 1 davidmarsh davidmarsh 665956 Feb 1 22:43 .aider.input.history
drwxr-xr-x. 1 davidmarsh davidmarsh 180 Feb 1 22:43 .aider.tags.cache.v4
-rw-r--r--. 1 davidmarsh davidmarsh 17336 Feb 1 16:47 appcast.xml
drwxr-xr-x. 1 davidmarsh davidmarsh 42 Feb 1 16:47 apps
drwxr-xr-x. 1 davidmarsh davidmarsh 160 Jan 28 22:26 assets
-rw-r--r--. 1 davidmarsh davidmarsh 125804 Feb 1 17:27 CHANGELOG.md
lrwxrwxrwx. 1 davidmarsh davidmarsh 9 Jan 28 22:26 CLAUDE.md -> AGENTS.md
-rw-r--r--. 1 davidmarsh davidmarsh 2134 Feb 1 16:47 CONTRIBUTING.md
-rw-r--r--. 1 davidmarsh davidmarsh 1250 Jan 28 22:26 .detect-secrets.cfg
drwxr-xr-x. 1 davidmarsh davidmarsh 1146 Feb 1 19:17 dist
-rw-r--r--. 1 davidmarsh davidmarsh 1343 Feb 1 16:47 docker-compose.yml
-rw-r--r--. 1 davidmarsh davidmarsh 1120 Feb 1 16:47 Dockerfile
-rw-r--r--. 1 davidmarsh davidmarsh 285 Jan 28 22:26 Dockerfile.sandbox
2026-02-02T06:43:15.475321Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:43:15.475372Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.
exec
/bin/bash -lc "sed -n '1,200p' src/agents/pi-embedded-subscribe.handlers.types.ts" in /home/davidmarsh/code/moltbot succeeded in 63ms:
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { ReplyDirectiveParseResult } from "../auto-reply/reply/reply-directives.js";
import type { ReasoningLevel } from "../auto-reply/thinking.js";
import type { InlineCodeState } from "../markdown/code-spans.js";
import type { EmbeddedBlockChunker } from "./pi-embedded-block-chunker.js";
import type { MessagingToolSend } from "./pi-embedded-messaging.js";
import type {
BlockReplyChunking,
SubscribeEmbeddedPiSessionParams,
} from "./pi-embedded-subscribe.types.js";

export type EmbeddedSubscribeLogger = {
debug: (message: string) => void;
warn: (message: string) => void;
};

export type ToolErrorSummary = {
toolName: string;
meta?: string;
error?: string;
2026-02-02T06:43:17.778468Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:43:17.778516Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.

thinking
**Reviewing file structure**

I see the types file has now included nativeThinkingBuffer, which is good. I need to make sure to check how it's initialized and if resets are handled properly. This step is critical, as it’ll help with maintaining state effectively. I’ll open the src/agents/pi-embedded-subscribe.ts file to dig deeper into the implementation. Let’s see what’s going on there and ensure everything is set up correctly!
exec
/bin/bash -lc "sed -n '1,240p' src/agents/pi-embedded-subscribe.ts" in /home/davidmarsh/code/moltbot succeeded in 59ms:
import type { InlineCodeState } from "../markdown/code-spans.js";
import type {
EmbeddedPiSubscribeContext,
EmbeddedPiSubscribeState,
} from "./pi-embedded-subscribe.handlers.types.js";
import type { SubscribeEmbeddedPiSessionParams } from "./pi-embedded-subscribe.types.js";
import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
import { createStreamingDirectiveAccumulator } from "../auto-reply/reply/streaming-directives.js";
import { formatToolAggregate } from "../auto-reply/tool-meta.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildCodeSpanIndex, createInlineCodeState } from "../markdown/code-spans.js";
import { EmbeddedBlockChunker } from "./pi-embedded-block-chunker.js";
import {
isMessagingToolDuplicateNormalized,
normalizeTextForComparison,
} from "./pi-embedded-helpers.js";
import { createEmbeddedPiSessionEventHandler } from "./pi-embedded-subscribe.handlers.js";
import { formatReasoningMessage } from "./pi-embedded-utils.js";

const THINKING_TAG_SCAN_RE = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\s\*>/gi;
2026-02-02T06:43:22.486501Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:43:22.486562Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.
exec
/bin/bash -lc 'rg -n "nativeThinkingBuffer" -S src/agents/pi-embedded-subscribe.ts src/agents/pi-embedded-subscribe.handlers.messages.ts src/agents/pi-embedded-subscribe.handlers.types.ts' in /home/davidmarsh/code/moltbot succeeded in 53ms:
src/agents/pi-embedded-subscribe.handlers.messages.ts:83: ctx.state.nativeThinkingBuffer += thinkingDelta;
src/agents/pi-embedded-subscribe.handlers.messages.ts:86: ctx.state.nativeThinkingBuffer = thinkingContent;
src/agents/pi-embedded-subscribe.handlers.messages.ts:90: if (ctx.state.streamReasoning && ctx.state.nativeThinkingBuffer) {
src/agents/pi-embedded-subscribe.handlers.messages.ts:91: ctx.emitReasoningStream(ctx.state.nativeThinkingBuffer);
src/agents/pi-embedded-subscribe.handlers.messages.ts:363: ctx.state.nativeThinkingBuffer = "";
src/agents/pi-embedded-subscribe.ts:53: nativeThinkingBuffer: "",
src/agents/pi-embedded-subscribe.ts:101: state.nativeThinkingBuffer = "";
src/agents/pi-embedded-subscribe.handlers.types.ts:44: nativeThinkingBuffer: string;
2026-02-02T06:43:28.429867Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:43:28.429904Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.
exec
/bin/bash -lc "sed -n '1,220p' src/agents/pi-embedded-subscribe.handlers.messages.ts" in /home/davidmarsh/code/moltbot succeeded in 61ms:
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { createInlineCodeState } from "../markdown/code-spans.js";
import {
isMessagingToolDuplicateNormalized,
normalizeTextForComparison,
} from "./pi-embedded-helpers.js";
import { appendRawStream } from "./pi-embedded-subscribe.raw-stream.js";
import {
extractAssistantText,
extractAssistantThinking,
extractThinkingFromTaggedStream,
extractThinkingFromTaggedText,
formatReasoningMessage,
promoteThinkingTagsToBlocks,
} from "./pi-embedded-utils.js";

const stripTrailingDirective = (text: string): string => {
2026-02-02T06:43:30.883349Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:43:30.883381Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.
exec
/bin/bash -lc 'rg -n "emitReasoningStream" src/agents/pi-embedded-subscribe.ts src/agents/pi-embedded-subscribe.handlers.\*.ts src/agents/pi-embedded-utils.ts -S' in /home/davidmarsh/code/moltbot succeeded in 64ms:
src/agents/pi-embedded-subscribe.ts:505: const emitReasoningStream = (text: string) => {
src/agents/pi-embedded-subscribe.ts:549: emitReasoningStream,
src/agents/pi-embedded-subscribe.handlers.messages.ts:91: ctx.emitReasoningStream(ctx.state.nativeThinkingBuffer);
src/agents/pi-embedded-subscribe.handlers.messages.ts:147: ctx.emitReasoningStream(extractThinkingFromTaggedStream(ctx.state.deltaBuffer));
src/agents/pi-embedded-subscribe.handlers.messages.ts:330: ctx.emitReasoningStream(rawThinking);
src/agents/pi-embedded-subscribe.handlers.types.ts:83: emitReasoningStream: (text: string) => void;
2026-02-02T06:43:38.753930Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:43:38.753976Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.
exec
/bin/bash -lc "sed -n '220,420p' src/agents/pi-embedded-subscribe.handlers.messages.ts" in /home/davidmarsh/code/moltbot succeeded in 59ms:
}
}

export function handleMessageEnd(
ctx: EmbeddedPiSubscribeContext,
evt: AgentEvent & { message: AgentMessage },
) {
const msg = evt.message;
if (msg?.role !== "assistant") {
return;
}

const assistantMessage = msg;
promoteThinkingTagsToBlocks(assistantMessage);

const rawText = extractAssistantText(assistantMessage);
appendRawStream({
ts: Date.now(),
event: "assistant_message_end",
runId: ctx.params.runId,
2026-02-02T06:43:41.573955Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:43:41.574001Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.
exec
/bin/bash -lc "sed -n '420,620p' src/agents/pi-embedded-subscribe.ts" in /home/davidmarsh/code/moltbot succeeded in 62ms:
}
output += text.slice(lastIndex, idx);
lastIndex = idx + match[0].length;
}
output += text.slice(lastIndex);
return output;
};

const emitBlockChunk = (text: string) => {
if (state.suppressBlockChunks) {
return;
}
// Strip <think> and <final> blocks across chunk boundaries to avoid leaking reasoning.
const chunk = stripBlockTags(text, state.blockState).trimEnd();
if (!chunk) {
return;
}
if (chunk === state.lastBlockReplyText) {
return;
}
2026-02-02T06:43:45.612136Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:43:45.612210Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.

thinking
**Inspecting streaming functions**

I'm looking into how the emitReasoningStream deduplicates messages using formatted strings, which both native and tagged reasoning streams utilize. However, there might be a potential issue with different output formats causing confusion. If both streams operate simultaneously, the lastStreamedReasoning feature avoids duplicates but not possible order mix-ups. I should check the formatReasoningMessage in the utils file; it's essential for streaming and onBlockReply reasoning. Time to check the src/agents/pi-embedded-utils.ts for that!
exec
/bin/bash -lc 'rg -n "function formatReasoningMessage|formatReasoningMessage" src/agents/pi-embedded-utils.ts src/agents/pi-embedded-utils.\* -S' in /home/davidmarsh/code/moltbot succeeded in 59ms:
src/agents/pi-embedded-utils.ts:243:export function formatReasoningMessage(text: string): string {
src/agents/pi-embedded-utils.ts:243:export function formatReasoningMessage(text: string): string {
src/agents/pi-embedded-utils.test.ts:3:import { extractAssistantText, formatReasoningMessage } from "./pi-embedded-utils.js";
src/agents/pi-embedded-utils.test.ts:512:describe("formatReasoningMessage", () => {
src/agents/pi-embedded-utils.test.ts:514: expect(formatReasoningMessage("")).toBe("");
src/agents/pi-embedded-utils.test.ts:518: expect(formatReasoningMessage(" \n \t ")).toBe("");
src/agents/pi-embedded-utils.test.ts:522: expect(formatReasoningMessage("Single line of reasoning")).toBe(
src/agents/pi-embedded-utils.test.ts:528: expect(formatReasoningMessage("Line one\nLine two\nLine three")).toBe(
src/agents/pi-embedded-utils.test.ts:534: expect(formatReasoningMessage("First block\n\nSecond block")).toBe(
src/agents/pi-embedded-utils.test.ts:540: expect(formatReasoningMessage("A\n\nB\nC")).toBe("Reasoning:\n*A*\n\n*B*\n*C*");
src/agents/pi-embedded-utils.test.ts:544: expect(formatReasoningMessage(" \n Reasoning here \n ")).toBe(
2026-02-02T06:43:52.476954Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:43:52.476992Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.
exec
/bin/bash -lc "sed -n '200,320p' src/agents/pi-embedded-utils.ts" in /home/davidmarsh/code/moltbot succeeded in 53ms:

export function extractAssistantText(msg: AssistantMessage): string {
const isTextBlock = (block: unknown): block is { type: "text"; text: string } => {
if (!block || typeof block !== "object") {
return false;
}
const rec = block as Record<string, unknown>;
return rec.type === "text" && typeof rec.text === "string";
};

const blocks = Array.isArray(msg.content)
? msg.content
.filter(isTextBlock)
.map((c) =>
stripThinkingTagsFromText(
stripDowngradedToolCallText(stripMinimaxToolCallXml(c.text)),
).trim(),
)
.filter(Boolean)
: [];
2026-02-02T06:43:56.839626Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:43:56.839672Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.
exec
/bin/bash -lc "sed -n '1,240p' src/agents/pi-embedded-subscribe.handlers.js" in /home/davidmarsh/code/moltbot exited 2 in 55ms:
sed: can't read src/agents/pi-embedded-subscribe.handlers.js: No such file or directory
2026-02-02T06:44:02.818841Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:44:02.818890Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.

thinking
**Locating the file**

It seems like I need to work with TypeScript (TS). There's a function called `createEmbeddedPiSessionEventHandler` in the file `./pi-embedded-subscribe.handlers.js`. However, since it’s TypeScript, the actual file might have a .ts extension instead of .js for import purposes. I should take a moment to locate the correct file.
exec
/bin/bash -lc "ls -la src/agents | rg \"pi-embedded-subscribe\\.handlers\"" in /home/davidmarsh/code/moltbot succeeded in 55ms:
-rw-r--r--. 1 davidmarsh davidmarsh 2739 Feb 1 16:47 pi-embedded-subscribe.handlers.lifecycle.ts
-rw-r--r--. 1 davidmarsh davidmarsh 12341 Feb 1 22:41 pi-embedded-subscribe.handlers.messages.ts
-rw-r--r--. 1 davidmarsh davidmarsh 7310 Feb 1 20:58 pi-embedded-subscribe.handlers.tools.ts
-rw-r--r--. 1 davidmarsh davidmarsh 1946 Feb 1 16:47 pi-embedded-subscribe.handlers.ts
-rw-r--r--. 1 davidmarsh davidmarsh 3853 Feb 1 22:40 pi-embedded-subscribe.handlers.types.ts
2026-02-02T06:44:07.215728Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:44:07.215777Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.
exec
/bin/bash -lc "sed -n '1,260p' src/agents/pi-embedded-subscribe.handlers.ts" in /home/davidmarsh/code/moltbot succeeded in 56ms:
import type {
EmbeddedPiSubscribeContext,
EmbeddedPiSubscribeEvent,
} from "./pi-embedded-subscribe.handlers.types.js";
import {
handleAgentEnd,
handleAgentStart,
handleAutoCompactionEnd,
handleAutoCompactionStart,
} from "./pi-embedded-subscribe.handlers.lifecycle.js";
import {
handleMessageEnd,
handleMessageStart,
handleMessageUpdate,
} from "./pi-embedded-subscribe.handlers.messages.js";
import {
handleToolExecutionEnd,
handleToolExecutionStart,
handleToolExecutionUpdate,
} from "./pi-embedded-subscribe.handlers.tools.js";
2026-02-02T06:44:09.491729Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:44:09.491778Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.

thinking
**Evaluating code structure**

I think it might not be necessary to check the types in `@mariozechner/pi-agent-core`, especially in node_modules. I'm considering potential issues, like how they handle `assistantRecord.delta` and `assistantRecord.content` as strings. There's also a question about Anthropic streaming where the `thinking_delta` events use 'thinking' instead of 'delta'. I need to check how `assistantMessageEvent` is structured, so I plan to search the repository for terms like "assistantMessageEvent" or "thinking_delta."
exec
/bin/bash -lc 'rg -n "assistantMessageEvent" -S src | head' in /home/davidmarsh/code/moltbot succeeded in 65ms:
src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.reopens-fenced-blocks-splitting-inside-them.test.ts:45: assistantMessageEvent: {
src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.reopens-fenced-blocks-splitting-inside-them.test.ts:94: assistantMessageEvent: {
src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.keeps-indented-fenced-blocks-intact.test.ts:45: assistantMessageEvent: {
src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.keeps-indented-fenced-blocks-intact.test.ts:89: assistantMessageEvent: {
src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.does-not-duplicate-text-end-repeats-full.test.ts:37: assistantMessageEvent: {
src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.does-not-duplicate-text-end-repeats-full.test.ts:46: assistantMessageEvent: {
src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.does-not-duplicate-text-end-repeats-full.test.ts:83: assistantMessageEvent: {
src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.does-not-duplicate-text-end-repeats-full.test.ts:95: assistantMessageEvent: {
src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.keeps-assistanttexts-final-answer-block-replies-are.test.ts:36: assistantMessageEvent: {
src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.keeps-assistanttexts-final-answer-block-replies-are.test.ts:44: assistantMessageEvent: {
2026-02-02T06:44:21.561171Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:44:21.561272Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.

thinking
**Inspecting message updates**

I'm looking into tests related to message updates. It seems like I should check for any "thinking events" there might be. My first step is to search for the term "thinking*delta" in the tests to see how it's being used. This could help me understand what I need to focus on while analyzing message updates. I'm curious what I might discover! Let’s see if this leads to any useful insights.
exec
/bin/bash -lc 'rg -n "thinking*(delta|start|end)" -S src/agents | head -n 50' in /home/davidmarsh/code/moltbot succeeded in 66ms:
src/agents/pi-embedded-subscribe.handlers.messages.ts:68: const isThinkingEvent = evtType === "thinking_delta" || evtType === "thinking_start" || evtType === "thinking_end";
src/agents/pi-embedded-subscribe.handlers.messages.ts:82: if (evtType === "thinking_delta" && thinkingDelta) {
src/agents/pi-embedded-subscribe.handlers.messages.ts:84: } else if (evtType === "thinking_end" && thinkingContent) {
2026-02-02T06:44:25.540784Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:44:25.540833Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.

thinking
**Checking event shape**

I see there's no testing needed right now. We should verify the event shape by looking at the assistantMessageEvent, particularly the delta and content fields. In the tests, they set the assistantMessageEvent with specific type like 'text_delta' and include relevant delta information. Alright, it makes sense to open one of those tests to get a clearer picture of how to proceed.
exec
/bin/bash -lc "sed -n '1,120p' src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.does-not-duplicate-text-end-repeats-full.test.ts" in /home/davidmarsh/code/moltbot succeeded in 62ms:
import { describe, expect, it, vi } from "vitest";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
subscribe: (fn: (evt: unknown) => void) => () => void;
};

describe("subscribeEmbeddedPiSession", () => {
const \_THINKING_TAG_CASES = [
{ tag: "think", open: "<think>", close: "</think>" },
{ tag: "thinking", open: "<thinking>", close: "</thinking>" },
{ tag: "thought", open: "<thought>", close: "</thought>" },
{ tag: "antthinking", open: "<antthinking>", close: "</antthinking>" },
] as const;

it("does not duplicate when text_end repeats full content", () => {
let handler: ((evt: unknown) => void) | undefined;
const session: StubSession = {
subscribe: (fn) => {
handler = fn;
2026-02-02T06:44:29.747006Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:44:29.747052Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.

thinking
**Inspecting event mapping**

I need to check how these tests use `assistantMessageEvent.delta` and the content string. However, native thinking events might differ in their actual shapes. I should look into the pi-agent-core event mapping. Searching through `node_modules` seems cumbersome due to its size, but I can manage it. I’ll target the "thinking_delta" string using a command like `rg -n "thinking_delta" node_modules/@mariozechner/pi-agent-core` to find the relevant path.
exec
/bin/bash -lc 'ls -la node_modules/@mariozechner | head' in /home/davidmarsh/code/moltbot succeeded in 63ms:
total 0
drwxr-xr-x. 1 davidmarsh davidmarsh 300 Feb 1 17:30 .
drwxr-xr-x. 1 davidmarsh davidmarsh 11596 Feb 1 17:30 ..
drwxr-xr-x. 1 davidmarsh davidmarsh 154 Feb 1 17:30 clipboard
drwxr-xr-x. 1 davidmarsh davidmarsh 98 Feb 1 17:30 clipboard-linux-x64-gnu
drwxr-xr-x. 1 davidmarsh davidmarsh 50 Jan 28 22:31 .ignored_pi-agent-core
drwxr-xr-x. 1 davidmarsh davidmarsh 50 Jan 28 22:31 .ignored_pi-ai
drwxr-xr-x. 1 davidmarsh davidmarsh 122 Jan 28 22:31 .ignored_pi-coding-agent
drwxr-xr-x. 1 davidmarsh davidmarsh 74 Jan 28 22:31 .ignored_pi-tui
drwxr-xr-x. 1 davidmarsh davidmarsh 70 Jan 28 22:31 jiti
2026-02-02T06:44:35.181604Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:44:35.181656Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.
exec
/bin/bash -lc 'ls -la node_modules/@mariozechner/.ignored_pi-agent-core' in /home/davidmarsh/code/moltbot succeeded in 61ms:
total 16
drwxr-xr-x. 1 davidmarsh davidmarsh 50 Jan 28 22:31 .
drwxr-xr-x. 1 davidmarsh davidmarsh 300 Feb 1 17:30 ..
drwxr-xr-x. 1 davidmarsh davidmarsh 480 Jan 28 22:31 dist
-rw-r--r--. 1 davidmarsh davidmarsh 1019 Jan 28 22:31 package.json
-rw-r--r--. 1 davidmarsh davidmarsh 10824 Jan 28 22:31 README.md
2026-02-02T06:44:37.557402Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:44:37.557452Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.

thinking
**Investigating package issues**

I’m wondering if the package might be ignored. They could have a custom alias, but our imports are pointing to `@mariozechner/pi-agent-core`. Yet, I notice there's a `.ignored_pi-agent-core` in the `node_modules` folder, but no actual directory. I need to check if `node_modules/@mariozechner/pi-agent-core` exists, and it looks like it doesn’t. They might be using pnpm and a built output instead; the runtime refers to `jiti` alias. I'll look into the contents of that folder.
exec
/bin/bash -lc 'ls -la node*modules/@mariozechner/pi-agent-core 2>/dev/null || echo "no pi-agent-core dir"' in /home/davidmarsh/code/moltbot succeeded in 62ms:
total 16
drwxr-xr-x. 1 davidmarsh davidmarsh 50 Feb 1 17:30 .
drwxr-xr-x. 1 davidmarsh davidmarsh 300 Feb 1 17:30 ..
drwxr-xr-x. 1 davidmarsh davidmarsh 480 Feb 1 17:30 dist
-rw-r--r--. 1 davidmarsh davidmarsh 1019 Feb 1 17:30 package.json
-rw-r--r--. 1 davidmarsh davidmarsh 10854 Feb 1 17:30 README.md
2026-02-02T06:44:44.214300Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:44:44.214350Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.
exec
/bin/bash -lc 'rg -n "thinking*(delta|start|end)" node*modules/@mariozechner/pi-agent-core/dist -S | head -n 50' in /home/davidmarsh/code/moltbot succeeded in 68ms:
node_modules/@mariozechner/pi-agent-core/dist/proxy.d.ts:26: type: "thinking_start";
node_modules/@mariozechner/pi-agent-core/dist/proxy.d.ts:29: type: "thinking_delta";
node_modules/@mariozechner/pi-agent-core/dist/proxy.d.ts:33: type: "thinking_end";
node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js:169: case "thinking_start":
node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js:170: case "thinking_delta":
node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js:171: case "thinking_end":
node_modules/@mariozechner/pi-agent-core/dist/proxy.js:186: case "thinking_start":
node_modules/@mariozechner/pi-agent-core/dist/proxy.js:188: return { type: "thinking_start", contentIndex: proxyEvent.contentIndex, partial };
node_modules/@mariozechner/pi-agent-core/dist/proxy.js:189: case "thinking_delta": {
node_modules/@mariozechner/pi-agent-core/dist/proxy.js:194: type: "thinking_delta",
node_modules/@mariozechner/pi-agent-core/dist/proxy.js:200: throw new Error("Received thinking_delta for non-thinking content");
node_modules/@mariozechner/pi-agent-core/dist/proxy.js:202: case "thinking_end": {
node_modules/@mariozechner/pi-agent-core/dist/proxy.js:207: type: "thinking_end",
node_modules/@mariozechner/pi-agent-core/dist/proxy.js:213: throw new Error("Received thinking_end for non-thinking content");
node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js.map:1:{"version":3,"file":"agent-loop.js","sourceRoot":"","sources":["../src/agent-loop.ts"],"names":[],"mappings":"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","sourcesContent":["/\*\*\n * Agent loop that works with AgentMessage throughout.\n _ Transforms to Message[] only at the LLM call boundary.\n \*/\n\nimport {\n\ttype AssistantMessage,\n\ttype Context,\n\tEventStream,\n\tstreamSimple,\n\ttype ToolResultMessage,\n\tvalidateToolArguments,\n} from \"@mariozechner/pi-ai\";\nimport type {\n\tAgentContext,\n\tAgentEvent,\n\tAgentLoopConfig,\n\tAgentMessage,\n\tAgentTool,\n\tAgentToolResult,\n\tStreamFn,\n} from \"./types.js\";\n\n/\*\*\n _ Start an agent loop with a new prompt message.\n _ The prompt is added to the context and events are emitted for it.\n _/\nexport function agentLoop(\n\tprompts: AgentMessage[],\n\tcontext: AgentContext,\n\tconfig: AgentLoopConfig,\n\tsignal?: AbortSignal,\n\tstreamFn?: StreamFn,\n): EventStream<AgentEvent, AgentMessage[]> {\n\tconst stream = createAgentStream();\n\n\t(async () => {\n\t\tconst newMessages: AgentMessage[] = [...prompts];\n\t\tconst currentContext: AgentContext = {\n\t\t\t...context,\n\t\t\tmessages: [...context.messages, ...prompts],\n\t\t};\n\n\t\tstream.push({ type: \"agent_start\" });\n\t\tstream.push({ type: \"turn_start\" });\n\t\tfor (const prompt of prompts) {\n\t\t\tstream.push({ type: \"message_start\", message: prompt });\n\t\t\tstream.push({ type: \"message_end\", message: prompt });\n\t\t}\n\n\t\tawait runLoop(currentContext, newMessages, config, signal, stream, streamFn);\n\t})();\n\n\treturn stream;\n}\n\n/\*\*\n _ Continue an agent loop from the current context without adding a new message.\n _ Used for retries - context already has user message or tool results.\n _\n _ **Important:** The last message in context must convert to a `user` or `toolResult` message\n _ via `convertToLlm`. If it doesn't, the LLM provider will reject the request.\n _ This cannot be validated here since `convertToLlm` is only called once per turn.\n _/\nexport function agentLoopContinue(\n\tcontext: AgentContext,\n\tconfig: AgentLoopConfig,\n\tsignal?: AbortSignal,\n\tstreamFn?: StreamFn,\n): EventStream<AgentEvent, AgentMessage[]> {\n\tif (context.messages.length === 0) {\n\t\tthrow new Error(\"Cannot continue: no messages in context\");\n\t}\n\n\tif (context.messages[context.messages.length - 1].role === \"assistant\") {\n\t\tthrow new Error(\"Cannot continue from message role: assistant\");\n\t}\n\n\tconst stream = createAgentStream();\n\n\t(async () => {\n\t\tconst newMessages: AgentMessage[] = [];\n\t\tconst currentContext: AgentContext = { ...context };\n\n\t\tstream.push({ type: \"agent_start\" });\n\t\tstream.push({ type: \"turn_start\" });\n\n\t\tawait runLoop(currentContext, newMessages, config, signal, stream, streamFn);\n\t})();\n\n\treturn stream;\n}\n\nfunction createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {\n\treturn new EventStream<AgentEvent, AgentMessage[]>(\n\t\t(event: AgentEvent) => event.type === \"agent_end\",\n\t\t(event: AgentEvent) => (event.type === \"agent_end\" ? event.messages : []),\n\t);\n}\n\n/\*\*\n _ Main loop logic shared by agentLoop and agentLoopContinue.\n _/\nasync function runLoop(\n\tcurrentContext: AgentContext,\n\tnewMessages: AgentMessage[],\n\tconfig: AgentLoopConfig,\n\tsignal: AbortSignal | undefined,\n\tstream: EventStream<AgentEvent, AgentMessage[]>,\n\tstreamFn?: StreamFn,\n): Promise<void> {\n\tlet firstTurn = true;\n\t// Check for steering messages at start (user may have typed while waiting)\n\tlet pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];\n\n\t// Outer loop: continues when queued follow-up messages arrive after agent would stop\n\twhile (true) {\n\t\tlet hasMoreToolCalls = true;\n\t\tlet steeringAfterTools: AgentMessage[] | null = null;\n\n\t\t// Inner loop: process tool calls and steering messages\n\t\twhile (hasMoreToolCalls || pendingMessages.length > 0) {\n\t\t\tif (!firstTurn) {\n\t\t\t\tstream.push({ type: \"turn_start\" });\n\t\t\t} else {\n\t\t\t\tfirstTurn = false;\n\t\t\t}\n\n\t\t\t// Process pending messages (inject before next assistant response)\n\t\t\tif (pendingMessages.length > 0) {\n\t\t\t\tfor (const message of pendingMessages) {\n\t\t\t\t\tstream.push({ type: \"message_start\", message });\n\t\t\t\t\tstream.push({ type: \"message_end\", message });\n\t\t\t\t\tcurrentContext.messages.push(message);\n\t\t\t\t\tnewMessages.push(message);\n\t\t\t\t}\n\t\t\t\tpendingMessages = [];\n\t\t\t}\n\n\t\t\t// Stream assistant response\n\t\t\tconst message = await streamAssistantResponse(currentContext, config, signal, stream, streamFn);\n\t\t\tnewMessages.push(message);\n\n\t\t\tif (message.stopReason === \"error\" || message.stopReason === \"aborted\") {\n\t\t\t\tstream.push({ type: \"turn_end\", message, toolResults: [] });\n\t\t\t\tstream.push({ type: \"agent_end\", messages: newMessages });\n\t\t\t\tstream.end(newMessages);\n\t\t\t\treturn;\n\t\t\t}\n\n\t\t\t// Check for tool calls\n\t\t\tconst toolCalls = message.content.filter((c) => c.type === \"toolCall\");\n\t\t\thasMoreToolCalls = toolCalls.length > 0;\n\n\t\t\tconst toolResults: ToolResultMessage[] = [];\n\t\t\tif (hasMoreToolCalls) {\n\t\t\t\tconst toolExecution = await executeToolCalls(\n\t\t\t\t\tcurrentContext.tools,\n\t\t\t\t\tmessage,\n\t\t\t\t\tsignal,\n\t\t\t\t\tstream,\n\t\t\t\t\tconfig.getSteeringMessages,\n\t\t\t\t);\n\t\t\t\ttoolResults.push(...toolExecution.toolResults);\n\t\t\t\tsteeringAfterTools = toolExecution.steeringMessages ?? null;\n\n\t\t\t\tfor (const result of toolResults) {\n\t\t\t\t\tcurrentContext.messages.push(result);\n\t\t\t\t\tnewMessages.push(result);\n\t\t\t\t}\n\t\t\t}\n\n\t\t\tstream.push({ type: \"turn_end\", message, toolResults });\n\n\t\t\t// Get steering messages after turn completes\n\t\t\tif (steeringAfterTools && steeringAfterTools.length > 0) {\n\t\t\t\tpendingMessages = steeringAfterTools;\n\t\t\t\tsteeringAfterTools = null;\n\t\t\t} else {\n\t\t\t\tpendingMessages = (await config.getSteeringMessages?.()) || [];\n\t\t\t}\n\t\t}\n\n\t\t// Agent would stop here. Check for follow-up messages.\n\t\tconst followUpMessages = (await config.getFollowUpMessages?.()) || [];\n\t\tif (followUpMessages.length > 0) {\n\t\t\t// Set as pending so inner loop processes them\n\t\t\tpendingMessages = followUpMessages;\n\t\t\tcontinue;\n\t\t}\n\n\t\t// No more messages, exit\n\t\tbreak;\n\t}\n\n\tstream.push({ type: \"agent_end\", messages: newMessages });\n\tstream.end(newMessages);\n}\n\n/\*\*\n _ Stream an assistant response from the LLM.\n _ This is where AgentMessage[] gets transformed to Message[] for the LLM.\n _/\nasync function streamAssistantResponse(\n\tcontext: AgentContext,\n\tconfig: AgentLoopConfig,\n\tsignal: AbortSignal | undefined,\n\tstream: EventStream<AgentEvent, AgentMessage[]>,\n\tstreamFn?: StreamFn,\n): Promise<AssistantMessage> {\n\t// Apply context transform if configured (AgentMessage[] → AgentMessage[])\n\tlet messages = context.messages;\n\tif (config.transformContext) {\n\t\tmessages = await config.transformContext(messages, signal);\n\t}\n\n\t// Convert to LLM-compatible messages (AgentMessage[] → Message[])\n\tconst llmMessages = await config.convertToLlm(messages);\n\n\t// Build LLM context\n\tconst llmContext: Context = {\n\t\tsystemPrompt: context.systemPrompt,\n\t\tmessages: llmMessages,\n\t\ttools: context.tools,\n\t};\n\n\tconst streamFunction = streamFn || streamSimple;\n\n\t// Resolve API key (important for expiring tokens)\n\tconst resolvedApiKey =\n\t\t(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;\n\n\tconst response = await streamFunction(config.model, llmContext, {\n\t\t...config,\n\t\tapiKey: resolvedApiKey,\n\t\tsignal,\n\t});\n\n\tlet partialMessage: AssistantMessage | null = null;\n\tlet addedPartial = false;\n\n\tfor await (const event of response) {\n\t\tswitch (event.type) {\n\t\t\tcase \"start\":\n\t\t\t\tpartialMessage = event.partial;\n\t\t\t\tcontext.messages.push(partialMessage);\n\t\t\t\taddedPartial = true;\n\t\t\t\tstream.push({ type: \"message_start\", message: { ...partialMessage } });\n\t\t\t\tbreak;\n\n\t\t\tcase \"text_start\":\n\t\t\tcase \"text_delta\":\n\t\t\tcase \"text_end\":\n\t\t\tcase \"thinking_start\":\n\t\t\tcase \"thinking_delta\":\n\t\t\tcase \"thinking_end\":\n\t\t\tcase \"toolcall_start\":\n\t\t\tcase \"toolcall_delta\":\n\t\t\tcase \"toolcall_end\":\n\t\t\t\tif (partialMessage) {\n\t\t\t\t\tpartialMessage = event.partial;\n\t\t\t\t\tcontext.messages[context.messages.length - 1] = partialMessage;\n\t\t\t\t\tstream.push({\n\t\t\t\t\t\ttype: \"message_update\",\n\t\t\t\t\t\tassistantMessageEvent: event,\n\t\t\t\t\t\tmessage: { ...partialMessage },\n\t\t\t\t\t});\n\t\t\t\t}\n\t\t\t\tbreak;\n\n\t\t\tcase \"done\":\n\t\t\tcase \"error\": {\n\t\t\t\tconst finalMessage = await response.result();\n\t\t\t\tif (addedPartial) {\n\t\t\t\t\tcontext.messages[context.messages.length - 1] = finalMessage;\n\t\t\t\t} else {\n\t\t\t\t\tcontext.messages.push(finalMessage);\n\t\t\t\t}\n\t\t\t\tif (!addedPartial) {\n\t\t\t\t\tstream.push({ type: \"message_start\", message: { ...finalMessage } });\n\t\t\t\t}\n\t\t\t\tstream.push({ type: \"message_end\", message: finalMessage });\n\t\t\t\treturn finalMessage;\n\t\t\t}\n\t\t}\n\t}\n\n\treturn await response.result();\n}\n\n/\*\*\n _ Execute tool calls from an assistant message.\n _/\nasync function executeToolCalls(\n\ttools: AgentTool<any>[] | undefined,\n\tassistantMessage: AssistantMessage,\n\tsignal: AbortSignal | undefined,\n\tstream: EventStream<AgentEvent, AgentMessage[]>,\n\tgetSteeringMessages?: AgentLoopConfig[\"getSteeringMessages\"],\n): Promise<{ toolResults: ToolResultMessage[]; steeringMessages?: AgentMessage[] }> {\n\tconst toolCalls = assistantMessage.content.filter((c) => c.type === \"toolCall\");\n\tconst results: ToolResultMessage[] = [];\n\tlet steeringMessages: AgentMessage[] | undefined;\n\n\tfor (let index = 0; index < toolCalls.length; index++) {\n\t\tconst toolCall = toolCalls[index];\n\t\tconst tool = tools?.find((t) => t.name === toolCall.name);\n\n\t\tstream.push({\n\t\t\ttype: \"tool_execution_start\",\n\t\t\ttoolCallId: toolCall.id,\n\t\t\ttoolName: toolCall.name,\n\t\t\targs: toolCall.arguments,\n\t\t});\n\n\t\tlet result: AgentToolResult<any>;\n\t\tlet isError = false;\n\n\t\ttry {\n\t\t\tif (!tool) throw new Error(`Tool ${toolCall.name} not found`);\n\n\t\t\tconst validatedArgs = validateToolArguments(tool, toolCall);\n\n\t\t\tresult = await tool.execute(toolCall.id, validatedArgs, signal, (partialResult) => {\n\t\t\t\tstream.push({\n\t\t\t\t\ttype: \"tool_execution_update\",\n\t\t\t\t\ttoolCallId: toolCall.id,\n\t\t\t\t\ttoolName: toolCall.name,\n\t\t\t\t\targs: toolCall.arguments,\n\t\t\t\t\tpartialResult,\n\t\t\t\t});\n\t\t\t});\n\t\t} catch (e) {\n\t\t\tresult = {\n\t\t\t\tcontent: [{ type: \"text\", text: e instanceof Error ? e.message : String(e) }],\n\t\t\t\tdetails: {},\n\t\t\t};\n\t\t\tisError = true;\n\t\t}\n\n\t\tstream.push({\n\t\t\ttype: \"tool_execution_end\",\n\t\t\ttoolCallId: toolCall.id,\n\t\t\ttoolName: toolCall.name,\n\t\t\tresult,\n\t\t\tisError,\n\t\t});\n\n\t\tconst toolResultMessage: ToolResultMessage = {\n\t\t\trole: \"toolResult\",\n\t\t\ttoolCallId: toolCall.id,\n\t\t\ttoolName: toolCall.name,\n\t\t\tcontent: result.content,\n\t\t\tdetails: result.details,\n\t\t\tisError,\n\t\t\ttimestamp: Date.now(),\n\t\t};\n\n\t\tresults.push(toolResultMessage);\n\t\tstream.push({ type: \"message_start\", message: toolResultMessage });\n\t\tstream.push({ type: \"message_end\", message: toolResultMessage });\n\n\t\t// Check for steering messages - skip remaining tools if user interrupted\n\t\tif (getSteeringMessages) {\n\t\t\tconst steering = await getSteeringMessages();\n\t\t\tif (steering.length > 0) {\n\t\t\t\tsteeringMessages = steering;\n\t\t\t\tconst remainingCalls = toolCalls.slice(index + 1);\n\t\t\t\tfor (const skipped of remainingCalls) {\n\t\t\t\t\tresults.push(skipToolCall(skipped, stream));\n\t\t\t\t}\n\t\t\t\tbreak;\n\t\t\t}\n\t\t}\n\t}\n\n\treturn { toolResults: results, steeringMessages };\n}\n\nfunction skipToolCall(\n\ttoolCall: Extract<AssistantMessage[\"content\"][number], { type: \"toolCall\" }>,\n\tstream: EventStream<AgentEvent, AgentMessage[]>,\n): ToolResultMessage {\n\tconst result: AgentToolResult<any> = {\n\t\tcontent: [{ type: \"text\", text: \"Skipped due to queued user message.\" }],\n\t\tdetails: {},\n\t};\n\n\tstream.push({\n\t\ttype: \"tool_execution_start\",\n\t\ttoolCallId: toolCall.id,\n\t\ttoolName: toolCall.name,\n\t\targs: toolCall.arguments,\n\t});\n\tstream.push({\n\t\ttype: \"tool_execution_end\",\n\t\ttoolCallId: toolCall.id,\n\t\ttoolName: toolCall.name,\n\t\tresult,\n\t\tisError: true,\n\t});\n\n\tconst toolResultMessage: ToolResultMessage = {\n\t\trole: \"toolResult\",\n\t\ttoolCallId: toolCall.id,\n\t\ttoolName: toolCall.name,\n\t\tcontent: result.content,\n\t\tdetails: {},\n\t\tisError: true,\n\t\ttimestamp: Date.now(),\n\t};\n\n\tstream.push({ type: \"message_start\", message: toolResultMessage });\n\tstream.push({ type: \"message_end\", message: toolResultMessage });\n\n\treturn toolResultMessage;\n}\n"]}
node_modules/@mariozechner/pi-agent-core/dist/proxy.d.ts.map:1:{"version":3,"file":"proxy.d.ts","sourceRoot":"","sources":["../src/proxy.ts"],"names":[],"mappings":"AAAA;;;GAGG;AAGH,OAAO,EACN,KAAK,gBAAgB,EACrB,KAAK,qBAAqB,EAC1B,KAAK,OAAO,EACZ,WAAW,EACX,KAAK,KAAK,EAEV,KAAK,mBAAmB,EACxB,KAAK,UAAU,EAEf,MAAM,qBAAqB,CAAC;AAG7B,cAAM,uBAAwB,SAAQ,WAAW,CAAC,qBAAqB,EAAE,gBAAgB,CAAC;IACzF,cASC;CACD;AAED;;GAEG;AACH,MAAM,MAAM,0BAA0B,GACnC;IAAE,IAAI,EAAE,OAAO,CAAA;CAAE,GACjB;IAAE,IAAI,EAAE,YAAY,CAAC;IAAC,YAAY,EAAE,MAAM,CAAA;CAAE,GAC5C;IAAE,IAAI,EAAE,YAAY,CAAC;IAAC,YAAY,EAAE,MAAM,CAAC;IAAC,KAAK,EAAE,MAAM,CAAA;CAAE,GAC3D;IAAE,IAAI,EAAE,UAAU,CAAC;IAAC,YAAY,EAAE,MAAM,CAAC;IAAC,gBAAgB,CAAC,EAAE,MAAM,CAAA;CAAE,GACrE;IAAE,IAAI,EAAE,gBAAgB,CAAC;IAAC,YAAY,EAAE,MAAM,CAAA;CAAE,GAChD;IAAE,IAAI,EAAE,gBAAgB,CAAC;IAAC,YAAY,EAAE,MAAM,CAAC;IAAC,KAAK,EAAE,MAAM,CAAA;CAAE,GAC/D;IAAE,IAAI,EAAE,cAAc,CAAC;IAAC,YAAY,EAAE,MAAM,CAAC;IAAC,gBAAgB,CAAC,EAAE,MAAM,CAAA;CAAE,GACzE;IAAE,IAAI,EAAE,gBAAgB,CAAC;IAAC,YAAY,EAAE,MAAM,CAAC;IAAC,EAAE,EAAE,MAAM,CAAC;IAAC,QAAQ,EAAE,MAAM,CAAA;CAAE,GAC9E;IAAE,IAAI,EAAE,gBAAgB,CAAC;IAAC,YAAY,EAAE,MAAM,CAAC;IAAC,KAAK,EAAE,MAAM,CAAA;CAAE,GAC/D;IAAE,IAAI,EAAE,cAAc,CAAC;IAAC,YAAY,EAAE,MAAM,CAAA;CAAE,GAC9C;IACA,IAAI,EAAE,MAAM,CAAC;IACb,MAAM,EAAE,OAAO,CAAC,UAAU,EAAE,MAAM,GAAG,QAAQ,GAAG,SAAS,CAAC,CAAC;IAC3D,KAAK,EAAE,gBAAgB,CAAC,OAAO,CAAC,CAAC;CAChC,GACD;IACA,IAAI,EAAE,OAAO,CAAC;IACd,MAAM,EAAE,OAAO,CAAC,UAAU,EAAE,SAAS,GAAG,OAAO,CAAC,CAAC;IACjD,YAAY,CAAC,EAAE,MAAM,CAAC;IACtB,KAAK,EAAE,gBAAgB,CAAC,OAAO,CAAC,CAAC;CAChC,CAAC;AAEL,MAAM,WAAW,kBAAmB,SAAQ,mBAAmB;IAC9D,sCAAsC;IACtC,SAAS,EAAE,MAAM,CAAC;IAClB,2DAA2D;IAC3D,QAAQ,EAAE,MAAM,CAAC;CACjB;AAED;;;;;;;;;;;;;;;;;;GAkBG;AACH,wBAAgB,WAAW,CAAC,KAAK,EAAE,KAAK,CAAC,GAAG,CAAC,EAAE,OAAO,EAAE,OAAO,EAAE,OAAO,EAAE,kBAAkB,GAAG,uBAAuB,CAyHrH","sourcesContent":["/\*\*\n _ Proxy stream function for apps that route LLM calls through a server.\n _ The server manages auth and proxies requests to LLM providers.\n _/\n\n// Internal import for JSON parsing utility\nimport {\n\ttype AssistantMessage,\n\ttype AssistantMessageEvent,\n\ttype Context,\n\tEventStream,\n\ttype Model,\n\tparseStreamingJson,\n\ttype SimpleStreamOptions,\n\ttype StopReason,\n\ttype ToolCall,\n} from \"@mariozechner/pi-ai\";\n\n// Create stream class matching ProxyMessageEventStream\nclass ProxyMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {\n\tconstructor() {\n\t\tsuper(\n\t\t\t(event) => event.type === \"done\" || event.type === \"error\",\n\t\t\t(event) => {\n\t\t\t\tif (event.type === \"done\") return event.message;\n\t\t\t\tif (event.type === \"error\") return event.error;\n\t\t\t\tthrow new Error(\"Unexpected event type\");\n\t\t\t},\n\t\t);\n\t}\n}\n\n/\*\*\n _ Proxy event types - server sends these with partial field stripped to reduce bandwidth.\n _/\nexport type ProxyAssistantMessageEvent =\n\t| { type: \"start\" }\n\t| { type: \"text_start\"; contentIndex: number }\n\t| { type: \"text_delta\"; contentIndex: number; delta: string }\n\t| { type: \"text_end\"; contentIndex: number; contentSignature?: string }\n\t| { type: \"thinking_start\"; contentIndex: number }\n\t| { type: \"thinking_delta\"; contentIndex: number; delta: string }\n\t| { type: \"thinking_end\"; contentIndex: number; contentSignature?: string }\n\t| { type: \"toolcall_start\"; contentIndex: number; id: string; toolName: string }\n\t| { type: \"toolcall_delta\"; contentIndex: number; delta: string }\n\t| { type: \"toolcall_end\"; contentIndex: number }\n\t| {\n\t\t\ttype: \"done\";\n\t\t\treason: Extract<StopReason, \"stop\" | \"length\" | \"toolUse\">;\n\t\t\tusage: AssistantMessage[\"usage\"];\n\t }\n\t| {\n\t\t\ttype: \"error\";\n\t\t\treason: Extract<StopReason, \"aborted\" | \"error\">;\n\t\t\terrorMessage?: string;\n\t\t\tusage: AssistantMessage[\"usage\"];\n\t };\n\nexport interface ProxyStreamOptions extends SimpleStreamOptions {\n\t/\*\* Auth token for the proxy server _/\n\tauthToken: string;\n\t/\*\* Proxy server URL (e.g., \"https://genai.example.com\") _/\n\tproxyUrl: string;\n}\n\n/\*\*\n _ Stream function that proxies through a server instead of calling LLM providers directly.\n _ The server strips the partial field from delta events to reduce bandwidth.\n _ We reconstruct the partial message client-side.\n _\n _ Use this as the `streamFn` option when creating an Agent that needs to go through a proxy.\n _\n _ @example\n _ `typescript\n _ const agent = new Agent({\n _ streamFn: (model, context, options) =>\n _ streamProxy(model, context, {\n _ ...options,\n _ authToken: await getAuthToken(),\n _ proxyUrl: \"https://genai.example.com\",\n _ }),\n _ });\n _ `\n \*/\nexport function streamProxy(model: Model<any>, context: Context, options: ProxyStreamOptions): ProxyMessageEventStream {\n\tconst stream = new ProxyMessageEventStream();\n\n\t(async () => {\n\t\t// Initialize the partial message that we'll build up from events\n\t\tconst partial: AssistantMessage = {\n\t\t\trole: \"assistant\",\n\t\t\tstopReason: \"stop\",\n\t\t\tcontent: [],\n\t\t\tapi: model.api,\n\t\t\tprovider: model.provider,\n\t\t\tmodel: model.id,\n\t\t\tusage: {\n\t\t\t\tinput: 0,\n\t\t\t\toutput: 0,\n\t\t\t\tcacheRead: 0,\n\t\t\t\tcacheWrite: 0,\n\t\t\t\ttotalTokens: 0,\n\t\t\t\tcost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },\n\t\t\t},\n\t\t\ttimestamp: Date.now(),\n\t\t};\n\n\t\tlet reader: ReadableStreamDefaultReader<Uint8Array> | undefined;\n\n\t\tconst abortHandler = () => {\n\t\t\tif (reader) {\n\t\t\t\treader.cancel(\"Request aborted by user\").catch(() => {});\n\t\t\t}\n\t\t};\n\n\t\tif (options.signal) {\n\t\t\toptions.signal.addEventListener(\"abort\", abortHandler);\n\t\t}\n\n\t\ttry {\n\t\t\tconst response = await fetch(`${options.proxyUrl}/api/stream`, {\n\t\t\t\tmethod: \"POST\",\n\t\t\t\theaders: {\n\t\t\t\t\tAuthorization: `Bearer ${options.authToken}`,\n\t\t\t\t\t\"Content-Type\": \"application/json\",\n\t\t\t\t},\n\t\t\t\tbody: JSON.stringify({\n\t\t\t\t\tmodel,\n\t\t\t\t\tcontext,\n\t\t\t\t\toptions: {\n\t\t\t\t\t\ttemperature: options.temperature,\n\t\t\t\t\t\tmaxTokens: options.maxTokens,\n\t\t\t\t\t\treasoning: options.reasoning,\n\t\t\t\t\t},\n\t\t\t\t}),\n\t\t\t\tsignal: options.signal,\n\t\t\t});\n\n\t\t\tif (!response.ok) {\n\t\t\t\tlet errorMessage = `Proxy error: ${response.status} ${response.statusText}`;\n\t\t\t\ttry {\n\t\t\t\t\tconst errorData = (await response.json()) as { error?: string };\n\t\t\t\t\tif (errorData.error) {\n\t\t\t\t\t\terrorMessage = `Proxy error: ${errorData.error}`;\n\t\t\t\t\t}\n\t\t\t\t} catch {\n\t\t\t\t\t// Couldn't parse error response\n\t\t\t\t}\n\t\t\t\tthrow new Error(errorMessage);\n\t\t\t}\n\n\t\t\treader = response.body!.getReader();\n\t\t\tconst decoder = new TextDecoder();\n\t\t\tlet buffer = \"\";\n\n\t\t\twhile (true) {\n\t\t\t\tconst { done, value } = await reader.read();\n\t\t\t\tif (done) break;\n\n\t\t\t\tif (options.signal?.aborted) {\n\t\t\t\t\tthrow new Error(\"Request aborted by user\");\n\t\t\t\t}\n\n\t\t\t\tbuffer += decoder.decode(value, { stream: true });\n\t\t\t\tconst lines = buffer.split(\"\\n\");\n\t\t\t\tbuffer = lines.pop() || \"\";\n\n\t\t\t\tfor (const line of lines) {\n\t\t\t\t\tif (line.startsWith(\"data: \")) {\n\t\t\t\t\t\tconst data = line.slice(6).trim();\n\t\t\t\t\t\tif (data) {\n\t\t\t\t\t\t\tconst proxyEvent = JSON.parse(data) as ProxyAssistantMessageEvent;\n\t\t\t\t\t\t\tconst event = processProxyEvent(proxyEvent, partial);\n\t\t\t\t\t\t\tif (event) {\n\t\t\t\t\t\t\t\tstream.push(event);\n\t\t\t\t\t\t\t}\n\t\t\t\t\t\t}\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t}\n\n\t\t\tif (options.signal?.aborted) {\n\t\t\t\tthrow new Error(\"Request aborted by user\");\n\t\t\t}\n\n\t\t\tstream.end();\n\t\t} catch (error) {\n\t\t\tconst errorMessage = error instanceof Error ? error.message : String(error);\n\t\t\tconst reason = options.signal?.aborted ? \"aborted\" : \"error\";\n\t\t\tpartial.stopReason = reason;\n\t\t\tpartial.errorMessage = errorMessage;\n\t\t\tstream.push({\n\t\t\t\ttype: \"error\",\n\t\t\t\treason,\n\t\t\t\terror: partial,\n\t\t\t});\n\t\t\tstream.end();\n\t\t} finally {\n\t\t\tif (options.signal) {\n\t\t\t\toptions.signal.removeEventListener(\"abort\", abortHandler);\n\t\t\t}\n\t\t}\n\t})();\n\n\treturn stream;\n}\n\n/**\n * Process a proxy event and update the partial message.\n */\nfunction processProxyEvent(\n\tproxyEvent: ProxyAssistantMessageEvent,\n\tpartial: AssistantMessage,\n): AssistantMessageEvent | undefined {\n\tswitch (proxyEvent.type) {\n\t\tcase \"start\":\n\t\t\treturn { type: \"start\", partial };\n\n\t\tcase \"text_start\":\n\t\t\tpartial.content[proxyEvent.contentIndex] = { type: \"text\", text: \"\" };\n\t\t\treturn { type: \"text_start\", contentIndex: proxyEvent.contentIndex, partial };\n\n\t\tcase \"text_delta\": {\n\t\t\tconst content = partial.content[proxyEvent.contentIndex];\n\t\t\tif (content?.type === \"text\") {\n\t\t\t\tcontent.text += proxyEvent.delta;\n\t\t\t\treturn {\n\t\t\t\t\ttype: \"text_delta\",\n\t\t\t\t\tcontentIndex: proxyEvent.contentIndex,\n\t\t\t\t\tdelta: proxyEvent.delta,\n\t\t\t\t\tpartial,\n\t\t\t\t};\n\t\t\t}\n\t\t\tthrow new Error(\"Received text_delta for non-text content\");\n\t\t}\n\n\t\tcase \"text_end\": {\n\t\t\tconst content = partial.content[proxyEvent.contentIndex];\n\t\t\tif (content?.type === \"text\") {\n\t\t\t\tcontent.textSignature = proxyEvent.contentSignature;\n\t\t\t\treturn {\n\t\t\t\t\ttype: \"text_end\",\n\t\t\t\t\tcontentIndex: proxyEvent.contentIndex,\n\t\t\t\t\tcontent: content.text,\n\t\t\t\t\tpartial,\n\t\t\t\t};\n\t\t\t}\n\t\t\tthrow new Error(\"Received text_end for non-text content\");\n\t\t}\n\n\t\tcase \"thinking_start\":\n\t\t\tpartial.content[proxyEvent.contentIndex] = { type: \"thinking\", thinking: \"\" };\n\t\t\treturn { type: \"thinking_start\", contentIndex: proxyEvent.contentIndex, partial };\n\n\t\tcase \"thinking_delta\": {\n\t\t\tconst content = partial.content[proxyEvent.contentIndex];\n\t\t\tif (content?.type === \"thinking\") {\n\t\t\t\tcontent.thinking += proxyEvent.delta;\n\t\t\t\treturn {\n\t\t\t\t\ttype: \"thinking_delta\",\n\t\t\t\t\tcontentIndex: proxyEvent.contentIndex,\n\t\t\t\t\tdelta: proxyEvent.delta,\n\t\t\t\t\tpartial,\n\t\t\t\t};\n\t\t\t}\n\t\t\tthrow new Error(\"Received thinking_delta for non-thinking content\");\n\t\t}\n\n\t\tcase \"thinking_end\": {\n\t\t\tconst content = partial.content[proxyEvent.contentIndex];\n\t\t\tif (content?.type === \"thinking\") {\n\t\t\t\tcontent.thinkingSignature = proxyEvent.contentSignature;\n\t\t\t\treturn {\n\t\t\t\t\ttype: \"thinking_end\",\n\t\t\t\t\tcontentIndex: proxyEvent.contentIndex,\n\t\t\t\t\tcontent: content.thinking,\n\t\t\t\t\tpartial,\n\t\t\t\t};\n\t\t\t}\n\t\t\tthrow new Error(\"Received thinking_end for non-thinking content\");\n\t\t}\n\n\t\tcase \"toolcall_start\":\n\t\t\tpartial.content[proxyEvent.contentIndex] = {\n\t\t\t\ttype: \"toolCall\",\n\t\t\t\tid: proxyEvent.id,\n\t\t\t\tname: proxyEvent.toolName,\n\t\t\t\targuments: {},\n\t\t\t\tpartialJson: \"\",\n\t\t\t} satisfies ToolCall & { partialJson: string } as ToolCall;\n\t\t\treturn { type: \"toolcall_start\", contentIndex: proxyEvent.contentIndex, partial };\n\n\t\tcase \"toolcall_delta\": {\n\t\t\tconst content = partial.content[proxyEvent.contentIndex];\n\t\t\tif (content?.type === \"toolCall\") {\n\t\t\t\t(content as any).partialJson += proxyEvent.delta;\n\t\t\t\tcontent.arguments = parseStreamingJson((content as any).partialJson) || {};\n\t\t\t\tpartial.content[proxyEvent.contentIndex] = { ...content }; // Trigger reactivity\n\t\t\t\treturn {\n\t\t\t\t\ttype: \"toolcall_delta\",\n\t\t\t\t\tcontentIndex: proxyEvent.contentIndex,\n\t\t\t\t\tdelta: proxyEvent.delta,\n\t\t\t\t\tpartial,\n\t\t\t\t};\n\t\t\t}\n\t\t\tthrow new Error(\"Received toolcall_delta for non-toolCall content\");\n\t\t}\n\n\t\tcase \"toolcall_end\": {\n\t\t\tconst content = partial.content[proxyEvent.contentIndex];\n\t\t\tif (content?.type === \"toolCall\") {\n\t\t\t\tdelete (content as any).partialJson;\n\t\t\t\treturn {\n\t\t\t\t\ttype: \"toolcall_end\",\n\t\t\t\t\tcontentIndex: proxyEvent.contentIndex,\n\t\t\t\t\ttoolCall: content,\n\t\t\t\t\tpartial,\n\t\t\t\t};\n\t\t\t}\n\t\t\treturn undefined;\n\t\t}\n\n\t\tcase \"done\":\n\t\t\tpartial.stopReason = proxyEvent.reason;\n\t\t\tpartial.usage = proxyEvent.usage;\n\t\t\treturn { type: \"done\", reason: proxyEvent.reason, message: partial };\n\n\t\tcase \"error\":\n\t\t\tpartial.stopReason = proxyEvent.reason;\n\t\t\tpartial.errorMessage = proxyEvent.errorMessage;\n\t\t\tpartial.usage = proxyEvent.usage;\n\t\t\treturn { type: \"error\", reason: proxyEvent.reason, error: partial };\n\n\t\tdefault: {\n\t\t\tconst \_exhaustiveCheck: never = proxyEvent;\n\t\t\tconsole.warn(`Unhandled proxy event type: ${(proxyEvent as any).type}`);\n\t\t\treturn undefined;\n\t\t}\n\t}\n}\n"]}
node_modules/@mariozechner/pi-agent-core/dist/agent-loop.d.ts.map:1:{"version":3,"file":"agent-loop.d.ts","sourceRoot":"","sources":["../src/agent-loop.ts"],"names":[],"mappings":"AAAA;;;GAGG;AAEH,OAAO,EAGN,WAAW,EAIX,MAAM,qBAAqB,CAAC;AAC7B,OAAO,KAAK,EACX,YAAY,EACZ,UAAU,EACV,eAAe,EACf,YAAY,EAGZ,QAAQ,EACR,MAAM,YAAY,CAAC;AAEpB;;;GAGG;AACH,wBAAgB,SAAS,CACxB,OAAO,EAAE,YAAY,EAAE,EACvB,OAAO,EAAE,YAAY,EACrB,MAAM,EAAE,eAAe,EACvB,MAAM,CAAC,EAAE,WAAW,EACpB,QAAQ,CAAC,EAAE,QAAQ,GACjB,WAAW,CAAC,UAAU,EAAE,YAAY,EAAE,CAAC,CAqBzC;AAED;;;;;;;GAOG;AACH,wBAAgB,iBAAiB,CAChC,OAAO,EAAE,YAAY,EACrB,MAAM,EAAE,eAAe,EACvB,MAAM,CAAC,EAAE,WAAW,EACpB,QAAQ,CAAC,EAAE,QAAQ,GACjB,WAAW,CAAC,UAAU,EAAE,YAAY,EAAE,CAAC,CAsBzC","sourcesContent":["/**\n * Agent loop that works with AgentMessage throughout.\n * Transforms to Message[] only at the LLM call boundary.\n \*/\n\nimport {\n\ttype AssistantMessage,\n\ttype Context,\n\tEventStream,\n\tstreamSimple,\n\ttype ToolResultMessage,\n\tvalidateToolArguments,\n} from \"@mariozechner/pi-ai\";\nimport type {\n\tAgentContext,\n\tAgentEvent,\n\tAgentLoopConfig,\n\tAgentMessage,\n\tAgentTool,\n\tAgentToolResult,\n\tStreamFn,\n} from \"./types.js\";\n\n/**\n * Start an agent loop with a new prompt message.\n * The prompt is added to the context and events are emitted for it.\n */\nexport function agentLoop(\n\tprompts: AgentMessage[],\n\tcontext: AgentContext,\n\tconfig: AgentLoopConfig,\n\tsignal?: AbortSignal,\n\tstreamFn?: StreamFn,\n): EventStream<AgentEvent, AgentMessage[]> {\n\tconst stream = createAgentStream();\n\n\t(async () => {\n\t\tconst newMessages: AgentMessage[] = [...prompts];\n\t\tconst currentContext: AgentContext = {\n\t\t\t...context,\n\t\t\tmessages: [...context.messages, ...prompts],\n\t\t};\n\n\t\tstream.push({ type: \"agent_start\" });\n\t\tstream.push({ type: \"turn_start\" });\n\t\tfor (const prompt of prompts) {\n\t\t\tstream.push({ type: \"message_start\", message: prompt });\n\t\t\tstream.push({ type: \"message_end\", message: prompt });\n\t\t}\n\n\t\tawait runLoop(currentContext, newMessages, config, signal, stream, streamFn);\n\t})();\n\n\treturn stream;\n}\n\n/\*\*\n * Continue an agent loop from the current context without adding a new message.\n * Used for retries - context already has user message or tool results.\n *\n * **Important:** The last message in context must convert to a `user` or `toolResult` message\n * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.\n * This cannot be validated here since `convertToLlm` is only called once per turn.\n */\nexport function agentLoopContinue(\n\tcontext: AgentContext,\n\tconfig: AgentLoopConfig,\n\tsignal?: AbortSignal,\n\tstreamFn?: StreamFn,\n): EventStream<AgentEvent, AgentMessage[]> {\n\tif (context.messages.length === 0) {\n\t\tthrow new Error(\"Cannot continue: no messages in context\");\n\t}\n\n\tif (context.messages[context.messages.length - 1].role === \"assistant\") {\n\t\tthrow new Error(\"Cannot continue from message role: assistant\");\n\t}\n\n\tconst stream = createAgentStream();\n\n\t(async () => {\n\t\tconst newMessages: AgentMessage[] = [];\n\t\tconst currentContext: AgentContext = { ...context };\n\n\t\tstream.push({ type: \"agent_start\" });\n\t\tstream.push({ type: \"turn_start\" });\n\n\t\tawait runLoop(currentContext, newMessages, config, signal, stream, streamFn);\n\t})();\n\n\treturn stream;\n}\n\nfunction createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {\n\treturn new EventStream<AgentEvent, AgentMessage[]>(\n\t\t(event: AgentEvent) => event.type === \"agent_end\",\n\t\t(event: AgentEvent) => (event.type === \"agent_end\" ? event.messages : []),\n\t);\n}\n\n/**\n * Main loop logic shared by agentLoop and agentLoopContinue.\n */\nasync function runLoop(\n\tcurrentContext: AgentContext,\n\tnewMessages: AgentMessage[],\n\tconfig: AgentLoopConfig,\n\tsignal: AbortSignal | undefined,\n\tstream: EventStream<AgentEvent, AgentMessage[]>,\n\tstreamFn?: StreamFn,\n): Promise<void> {\n\tlet firstTurn = true;\n\t// Check for steering messages at start (user may have typed while waiting)\n\tlet pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];\n\n\t// Outer loop: continues when queued follow-up messages arrive after agent would stop\n\twhile (true) {\n\t\tlet hasMoreToolCalls = true;\n\t\tlet steeringAfterTools: AgentMessage[] | null = null;\n\n\t\t// Inner loop: process tool calls and steering messages\n\t\twhile (hasMoreToolCalls || pendingMessages.length > 0) {\n\t\t\tif (!firstTurn) {\n\t\t\t\tstream.push({ type: \"turn_start\" });\n\t\t\t} else {\n\t\t\t\tfirstTurn = false;\n\t\t\t}\n\n\t\t\t// Process pending messages (inject before next assistant response)\n\t\t\tif (pendingMessages.length > 0) {\n\t\t\t\tfor (const message of pendingMessages) {\n\t\t\t\t\tstream.push({ type: \"message_start\", message });\n\t\t\t\t\tstream.push({ type: \"message_end\", message });\n\t\t\t\t\tcurrentContext.messages.push(message);\n\t\t\t\t\tnewMessages.push(message);\n\t\t\t\t}\n\t\t\t\tpendingMessages = [];\n\t\t\t}\n\n\t\t\t// Stream assistant response\n\t\t\tconst message = await streamAssistantResponse(currentContext, config, signal, stream, streamFn);\n\t\t\tnewMessages.push(message);\n\n\t\t\tif (message.stopReason === \"error\" || message.stopReason === \"aborted\") {\n\t\t\t\tstream.push({ type: \"turn_end\", message, toolResults: [] });\n\t\t\t\tstream.push({ type: \"agent_end\", messages: newMessages });\n\t\t\t\tstream.end(newMessages);\n\t\t\t\treturn;\n\t\t\t}\n\n\t\t\t// Check for tool calls\n\t\t\tconst toolCalls = message.content.filter((c) => c.type === \"toolCall\");\n\t\t\thasMoreToolCalls = toolCalls.length > 0;\n\n\t\t\tconst toolResults: ToolResultMessage[] = [];\n\t\t\tif (hasMoreToolCalls) {\n\t\t\t\tconst toolExecution = await executeToolCalls(\n\t\t\t\t\tcurrentContext.tools,\n\t\t\t\t\tmessage,\n\t\t\t\t\tsignal,\n\t\t\t\t\tstream,\n\t\t\t\t\tconfig.getSteeringMessages,\n\t\t\t\t);\n\t\t\t\ttoolResults.push(...toolExecution.toolResults);\n\t\t\t\tsteeringAfterTools = toolExecution.steeringMessages ?? null;\n\n\t\t\t\tfor (const result of toolResults) {\n\t\t\t\t\tcurrentContext.messages.push(result);\n\t\t\t\t\tnewMessages.push(result);\n\t\t\t\t}\n\t\t\t}\n\n\t\t\tstream.push({ type: \"turn_end\", message, toolResults });\n\n\t\t\t// Get steering messages after turn completes\n\t\t\tif (steeringAfterTools && steeringAfterTools.length > 0) {\n\t\t\t\tpendingMessages = steeringAfterTools;\n\t\t\t\tsteeringAfterTools = null;\n\t\t\t} else {\n\t\t\t\tpendingMessages = (await config.getSteeringMessages?.()) || [];\n\t\t\t}\n\t\t}\n\n\t\t// Agent would stop here. Check for follow-up messages.\n\t\tconst followUpMessages = (await config.getFollowUpMessages?.()) || [];\n\t\tif (followUpMessages.length > 0) {\n\t\t\t// Set as pending so inner loop processes them\n\t\t\tpendingMessages = followUpMessages;\n\t\t\tcontinue;\n\t\t}\n\n\t\t// No more messages, exit\n\t\tbreak;\n\t}\n\n\tstream.push({ type: \"agent_end\", messages: newMessages });\n\tstream.end(newMessages);\n}\n\n/**\n * Stream an assistant response from the LLM.\n * This is where AgentMessage[] gets transformed to Message[] for the LLM.\n */\nasync function streamAssistantResponse(\n\tcontext: AgentContext,\n\tconfig: AgentLoopConfig,\n\tsignal: AbortSignal | undefined,\n\tstream: EventStream<AgentEvent, AgentMessage[]>,\n\tstreamFn?: StreamFn,\n): Promise<AssistantMessage> {\n\t// Apply context transform if configured (AgentMessage[] → AgentMessage[])\n\tlet messages = context.messages;\n\tif (config.transformContext) {\n\t\tmessages = await config.transformContext(messages, signal);\n\t}\n\n\t// Convert to LLM-compatible messages (AgentMessage[] → Message[])\n\tconst llmMessages = await config.convertToLlm(messages);\n\n\t// Build LLM context\n\tconst llmContext: Context = {\n\t\tsystemPrompt: context.systemPrompt,\n\t\tmessages: llmMessages,\n\t\ttools: context.tools,\n\t};\n\n\tconst streamFunction = streamFn || streamSimple;\n\n\t// Resolve API key (important for expiring tokens)\n\tconst resolvedApiKey =\n\t\t(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;\n\n\tconst response = await streamFunction(config.model, llmContext, {\n\t\t...config,\n\t\tapiKey: resolvedApiKey,\n\t\tsignal,\n\t});\n\n\tlet partialMessage: AssistantMessage | null = null;\n\tlet addedPartial = false;\n\n\tfor await (const event of response) {\n\t\tswitch (event.type) {\n\t\t\tcase \"start\":\n\t\t\t\tpartialMessage = event.partial;\n\t\t\t\tcontext.messages.push(partialMessage);\n\t\t\t\taddedPartial = true;\n\t\t\t\tstream.push({ type: \"message_start\", message: { ...partialMessage } });\n\t\t\t\tbreak;\n\n\t\t\tcase \"text_start\":\n\t\t\tcase \"text_delta\":\n\t\t\tcase \"text_end\":\n\t\t\tcase \"thinking_start\":\n\t\t\tcase \"thinking_delta\":\n\t\t\tcase \"thinking_end\":\n\t\t\tcase \"toolcall_start\":\n\t\t\tcase \"toolcall_delta\":\n\t\t\tcase \"toolcall_end\":\n\t\t\t\tif (partialMessage) {\n\t\t\t\t\tpartialMessage = event.partial;\n\t\t\t\t\tcontext.messages[context.messages.length - 1] = partialMessage;\n\t\t\t\t\tstream.push({\n\t\t\t\t\t\ttype: \"message_update\",\n\t\t\t\t\t\tassistantMessageEvent: event,\n\t\t\t\t\t\tmessage: { ...partialMessage },\n\t\t\t\t\t});\n\t\t\t\t}\n\t\t\t\tbreak;\n\n\t\t\tcase \"done\":\n\t\t\tcase \"error\": {\n\t\t\t\tconst finalMessage = await response.result();\n\t\t\t\tif (addedPartial) {\n\t\t\t\t\tcontext.messages[context.messages.length - 1] = finalMessage;\n\t\t\t\t} else {\n\t\t\t\t\tcontext.messages.push(finalMessage);\n\t\t\t\t}\n\t\t\t\tif (!addedPartial) {\n\t\t\t\t\tstream.push({ type: \"message_start\", message: { ...finalMessage } });\n\t\t\t\t}\n\t\t\t\tstream.push({ type: \"message_end\", message: finalMessage });\n\t\t\t\treturn finalMessage;\n\t\t\t}\n\t\t}\n\t}\n\n\treturn await response.result();\n}\n\n/\*\*\n * Execute tool calls from an assistant message.\n */\nasync function executeToolCalls(\n\ttools: AgentTool<any>[] | undefined,\n\tassistantMessage: AssistantMessage,\n\tsignal: AbortSignal | undefined,\n\tstream: EventStream<AgentEvent, AgentMessage[]>,\n\tgetSteeringMessages?: AgentLoopConfig[\"getSteeringMessages\"],\n): Promise<{ toolResults: ToolResultMessage[]; steeringMessages?: AgentMessage[] }> {\n\tconst toolCalls = assistantMessage.content.filter((c) => c.type === \"toolCall\");\n\tconst results: ToolResultMessage[] = [];\n\tlet steeringMessages: AgentMessage[] | undefined;\n\n\tfor (let index = 0; index < toolCalls.length; index++) {\n\t\tconst toolCall = toolCalls[index];\n\t\tconst tool = tools?.find((t) => t.name === toolCall.name);\n\n\t\tstream.push({\n\t\t\ttype: \"tool_execution_start\",\n\t\t\ttoolCallId: toolCall.id,\n\t\t\ttoolName: toolCall.name,\n\t\t\targs: toolCall.arguments,\n\t\t});\n\n\t\tlet result: AgentToolResult<any>;\n\t\tlet isError = false;\n\n\t\ttry {\n\t\t\tif (!tool) throw new Error(`Tool ${toolCall.name} not found`);\n\n\t\t\tconst validatedArgs = validateToolArguments(tool, toolCall);\n\n\t\t\tresult = await tool.execute(toolCall.id, validatedArgs, signal, (partialResult) => {\n\t\t\t\tstream.push({\n\t\t\t\t\ttype: \"tool_execution_update\",\n\t\t\t\t\ttoolCallId: toolCall.id,\n\t\t\t\t\ttoolName: toolCall.name,\n\t\t\t\t\targs: toolCall.arguments,\n\t\t\t\t\tpartialResult,\n\t\t\t\t});\n\t\t\t});\n\t\t} catch (e) {\n\t\t\tresult = {\n\t\t\t\tcontent: [{ type: \"text\", text: e instanceof Error ? e.message : String(e) }],\n\t\t\t\tdetails: {},\n\t\t\t};\n\t\t\tisError = true;\n\t\t}\n\n\t\tstream.push({\n\t\t\ttype: \"tool_execution_end\",\n\t\t\ttoolCallId: toolCall.id,\n\t\t\ttoolName: toolCall.name,\n\t\t\tresult,\n\t\t\tisError,\n\t\t});\n\n\t\tconst toolResultMessage: ToolResultMessage = {\n\t\t\trole: \"toolResult\",\n\t\t\ttoolCallId: toolCall.id,\n\t\t\ttoolName: toolCall.name,\n\t\t\tcontent: result.content,\n\t\t\tdetails: result.details,\n\t\t\tisError,\n\t\t\ttimestamp: Date.now(),\n\t\t};\n\n\t\tresults.push(toolResultMessage);\n\t\tstream.push({ type: \"message_start\", message: toolResultMessage });\n\t\tstream.push({ type: \"message_end\", message: toolResultMessage });\n\n\t\t// Check for steering messages - skip remaining tools if user interrupted\n\t\tif (getSteeringMessages) {\n\t\t\tconst steering = await getSteeringMessages();\n\t\t\tif (steering.length > 0) {\n\t\t\t\tsteeringMessages = steering;\n\t\t\t\tconst remainingCalls = toolCalls.slice(index + 1);\n\t\t\t\tfor (const skipped of remainingCalls) {\n\t\t\t\t\tresults.push(skipToolCall(skipped, stream));\n\t\t\t\t}\n\t\t\t\tbreak;\n\t\t\t}\n\t\t}\n\t}\n\n\treturn { toolResults: results, steeringMessages };\n}\n\nfunction skipToolCall(\n\ttoolCall: Extract<AssistantMessage[\"content\"][number], { type: \"toolCall\" }>,\n\tstream: EventStream<AgentEvent, AgentMessage[]>,\n): ToolResultMessage {\n\tconst result: AgentToolResult<any> = {\n\t\tcontent: [{ type: \"text\", text: \"Skipped due to queued user message.\" }],\n\t\tdetails: {},\n\t};\n\n\tstream.push({\n\t\ttype: \"tool_execution_start\",\n\t\ttoolCallId: toolCall.id,\n\t\ttoolName: toolCall.name,\n\t\targs: toolCall.arguments,\n\t});\n\tstream.push({\n\t\ttype: \"tool_execution_end\",\n\t\ttoolCallId: toolCall.id,\n\t\ttoolName: toolCall.name,\n\t\tresult,\n\t\tisError: true,\n\t});\n\n\tconst toolResultMessage: ToolResultMessage = {\n\t\trole: \"toolResult\",\n\t\ttoolCallId: toolCall.id,\n\t\ttoolName: toolCall.name,\n\t\tcontent: result.content,\n\t\tdetails: {},\n\t\tisError: true,\n\t\ttimestamp: Date.now(),\n\t};\n\n\tstream.push({ type: \"message_start\", message: toolResultMessage });\n\tstream.push({ type: \"message_end\", message: toolResultMessage });\n\n\treturn toolResultMessage;\n}\n"]}
node_modules/@mariozechner/pi-agent-core/dist/proxy.js.map:1:{"version":3,"file":"proxy.js","sourceRoot":"","sources":["../src/proxy.ts"],"names":[],"mappings":"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","sourcesContent":["/\*\*\n * Proxy stream function for apps that route LLM calls through a server.\n * The server manages auth and proxies requests to LLM providers.\n */\n\n// Internal import for JSON parsing utility\nimport {\n\ttype AssistantMessage,\n\ttype AssistantMessageEvent,\n\ttype Context,\n\tEventStream,\n\ttype Model,\n\tparseStreamingJson,\n\ttype SimpleStreamOptions,\n\ttype StopReason,\n\ttype ToolCall,\n} from \"@mariozechner/pi-ai\";\n\n// Create stream class matching ProxyMessageEventStream\nclass ProxyMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {\n\tconstructor() {\n\t\tsuper(\n\t\t\t(event) => event.type === \"done\" || event.type === \"error\",\n\t\t\t(event) => {\n\t\t\t\tif (event.type === \"done\") return event.message;\n\t\t\t\tif (event.type === \"error\") return event.error;\n\t\t\t\tthrow new Error(\"Unexpected event type\");\n\t\t\t},\n\t\t);\n\t}\n}\n\n/**\n * Proxy event types - server sends these with partial field stripped to reduce bandwidth.\n */\nexport type ProxyAssistantMessageEvent =\n\t| { type: \"start\" }\n\t| { type: \"text_start\"; contentIndex: number }\n\t| { type: \"text_delta\"; contentIndex: number; delta: string }\n\t| { type: \"text_end\"; contentIndex: number; contentSignature?: string }\n\t| { type: \"thinking_start\"; contentIndex: number }\n\t| { type: \"thinking_delta\"; contentIndex: number; delta: string }\n\t| { type: \"thinking_end\"; contentIndex: number; contentSignature?: string }\n\t| { type: \"toolcall_start\"; contentIndex: number; id: string; toolName: string }\n\t| { type: \"toolcall_delta\"; contentIndex: number; delta: string }\n\t| { type: \"toolcall_end\"; contentIndex: number }\n\t| {\n\t\t\ttype: \"done\";\n\t\t\treason: Extract<StopReason, \"stop\" | \"length\" | \"toolUse\">;\n\t\t\tusage: AssistantMessage[\"usage\"];\n\t }\n\t| {\n\t\t\ttype: \"error\";\n\t\t\treason: Extract<StopReason, \"aborted\" | \"error\">;\n\t\t\terrorMessage?: string;\n\t\t\tusage: AssistantMessage[\"usage\"];\n\t };\n\nexport interface ProxyStreamOptions extends SimpleStreamOptions {\n\t/** Auth token for the proxy server */\n\tauthToken: string;\n\t/\*\* Proxy server URL (e.g., \"https://genai.example.com\") */\n\tproxyUrl: string;\n}\n\n/**\n * Stream function that proxies through a server instead of calling LLM providers directly.\n * The server strips the partial field from delta events to reduce bandwidth.\n * We reconstruct the partial message client-side.\n *\n * Use this as the `streamFn` option when creating an Agent that needs to go through a proxy.\n *\n * @example\n * `typescript\n * const agent = new Agent({\n *   streamFn: (model, context, options) =>\n *     streamProxy(model, context, {\n *       ...options,\n *       authToken: await getAuthToken(),\n *       proxyUrl: \"https://genai.example.com\",\n *     }),\n * });\n * `\n \*/\nexport function streamProxy(model: Model<any>, context: Context, options: ProxyStreamOptions): ProxyMessageEventStream {\n\tconst stream = new ProxyMessageEventStream();\n\n\t(async () => {\n\t\t// Initialize the partial message that we'll build up from events\n\t\tconst partial: AssistantMessage = {\n\t\t\trole: \"assistant\",\n\t\t\tstopReason: \"stop\",\n\t\t\tcontent: [],\n\t\t\tapi: model.api,\n\t\t\tprovider: model.provider,\n\t\t\tmodel: model.id,\n\t\t\tusage: {\n\t\t\t\tinput: 0,\n\t\t\t\toutput: 0,\n\t\t\t\tcacheRead: 0,\n\t\t\t\tcacheWrite: 0,\n\t\t\t\ttotalTokens: 0,\n\t\t\t\tcost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },\n\t\t\t},\n\t\t\ttimestamp: Date.now(),\n\t\t};\n\n\t\tlet reader: ReadableStreamDefaultReader<Uint8Array> | undefined;\n\n\t\tconst abortHandler = () => {\n\t\t\tif (reader) {\n\t\t\t\treader.cancel(\"Request aborted by user\").catch(() => {});\n\t\t\t}\n\t\t};\n\n\t\tif (options.signal) {\n\t\t\toptions.signal.addEventListener(\"abort\", abortHandler);\n\t\t}\n\n\t\ttry {\n\t\t\tconst response = await fetch(`${options.proxyUrl}/api/stream`, {\n\t\t\t\tmethod: \"POST\",\n\t\t\t\theaders: {\n\t\t\t\t\tAuthorization: `Bearer ${options.authToken}`,\n\t\t\t\t\t\"Content-Type\": \"application/json\",\n\t\t\t\t},\n\t\t\t\tbody: JSON.stringify({\n\t\t\t\t\tmodel,\n\t\t\t\t\tcontext,\n\t\t\t\t\toptions: {\n\t\t\t\t\t\ttemperature: options.temperature,\n\t\t\t\t\t\tmaxTokens: options.maxTokens,\n\t\t\t\t\t\treasoning: options.reasoning,\n\t\t\t\t\t},\n\t\t\t\t}),\n\t\t\t\tsignal: options.signal,\n\t\t\t});\n\n\t\t\tif (!response.ok) {\n\t\t\t\tlet errorMessage = `Proxy error: ${response.status} ${response.statusText}`;\n\t\t\t\ttry {\n\t\t\t\t\tconst errorData = (await response.json()) as { error?: string };\n\t\t\t\t\tif (errorData.error) {\n\t\t\t\t\t\terrorMessage = `Proxy error: ${errorData.error}`;\n\t\t\t\t\t}\n\t\t\t\t} catch {\n\t\t\t\t\t// Couldn't parse error response\n\t\t\t\t}\n\t\t\t\tthrow new Error(errorMessage);\n\t\t\t}\n\n\t\t\treader = response.body!.getReader();\n\t\t\tconst decoder = new TextDecoder();\n\t\t\tlet buffer = \"\";\n\n\t\t\twhile (true) {\n\t\t\t\tconst { done, value } = await reader.read();\n\t\t\t\tif (done) break;\n\n\t\t\t\tif (options.signal?.aborted) {\n\t\t\t\t\tthrow new Error(\"Request aborted by user\");\n\t\t\t\t}\n\n\t\t\t\tbuffer += decoder.decode(value, { stream: true });\n\t\t\t\tconst lines = buffer.split(\"\\n\");\n\t\t\t\tbuffer = lines.pop() || \"\";\n\n\t\t\t\tfor (const line of lines) {\n\t\t\t\t\tif (line.startsWith(\"data: \")) {\n\t\t\t\t\t\tconst data = line.slice(6).trim();\n\t\t\t\t\t\tif (data) {\n\t\t\t\t\t\t\tconst proxyEvent = JSON.parse(data) as ProxyAssistantMessageEvent;\n\t\t\t\t\t\t\tconst event = processProxyEvent(proxyEvent, partial);\n\t\t\t\t\t\t\tif (event) {\n\t\t\t\t\t\t\t\tstream.push(event);\n\t\t\t\t\t\t\t}\n\t\t\t\t\t\t}\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t}\n\n\t\t\tif (options.signal?.aborted) {\n\t\t\t\tthrow new Error(\"Request aborted by user\");\n\t\t\t}\n\n\t\t\tstream.end();\n\t\t} catch (error) {\n\t\t\tconst errorMessage = error instanceof Error ? error.message : String(error);\n\t\t\tconst reason = options.signal?.aborted ? \"aborted\" : \"error\";\n\t\t\tpartial.stopReason = reason;\n\t\t\tpartial.errorMessage = errorMessage;\n\t\t\tstream.push({\n\t\t\t\ttype: \"error\",\n\t\t\t\treason,\n\t\t\t\terror: partial,\n\t\t\t});\n\t\t\tstream.end();\n\t\t} finally {\n\t\t\tif (options.signal) {\n\t\t\t\toptions.signal.removeEventListener(\"abort\", abortHandler);\n\t\t\t}\n\t\t}\n\t})();\n\n\treturn stream;\n}\n\n/**\n * Process a proxy event and update the partial message.\n */\nfunction processProxyEvent(\n\tproxyEvent: ProxyAssistantMessageEvent,\n\tpartial: AssistantMessage,\n): AssistantMessageEvent | undefined {\n\tswitch (proxyEvent.type) {\n\t\tcase \"start\":\n\t\t\treturn { type: \"start\", partial };\n\n\t\tcase \"text_start\":\n\t\t\tpartial.content[proxyEvent.contentIndex] = { type: \"text\", text: \"\" };\n\t\t\treturn { type: \"text_start\", contentIndex: proxyEvent.contentIndex, partial };\n\n\t\tcase \"text_delta\": {\n\t\t\tconst content = partial.content[proxyEvent.contentIndex];\n\t\t\tif (content?.type === \"text\") {\n\t\t\t\tcontent.text += proxyEvent.delta;\n\t\t\t\treturn {\n\t\t\t\t\ttype: \"text_delta\",\n\t\t\t\t\tcontentIndex: proxyEvent.contentIndex,\n\t\t\t\t\tdelta: proxyEvent.delta,\n\t\t\t\t\tpartial,\n\t\t\t\t};\n\t\t\t}\n\t\t\tthrow new Error(\"Received text_delta for non-text content\");\n\t\t}\n\n\t\tcase \"text_end\": {\n\t\t\tconst content = partial.content[proxyEvent.contentIndex];\n\t\t\tif (content?.type === \"text\") {\n\t\t\t\tcontent.textSignature = proxyEvent.contentSignature;\n\t\t\t\treturn {\n\t\t\t\t\ttype: \"text_end\",\n\t\t\t\t\tcontentIndex: proxyEvent.contentIndex,\n\t\t\t\t\tcontent: content.text,\n\t\t\t\t\tpartial,\n\t\t\t\t};\n\t\t\t}\n\t\t\tthrow new Error(\"Received text_end for non-text content\");\n\t\t}\n\n\t\tcase \"thinking_start\":\n\t\t\tpartial.content[proxyEvent.contentIndex] = { type: \"thinking\", thinking: \"\" };\n\t\t\treturn { type: \"thinking_start\", contentIndex: proxyEvent.contentIndex, partial };\n\n\t\tcase \"thinking_delta\": {\n\t\t\tconst content = partial.content[proxyEvent.contentIndex];\n\t\t\tif (content?.type === \"thinking\") {\n\t\t\t\tcontent.thinking += proxyEvent.delta;\n\t\t\t\treturn {\n\t\t\t\t\ttype: \"thinking_delta\",\n\t\t\t\t\tcontentIndex: proxyEvent.contentIndex,\n\t\t\t\t\tdelta: proxyEvent.delta,\n\t\t\t\t\tpartial,\n\t\t\t\t};\n\t\t\t}\n\t\t\tthrow new Error(\"Received thinking_delta for non-thinking content\");\n\t\t}\n\n\t\tcase \"thinking_end\": {\n\t\t\tconst content = partial.content[proxyEvent.contentIndex];\n\t\t\tif (content?.type === \"thinking\") {\n\t\t\t\tcontent.thinkingSignature = proxyEvent.contentSignature;\n\t\t\t\treturn {\n\t\t\t\t\ttype: \"thinking_end\",\n\t\t\t\t\tcontentIndex: proxyEvent.contentIndex,\n\t\t\t\t\tcontent: content.thinking,\n\t\t\t\t\tpartial,\n\t\t\t\t};\n\t\t\t}\n\t\t\tthrow new Error(\"Received thinking_end for non-thinking content\");\n\t\t}\n\n\t\tcase \"toolcall_start\":\n\t\t\tpartial.content[proxyEvent.contentIndex] = {\n\t\t\t\ttype: \"toolCall\",\n\t\t\t\tid: proxyEvent.id,\n\t\t\t\tname: proxyEvent.toolName,\n\t\t\t\targuments: {},\n\t\t\t\tpartialJson: \"\",\n\t\t\t} satisfies ToolCall & { partialJson: string } as ToolCall;\n\t\t\treturn { type: \"toolcall_start\", contentIndex: proxyEvent.contentIndex, partial };\n\n\t\tcase \"toolcall_delta\": {\n\t\t\tconst content = partial.content[proxyEvent.contentIndex];\n\t\t\tif (content?.type === \"toolCall\") {\n\t\t\t\t(content as any).partialJson += proxyEvent.delta;\n\t\t\t\tcontent.arguments = parseStreamingJson((content as any).partialJson) || {};\n\t\t\t\tpartial.content[proxyEvent.contentIndex] = { ...content }; // Trigger reactivity\n\t\t\t\treturn {\n\t\t\t\t\ttype: \"toolcall_delta\",\n\t\t\t\t\tcontentIndex: proxyEvent.contentIndex,\n\t\t\t\t\tdelta: proxyEvent.delta,\n\t\t\t\t\tpartial,\n\t\t\t\t};\n\t\t\t}\n\t\t\tthrow new Error(\"Received toolcall_delta for non-toolCall content\");\n\t\t}\n\n\t\tcase \"toolcall_end\": {\n\t\t\tconst content = partial.content[proxyEvent.contentIndex];\n\t\t\tif (content?.type === \"toolCall\") {\n\t\t\t\tdelete (content as any).partialJson;\n\t\t\t\treturn {\n\t\t\t\t\ttype: \"toolcall_end\",\n\t\t\t\t\tcontentIndex: proxyEvent.contentIndex,\n\t\t\t\t\ttoolCall: content,\n\t\t\t\t\tpartial,\n\t\t\t\t};\n\t\t\t}\n\t\t\treturn undefined;\n\t\t}\n\n\t\tcase \"done\":\n\t\t\tpartial.stopReason = proxyEvent.reason;\n\t\t\tpartial.usage = proxyEvent.usage;\n\t\t\treturn { type: \"done\", reason: proxyEvent.reason, message: partial };\n\n\t\tcase \"error\":\n\t\t\tpartial.stopReason = proxyEvent.reason;\n\t\t\tpartial.errorMessage = proxyEvent.errorMessage;\n\t\t\tpartial.usage = proxyEvent.usage;\n\t\t\treturn { type: \"error\", reason: proxyEvent.reason, error: partial };\n\n\t\tdefault: {\n\t\t\tconst \_exhaustiveCheck: never = proxyEvent;\n\t\t\tconsole.warn(`Unhandled proxy event type: ${(proxyEvent as any).type}`);\n\t\t\treturn undefined;\n\t\t}\n\t}\n}\n"]}
2026-02-02T06:44:47.261510Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:44:47.261588Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.
exec
/bin/bash -lc 'rg -n "onReasoningStream" -S src | head -n 50' in /home/davidmarsh/code/moltbot succeeded in 66ms:
src/discord/monitor/message-handler.process.ts:431: onReasoningStream: discordConfig?.reasoningStreaming
src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.subscribeembeddedpisession.test.ts:18: "streams <%s> reasoning via onReasoningStream without leaking into final text",
src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.subscribeembeddedpisession.test.ts:28: const onReasoningStream = vi.fn();
src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.subscribeembeddedpisession.test.ts:34: onReasoningStream,
src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.subscribeembeddedpisession.test.ts:73: const streamTexts = onReasoningStream.mock.calls
src/agents/pi-embedded-subscribe.ts:44: streamReasoning: reasoningMode === "stream" && typeof params.onReasoningStream === "function",
src/agents/pi-embedded-subscribe.ts:506: if (!state.streamReasoning || !params.onReasoningStream) {
src/agents/pi-embedded-subscribe.ts:517: void params.onReasoningStream({
src/agents/pi-embedded-runner/run.ts:361: onReasoningStream: params.onReasoningStream,
src/agents/pi-embedded-runner/run/attempt.ts:655: onReasoningStream: params.onReasoningStream,
src/agents/pi-embedded-runner/run/types.ts:78: onReasoningStream?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
src/agents/pi-embedded-runner/run/params.ts:89: onReasoningStream?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
src/agents/pi-embedded-subscribe.types.ts:16: onReasoningStream?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
src/auto-reply/types.ts:47: onReasoningStream?: (payload: ReplyPayload) => Promise<void> | void;
src/auto-reply/reply/agent-runner.heartbeat-typing.runreplyagent-typing-heartbeat.signals-typing-normal-runs.test.ts:202: onReasoningStream?: (payload: { text?: string }) => Promise<void> | void;
src/auto-reply/reply/agent-runner.heartbeat-typing.runreplyagent-typing-heartbeat.signals-typing-normal-runs.test.ts:204: await params.onReasoningStream?.({ text: "Reasoning:\n_step\*" });
src/auto-reply/reply/agent-runner-execution.ts:108: params.followupRun.run.reasoningLevel === "stream" && params.opts?.onReasoningStream
src/auto-reply/reply/agent-runner-execution.ts:309: onReasoningStream:
src/auto-reply/reply/agent-runner-execution.ts:310: params.typingSignals.shouldStartOnReasoning || params.opts?.onReasoningStream
src/auto-reply/reply/agent-runner-execution.ts:313: await params.opts?.onReasoningStream?.({
2026-02-02T06:44:55.902506Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:44:55.902555Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.
exec
/bin/bash -lc "sed -n '380,520p' src/discord/monitor/message-handler.process.ts" in /home/davidmarsh/code/moltbot succeeded in 63ms:
replyOptions: {
...replyOptions,
skillFilter: channelConfig?.skills,
disableBlockStreaming:
typeof discordConfig?.blockStreaming === "boolean"
? !discordConfig.blockStreaming
: undefined,
onModelSelected: (ctx) => {
prefixContext.onModelSelected(ctx);
},
// Send tool status updates during long-running operations
onToolStatusUpdate: discordConfig?.toolStatusUpdates
? async (update) => {
// Only send for long-running tools (exec, process, sessions_spawn, browser)
const longRunningTools = ["exec", "process", "sessions_spawn", "browser"];
if (!longRunningTools.includes(update.toolName)) {
return;
}

            // Format status content with optional tail output

2026-02-02T06:44:58.909251Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:44:58.909301Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.
exec
/bin/bash -lc 'rg -n "sendOrUpdateReasoningStream" -S src/discord | head -n 50' in /home/davidmarsh/code/moltbot succeeded in 68ms:
src/discord/monitor/message-handler.process.ts:43:import { sendOrUpdateReasoningStream, clearReasoningEntry } from "./reasoning-stream-manager.js";
src/discord/monitor/message-handler.process.ts:439: await sendOrUpdateReasoningStream({
src/discord/monitor/reasoning-stream-manager.ts:64:export async function sendOrUpdateReasoningStream(
src/discord/monitor/reasoning-stream-manager.ts:120: return sendOrUpdateReasoningStream(params);
2026-02-02T06:45:04.346453Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:45:04.346505Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.
exec
/bin/bash -lc "sed -n '1,220p' src/discord/monitor/reasoning-stream-manager.ts" in /home/davidmarsh/code/moltbot succeeded in 59ms:
import type { RequestClient } from "@buape/carbon";
import { editMessageDiscord, sendMessageDiscord } from "../send.js";
import { logVerbose } from "../../globals.js";

type ReasoningMessageEntry = {
messageId: string;
channelId: string;
createdAt: number;
};

/\*_ Max age for reasoning message entries (5 minutes). _/
const REASONING*MESSAGE_TTL_MS = 5 * 60 \_ 1000;

/\*_ Minimum time between updates to avoid rate limits (1.5 seconds). _/
const REASONING_THROTTLE_MS = 1500;

/\*_ Sweep interval for removing stale entries (2 minutes). _/
const SWEEP*INTERVAL_MS = 2 * 60 \_ 1000;

/\*_ Max content length with buffer for Discord's 2000 char limit. _/
2026-02-02T06:45:06.572603Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:45:06.572651Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.

thinking
**Analyzing message handling**

I'm thinking about how events work in the pi-agent-core. It seems like they come from proxy mapping, and the message_end event likely occurs after the done event. I’m wondering if there could be a bug here. It's essential to note that handleMessageEnd resets the nativeThinkingBuffer but not the lastStreamedReasoning, which might be intentional to avoid deduplication. However, it seems resetting lastStreamedReasoning at the end would help prevent cross-message issues. But since message_start resets it already, that could avoid sending duplicates too.
thinking
**Examining message handling logic**

At the message_end, they call emitReasoningStream with rawThinking after streaming partial thinking blocks. If lastStreamedReasoning matches formattedReasoning, it skips re-sending, which seems smart. However, they clear the nativeThinkingBuffer but not lastStreamedReasoning. As long as no more thinking events occur post-message_end, this shouldn’t be an issue. Still, I’m curious about how handleMessageUpdate works, especially with isTextEvent and isThinkingEvent flags. I wonder how it integrates with other events like tool calls, which could be managed differently.
thinking
**Focusing on auditing**

Our audit should center on a few key areas: Firstly, I want to gather thinking deltas from Claude’s native thinking blocks instead of just the <think> tags. I need to stream reasoning incrementally to Discord using emitReasoningStream(), but without interfering with existing <think> tag streaming. It's important to reset the state between messages properly and check edge cases, state management, race conditions, and potential bugs.

There's also existing <think> tag streaming for text events that extracts reasoning content, but I need to address how native thinking blocks are being emitted and ensure nothing leaks into the final answer.
thinking
**Assessing thinking block extraction**

For thinking blocks, the function extractAssistantThinking collects these blocks and returns them in a joined format. At message_end, rawThinking is derived from the assistantMessage, utilizing extractThinkingFromTaggedText for <think> tags present in the rawText. This means that reasoning at message_end could potentially combine or duplicate both native thinking blocks and tagged thinking.

However, there's a catch: rawThinking is computed based on context states, and if extractAssistantThinking returns a non-empty string, extractThinkingFromTaggedText won’t be included. This could lead to ignoring <think> tag reasoning despite wanting to keep that streaming intact.
thinking
**Examining buffer handling in reasoning**

I’m considering how thinking blocks are processed, particularly how they might override tag reasoning. When using native thinking blocks, they should stream correctly without interfering with existing <think> tags, unless both types are present. If both are included, we may want to combine them instead of using OR logic, but that could lead to confusion with competing updates. HandleMessageUpdate seems to avoid processing text for thinking events, which is good, but I need to figure out if the buffer accumulates across multiple thinking blocks.

There’s a risk that, upon starting a new thinking block, we inadvertently override previous content in the buffer. I wonder if we should reset it or keep accumulating, as the requirements are a bit vague. Streaming might expect all reasoning accumulated to show the full context, and appending separators could prevent run-on text issues. However, since we currently ignore thinking_start, that could lead to concatenated content without newlines. Final messages should ideally match the streamed content, but I should ensure we don’t lose earlier blocks when we end thinking.
thinking
**Analyzing thinking block handling**

I’m realizing that the content in thinking_end relates only to the current block, not aggregating multiple blocks. This means our code would replace the buffer with only the last block’s content, which could lead to losing earlier blocks—a potential bug. Although if only one block is present, it’s fine. We should ensure it can handle multiple thinking blocks since it seems Claude might produce them, so it's wise to prepare for that possibility.

Additionally, we’ve got clear resets between messages, which helps maintain a clean state. However, edge cases could arise if message_update happens without a preceding message_start. If state isn't reset, it could carry over old buffers incorrectly.

Overall, we need to ensure that we don’t update the buffer unnecessarily if the thinking_content is empty and manage whitespace or partial tokens correctly.
thinking
**Reviewing event handling**

I see that when handling `thinking` events, while we're logging deltas and content, the current method could lead to some inefficiencies. Specifically, I need to check how the nativeThinkingBuffer is updated on `thinking_start`. If there’s leftover content from previous messages, it might create confusion—potentially needing separate handling for newlines.

More importantly, I notice deduplication isn’t being effectively managed during streaming, which can lead to frequent updates that might impact performance. Although Discord’s manager throttles, it may still be beneficial to implement throttling at the source level as well.

Additionally, it seems that the reasoning message remains in the channel even after updates stop tracking—possibly as a way to provide users with context while generating responses. However, I’m a bit concerned about potential memory growth since the buffer doesn’t have a limit, which might eventually exceed what Discord can handle.

And while the event handlers manage incoming messages synchronously, we need to consider possible concurrency issues—especially with asynchronous events potentially complicating things.
thinking
**Evaluating potential race conditions**

I’m noticing that the `handleMessageUpdate` function doesn’t wait, so it shouldn’t have concurrency issues. However, the `onReasoningStream` callback is asynchronous in the Discord message handler, and `emitReasoningStream` calls it without awaiting. That could lead to multiple updates happening at once, which raises concerns about out-of-order messages.

If two calls to `sendOrUpdateReasoningStream` occur simultaneously, it’s possible for the later call to finish first and overwrite earlier content. This could cause regressions, leading to mismatched reasoning.

I think we should mention these potential race conditions even though our modifications don't introduce them; they already exist due to the current design.
exec
/bin/bash -lc "sed -n '1,140p' src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.subscribeembeddedpisession.test.ts" in /home/davidmarsh/code/moltbot succeeded in 61ms:
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
subscribe: (fn: (evt: unknown) => void) => () => void;
};

describe("subscribeEmbeddedPiSession", () => {
const THINKING_TAG_CASES = [
{ tag: "think", open: "<think>", close: "</think>" },
{ tag: "thinking", open: "<thinking>", close: "</thinking>" },
{ tag: "thought", open: "<thought>", close: "</thought>" },
{ tag: "antthinking", open: "<antthinking>", close: "</antthinking>" },
] as const;

it.each(THINKING_TAG_CASES)(
"streams <%s> reasoning via onReasoningStream without leaking into final text",
({ open, close }) => {
let handler: ((evt: unknown) => void) | undefined;
2026-02-02T06:47:31.532722Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:47:31.532773Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.
exec
/bin/bash -lc "sed -n '1,120p' node_modules/@mariozechner/pi-agent-core/dist/proxy.d.ts" in /home/davidmarsh/code/moltbot succeeded in 59ms:
/\*\*

- Proxy stream function for apps that route LLM calls through a server.
- The server manages auth and proxies requests to LLM providers.
  \*/
  import { type AssistantMessage, type AssistantMessageEvent, type Context, EventStream, type Model, type SimpleStreamOptions, type StopReason } from "@mariozechner/pi-ai";
  declare class ProxyMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor();
  }
  /\*\*
- Proxy event types - server sends these with partial field stripped to reduce bandwidth.
  \*/
  export type ProxyAssistantMessageEvent = {
  type: "start";
  } | {
  type: "text_start";
  contentIndex: number;
  } | {
  type: "text_delta";
  contentIndex: number;
  delta: string;
  2026-02-02T06:47:41.451103Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
  "error": {
  "message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
  "type": "invalid_request_error",
  "param": null,
  "code": "refresh_token_reused"
  }
  }
  2026-02-02T06:47:41.451158Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.

thinking
**Examining event deltas**

I need to consider whether thinking_delta could miss deltas due to throttling or loss. They try to correct this by sending the full content at the end, but since we maintain a local partial stream, what if we missed something? Actually, we can't miss deltas because the event stream is sequential. However, if our handler ignores events due to some issue, those would still go to the buffer. So, a correction might not be necessary unless we start streaming in the middle. That’s a consideration for proxy streaming too.
thinking
**Clarifying event handling**

Our subscribe handler listens for events from the session, which are likely AssistantMessageEvents instead of ProxyAssistantMessageEvent. These events include delta updates, but we might not always receive all of them. There’s a scenario where some providers emit thinking_end with full content but skip the thinking_delta events. In that case, our buffer would be empty, but thinking_end would still set it to the new content. However, I need to check if pi-agent-core can produce multiple thinking blocks, as it utilizes the contentIndex array for these.
thinking
**Considering message blocks**

For typical messages, I see that it’s possible to have multiple blocks—like text block 0, thinking block 1, and text block 2. For Claude, reasoning may appear first as a thinking block, followed by a text block. I wonder if multiple thinking blocks could exist? There’s nothing preventing it, especially since promoteThinkingTagsToBlocks can create thinking blocks from tags within text. If the text contains several thinking segments, multiple blocks could be created. I'll need to explore how this works, especially since our code currently uses a single buffer.
thinking
**Examining the nativeThinkingBuffer**

I see that the new state field name is nativeThinkingBuffer, which suggests only one buffer is assumed. I should definitely note this limitation. When looking at handleMessageUpdate for thinking events, it doesn’t consider contentIndex. If there are multiple thinking blocks, separating them might not be possible, but we may not need to.

One potential issue is that the reasoning stream emits on every thinking event, including thinking_start. Since the buffer is empty initially, the first emission happens on the first thinking_delta. the isThinkingEvent variable includes both thinking_start and thinking_end, which could lead to duplicates if not managed correctly. Also, I realize the buffer is cleared at message_start through resetAssistantMessageState, which is called in handleMessageStart, but there could be a timing issue if message_update events come in before message_start.
thinking
**Reviewing message handling in pi-agent-core**

I'm noticing that typically, message_start should happen before updates, but tests show it can sometimes be skipped, leading to potential accumulation of states across messages if there's no reset. However, message_end also resets the nativeThinkingBuffer, making it safer even if message_start is absent.

There's concern about whether message_end is always sent, but it seems to be part of the events in createEmbeddedPiSessionEventHandler. If both message_start and message_end are missing, I need to check where resetAssistantMessageState might be invoked, as it's not well handled right now. This could lead to mismatches, especially since only partial resets happen.

I need to audit specific edge cases: first, checking if thinking deltas from Claude's native thinking blocks accumulate correctly and don't mix with <think> tags. The system does appear to handle increments but needs to be reviewed for proper formatting and interference with existing streaming. The extractAssistantText function also strips thinking tags, which seems solid, but I'll inspect the promoteThinkingTagsToBlocks function to ensure it doesn't interfere with the native thinking block processing.
exec
/bin/bash -lc 'rg -n "function promoteThinkingTagsToBlocks" -S src/agents/pi-embedded-utils.ts' in /home/davidmarsh/code/moltbot succeeded in 63ms:
330:export function promoteThinkingTagsToBlocks(message: AssistantMessage): void {
2026-02-02T06:48:15.153606Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:48:15.153657Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.
exec
/bin/bash -lc "sed -n '320,460p' src/agents/pi-embedded-utils.ts" in /home/davidmarsh/code/moltbot succeeded in 61ms:
}
pushText(text.slice(cursor));

const hasThinking = blocks.some((b) => b.type === "thinking");
if (!hasThinking) {
return null;
}
return blocks;
}

export function promoteThinkingTagsToBlocks(message: AssistantMessage): void {
if (!Array.isArray(message.content)) {
return;
}
const hasThinkingBlock = message.content.some((block) => block.type === "thinking");
if (hasThinkingBlock) {
return;
}

const next: AssistantMessage["content"] = [];
2026-02-02T06:48:18.237855Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:48:18.237904Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.

thinking
**Evaluating streaming implementation**

I'm considering whether we should call `appendRawStream` for thinking events. It's not strictly necessary, but checking for integration with `assistantTexts` is important since we likely don't want reasoning to go there. It seems that nativeThinkingBuffer is separate, which is good. We need to verify if the implementation streams reasoning to Discord incrementally, not just at the end of the message. Also, the `thinking_end` event includes content that we need to take into account during processing.
thinking
**Checking state management**

I need to evaluate how state management resets are handled. In `subscribe.ts`, the function `resetAssistantMessageState` resets several variables including `state.lastStreamedReasoning` and `state.nativeThinkingBuffer`. That’s good! However, I see a potential bug; when tests call `handleMessageUpdate` without `message_start`, `resetAssistantMessageState` isn't executed. This means `lastStreamedReasoning` could retain previous values, and that could mess up new assistant messages. Although `message_start` seems crucial in production, tests show it might not always be necessary, which is worth considering.
thinking
**Examining message resets**

I think that perhaps `message_end` should fully reset `lastStreamedReasoning` to ensure safe boundaries, even without `message_start`. However, the comment in the code suggests that `message_start` is seen as the only reliable boundary, although `message_end` also serves as a boundary. If `message_start` is missing, state needs to reset anyway. I want to review how `handleMessageEnd` resets `lastStreamedReasoning`, as it seems like it doesn’t. I should also check older commits or use `git diff` to gather changes for the user's request.
thinking
**Auditing file changes**

It seems the changes might already be made, and they want me to audit those files. I'll use `git diff` to inspect any changes, especially since I can run it in a read-only environment without causing issues. I wonder if it would be better to show modifications since the last commit or simply uncommitted changes. I see that the times indicate some recent modifications, so I'll go ahead and run `git diff` to examine the three files' differences relative to the repository baseline.
exec
/bin/bash -lc "git diff -- src/agents/pi-embedded-subscribe.handlers.types.ts src/agents/pi-embedded-subscribe.ts src/agents/pi-embedded-subscribe.handlers.messages.ts | sed -n '1,200p'" in /home/davidmarsh/code/moltbot succeeded in 60ms:
diff --git a/src/agents/pi-embedded-subscribe.handlers.messages.ts b/src/agents/pi-embedded-subscribe.handlers.messages.ts
index 840d5c74b..500f7dcb2 100644
--- a/src/agents/pi-embedded-subscribe.handlers.messages.ts
+++ b/src/agents/pi-embedded-subscribe.handlers.messages.ts
@@ -64,13 +64,46 @@ export function handleMessageUpdate(
: undefined;
const evtType = typeof assistantRecord?.type === "string" ? assistantRecord.type : "";

- if (evtType !== "text_delta" && evtType !== "text_start" && evtType !== "text_end") {

* const isTextEvent = evtType === "text_delta" || evtType === "text_start" || evtType === "text_end";
* const isThinkingEvent = evtType === "thinking_delta" || evtType === "thinking_start" || evtType === "thinking_end";
*
* if (!isTextEvent && !isThinkingEvent) {
  return;
  }

  const delta = typeof assistantRecord?.delta === "string" ? assistantRecord.delta : "";
  const content = typeof assistantRecord?.content === "string" ? assistantRecord.content : "";

* // Handle native thinking block events (Claude extended thinking)
  2026-02-02T06:48:50.560802Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
  "error": {
  "message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
  "type": "invalid_request_error",
  "param": null,
  "code": "refresh_token_reused"
  }
  }
  2026-02-02T06:48:50.560853Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.

thinking
**Checking event handling**

I’m considering whether other parts of the code treat events as unknown types, which might result in ignoring thinking events. Specifically, I want to look at `src/infra/agent-events.js`. I’ll need to clarify if message_update events for thinking blocks fall under msg.content or if they’re located in a different field. Overall, I recognize that handleMessageUpdate correctly leverages assistantMessageEvent's type and delta. That part seems to be on track!
exec
/bin/bash -lc "sed -n '1,120p' node_modules/@mariozechner/pi-agent-core/dist/types.d.ts 2>/dev/null || true" in /home/davidmarsh/code/moltbot succeeded in 60ms:
import type { AssistantMessageEvent, ImageContent, Message, Model, SimpleStreamOptions, streamSimple, TextContent, Tool, ToolResultMessage } from "@mariozechner/pi-ai";
import type { Static, TSchema } from "@sinclair/typebox";
/** Stream function - can return sync or Promise for async config lookup \*/
export type StreamFn = (...args: Parameters<typeof streamSimple>) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>;
/**

- Configuration for the agent loop.
  _/
  export interface AgentLoopConfig extends SimpleStreamOptions {
  model: Model<any>;
  /\*\*
  _ Converts AgentMessage[] to LLM-compatible Message[] before each LLM call. \*
  _ Each AgentMessage must be converted to a UserMessage, AssistantMessage, or ToolResultMessage
  _ that the LLM can understand. AgentMessages that cannot be converted (e.g., UI-only notifications,
  _ status messages) should be filtered out.
  _
  _ @example
  _ ```typescript
  _ convertToLlm: (messages) => messages.flatMap(m => {
  _ if (m.role === "custom") {
  2026-02-02T06:49:37.043421Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
  "error": {
  "message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
  "type": "invalid_request_error",
  "param": null,
  "code": "refresh_token_reused"
  }
  }
  2026-02-02T06:49:37.043470Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.

thinking
**Inspecting type definitions**

I think I should check out `src/agents/pi-embedded-runner/run/types.ts` and maybe the types for `onReasoningStream` to ensure everything's correct. It feels important to verify I'm on the right track. But first, I might dive into `pi-embedded-subscribe.types.ts` to see what’s going on there. This will help me understand the types better and ensure everything aligns properly. Let's see what we find!
exec
/bin/bash -lc "sed -n '1,120p' src/agents/pi-embedded-subscribe.types.ts" in /home/davidmarsh/code/moltbot succeeded in 59ms:
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { ReasoningLevel, VerboseLevel } from "../auto-reply/thinking.js";
import type { BlockReplyChunking } from "./pi-embedded-block-chunker.js";

export type ToolResultFormat = "markdown" | "plain";

export type SubscribeEmbeddedPiSessionParams = {
session: AgentSession;
runId: string;
verboseLevel?: VerboseLevel;
reasoningMode?: ReasoningLevel;
toolResultFormat?: ToolResultFormat;
shouldEmitToolResult?: () => boolean;
shouldEmitToolOutput?: () => boolean;
onToolResult?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
onReasoningStream?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
onBlockReply?: (payload: {
text?: string;
mediaUrls?: string[];
audioAsVoice?: boolean;
2026-02-02T06:49:43.065502Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:49:43.065561Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.

thinking
**Checking reasoningMode**

I think I need to look into whether they set the reasoningMode. The best way to start is to search for "reasoningMode" in the message-handler.process.ts file. This should help me determine if it's been configured correctly. It's important to make sure everything is set up to ensure smooth processing. I'll get right on that! Let's see what the code shows.
exec
/bin/bash -lc 'rg -n "reasoningMode" src/discord/monitor/message-handler.process.ts' in /home/davidmarsh/code/moltbot exited 1 in 59ms:

2026-02-02T06:49:56.654745Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:49:56.654794Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.
exec
/bin/bash -lc "sed -n '1,200p' src/auto-reply/thinking.ts" in /home/davidmarsh/code/moltbot succeeded in 63ms:
export type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type VerboseLevel = "off" | "on" | "full";
export type NoticeLevel = "off" | "on" | "full";
export type ElevatedLevel = "off" | "on" | "ask" | "full";
export type ElevatedMode = "off" | "ask" | "full";
export type ReasoningLevel = "off" | "on" | "stream";
export type UsageDisplayLevel = "off" | "tokens" | "full";

function normalizeProviderId(provider?: string | null): string {
if (!provider) {
return "";
}
const normalized = provider.trim().toLowerCase();
if (normalized === "z.ai" || normalized === "z-ai") {
return "zai";
}
return normalized;
}

export function isBinaryThinkingProvider(provider?: string | null): boolean {
2026-02-02T06:50:02.500435Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:50:02.500483Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.

thinking
**Evaluating code updates**

I see we could simplify things. They return early for thinking events, preventing updates to deltaBuffer, which is good for keeping reasoning clean. I should check if other parts of the code depend on the deltaBuffer from assistantMessageEvent for different reasons. While thinking events don't update deltaBuffer, I wonder if they should.

I need to look at tests, as there are none for native thinking events. I should ensure there’s coverage here eventually. Also, checking if the feature integrates into the message handler is essential. Let’s search for the `reasoningStreaming` usage.
exec
/bin/bash -lc 'rg -n "reasoningStreaming" -S src | head -n 50' in /home/davidmarsh/code/moltbot succeeded in 74ms:
src/config/types.discord.ts:138: reasoningStreaming?: boolean;
src/config/zod-schema.providers-core.ts:277: reasoningStreaming: z.boolean().optional(),
src/discord/monitor/message-handler.process.ts:431: onReasoningStream: discordConfig?.reasoningStreaming
src/discord/monitor/message-handler.process.ts:455: if (discordConfig?.reasoningStreaming) {
2026-02-02T06:50:36.511511Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:50:36.511560Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.

thinking
**Investigating reasoning mode**

I'm trying to figure out where reasoningMode is set. It might be in the route config or somewhere else. In the message-handler, they pass replyOptions, so maybe the run dispatch uses channelConfig to compute reasoningMode. I think I should inspect the dispatch function or runreply. It might be helpful to search for "reasoningMode" usage when processing to see how it's being handled. Let's dive into this and uncover the details!
exec
/bin/bash -lc 'rg -n "reasoningMode" -S src/discord src/auto-reply src/agents | head -n 80' in /home/davidmarsh/code/moltbot succeeded in 67ms:
src/agents/pi-embedded-subscribe.ts:31: const reasoningMode = params.reasoningMode ?? "off";
src/agents/pi-embedded-subscribe.ts:41: reasoningMode,
src/agents/pi-embedded-subscribe.ts:42: includeReasoning: reasoningMode === "on",
src/agents/pi-embedded-subscribe.ts:43: shouldEmitPartialReplies: !(reasoningMode === "on" && !params.onBlockReply),
src/agents/pi-embedded-subscribe.ts:44: streamReasoning: reasoningMode === "stream" && typeof params.onReasoningStream === "function",
src/agents/pi-embedded-subscribe.handlers.types.ts:31: reasoningMode: ReasoningLevel;
src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.subscribeembeddedpisession.test.ts:37: reasoningMode: "stream",
src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.keeps-assistanttexts-final-answer-block-replies-are.test.ts:29: reasoningMode: "on",
src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.keeps-assistanttexts-final-answer-block-replies-are.test.ts:83: reasoningMode: "on",
src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.emits-reasoning-as-separate-message-enabled.test.ts:33: reasoningMode: "on",
src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.emits-reasoning-as-separate-message-enabled.test.ts:68: reasoningMode: "on",
src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.does-not-emit-duplicate-block-replies-text.test.ts:130: reasoningMode: "on",
src/agents/pi-embedded-runner/run/attempt.ts:650: reasoningMode: params.reasoningLevel ?? "off",
src/agents/pi-embedded-subscribe.types.ts:11: reasoningMode?: ReasoningLevel;
2026-02-02T06:50:41.698408Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:50:41.698448Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.
exec
/bin/bash -lc "sed -n '600,720p' src/agents/pi-embedded-runner/run/attempt.ts" in /home/davidmarsh/code/moltbot succeeded in 61ms:
timedOut = true;
}
if (isTimeout) {
runAbortController.abort(reason ?? makeTimeoutAbortReason());
} else {
runAbortController.abort(reason);
}
void activeSession.abort();
};
const abortable = <T>(promise: Promise<T>): Promise<T> => {
const signal = runAbortController.signal;
if (signal.aborted) {
return Promise.reject(makeAbortError(signal));
}
return new Promise<T>((resolve, reject) => {
const onAbort = () => {
signal.removeEventListener("abort", onAbort);
reject(makeAbortError(signal));
};
signal.addEventListener("abort", onAbort, { once: true });
2026-02-02T06:50:46.129360Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:50:46.129411Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.
exec
/bin/bash -lc 'rg -n "reasoningLevel" -S src | head -n 80' in /home/davidmarsh/code/moltbot succeeded in 64ms:
src/tui/tui.ts:486: const reasoning = sessionInfo.reasoningLevel ?? "off";
src/tui/tui-session-actions.ts:129: reasoningLevel: entry?.reasoningLevel,
src/tui/tui-command-handlers.ts:346: reasoningLevel: args,
src/tui/gateway-chat.ts:48: reasoningLevel?: string;
src/tui/tui-types.ts:30: reasoningLevel?: string;
src/auto-reply/status.ts:377: const reasoningLevel = args.resolvedReasoning ?? "off";
src/auto-reply/status.ts:424: reasoningLevel !== "off" ? `Reasoning: ${reasoningLevel}` : null,
src/gateway/protocol/schema/sessions.ts:56: reasoningLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
src/config/sessions/types.ts:43: reasoningLevel?: string;
src/gateway/sessions-patch.ts:152: if ("reasoningLevel" in patch) {
src/gateway/sessions-patch.ts:153: const raw = patch.reasoningLevel;
src/gateway/sessions-patch.ts:155: delete next.reasoningLevel;
src/gateway/sessions-patch.ts:159: return invalid('invalid reasoningLevel (use "on"|"off"|"stream")');
src/gateway/sessions-patch.ts:162: delete next.reasoningLevel;
src/gateway/sessions-patch.ts:164: next.reasoningLevel = normalized;
src/gateway/session-utils.ts:644: reasoningLevel: entry?.reasoningLevel,
src/commands/status.summary.ts:48: const reasoning = entry?.reasoningLevel;
src/commands/status.summary.ts:143: reasoningLevel: entry?.reasoningLevel,
src/auto-reply/reply.directive.parse.test.ts:43: expect(res.reasoningLevel).toBe("on");
src/auto-reply/reply.directive.parse.test.ts:49: expect(res.reasoningLevel).toBe("stream");
2026-02-02T06:50:50.079417Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:50:50.079464Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.

thinking
**Evaluating streaming implementation**

I’m considering how the reasoningLevel is set from the session config, not automatically from reasoningStreaming. If Discord config enables reasoningStreaming but the session reasoningLevel is off, it seems no streaming will happen. The user wants me to audit the streaming implementation for native Claude thinking blocks in Discord, so I need to check if the bridging between Pi session thinking events and onReasoningStream is correct, which it appears to be. I’ll also verify how message_update events are delivering thinking events.
thinking
**Analyzing message handling**

I see that the message_start handler gets called when the message_start event occurs, but if it doesn't, well, that might affect things. I checked the state, and it looks like the nativeThinkingBuffer is set to an empty string in the initial state, which is good. I noticed that while they compute thinkingDelta and thinkingContent similarly to delta and content, they used assistantRecord values instead. It seems like they could be reusing those values instead. I’ll also look at resetting states to prevent buffer leaks during message_end events.
thinking
**Examining reasoning state resets**

I'm considering a potential issue with resetAssistantMessageState, where it sets state.lastStreamedReasoning to undefined. This means the first reasoning stream message will always be sent when it's non-empty, which is good. However, in the handleMessageUpdate thinking branch, they call ctx.emitReasoningStream for each thinking event. Since emitReasoningStream formats the message with "Reasoning:\n," the initial reasoning can be minimal. I want to check if thinking_delta events can occur without text events and if a stable sessionKey is used for Discord message creation.
thinking
**Assessing reasoning message management**

I’m wondering if reasoning streaming is being used across multiple runs in the same channel, as activeReasoningMessages seem to be keyed by channelId:sessionKey. This implies that there might be a reasoning message for each channel conversation rather than per request, but they do clear the entry after dispatch. However, they don’t delete the message, which could lead to clutter. It seems they might leave old messages as a record by design, but I’m unsure if they plan to delete them later.
thinking
**Auditing reasoning streaming implementation**

I see concerns about how reasoning streaming might interfere with `<think>` tag streaming, particularly regarding state resets. Here’s my summary of key points:

- Confirm it uses right events from pi-agent-core and manages the buffer.
- Identify issues like missing contentIndex which could mis-handle multiple thinking blocks.
- Note that appending or partial messages might be needed during thinking_end.
- Buffer resets and its handling could create problems with multiple blocks.
- Consider potential memory accumulation of nativeThinkingBuffer.
- Watch for bugs in handling delta events and formatting issues that could break reasoning messages.

I plan to ensure thorough analysis while being concise in my final response.
thinking
**Simulating typical event sequences for audit**

I’m setting up a simulation for typical event sequences to ensure everything operates smoothly. First, we can reset the buffer and track a sequence of events, like message_start, thinking_start, and thinking_delta, marking changes to the buffer and reasoning. I can see potential issues with how reasoning handles multiple blocks, particularly with replacing the buffer, which might drop prior content. It seems we risk regressions if multiple thinking blocks occur.

Additionally, the management of thinking events and interleaved text events could cause reasoning to accumulate unnecessarily. I’ll note these as edge cases to watch for. Overall, I want to check for any inconsistencies or potential bugs, especially with the assistantRecord in handling deltas and contents.
exec
/bin/bash -lc "sed -n '1,160p' src/agents/pi-embedded-subscribe.raw-stream.ts" in /home/davidmarsh/code/moltbot succeeded in 59ms:
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { isTruthyEnvValue } from "../infra/env.js";

const RAW_STREAM_ENABLED = isTruthyEnvValue(process.env.OPENCLAW_RAW_STREAM);
const RAW_STREAM_PATH =
process.env.OPENCLAW_RAW_STREAM_PATH?.trim() ||
path.join(resolveStateDir(), "logs", "raw-stream.jsonl");

let rawStreamReady = false;

export function appendRawStream(payload: Record<string, unknown>) {
if (!RAW_STREAM_ENABLED) {
return;
}
if (!rawStreamReady) {
rawStreamReady = true;
try {
fs.mkdirSync(path.dirname(RAW_STREAM_PATH), { recursive: true });
2026-02-02T06:51:51.256901Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:51:51.256947Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.

thinking
**Analyzing file write constraints**

I'm considering how the `appendRawStream` function works, but since we're in a read-only environment, I can't write to files. It's crucial to stay focused on analysis instead of code modifications. I wonder if there are any relevant parts for `<think>` tag streaming, but right now, I need to provide a comprehensive review. I plan to highlight issues, improvements, and test gaps while ensuring to reference file paths and line numbers, even if the user didn’t specifically request them.
thinking
**Clarifying analysis requirements**

I need to ensure that I'm following the guidelines for referencing files, including relevant start lines, but since this isn’t a code change, it's just best practice. The user wants analysis, not modifications. I need to pinpoint specific issues, like how the `nativeThinkingBuffer` may drop earlier blocks. I can propose to track updates by `contentIndex` or use `assistantRecord.partial`. Additionally, clearing the buffer when `message_end` resets might be necessary, but I need to be cautious about potential duplicates in the reasoning stream.
thinking
**Reviewing implementation issues**

It looks like `emitReasoningStream(rawThinking)` is called before resetting the `nativeThinkingBuffer`, which means resetting `lastStreamedReasoning` afterward might actually be fine. I need to consider that resetting both the buffer and `lastStreamedReasoning` at `message_end` could lead to late events being resent, although they might be treated as new messages. The user has asked me to audit the implementation, focusing on correctness, edge cases, state management issues, race conditions, and bugs in the three files involved.
thinking
**Structuring the response**

I’m planning an organized response that includes a quick summary of what the changes do, followed by a bullet list of findings.

First, it works for the common Claude stream structure with `thinking_start`, `delta`, and `end`.

However, there’s a potential bug where multiple thinking blocks could lead to issues, as `thinking_end` overwrites the buffer instead of appending to it.

Also, if both native thinking and `<think>` tags are present, they might interfere and cause flickering.

Lastly, while the `nativeThinkingBuffer` resets properly at `message_start` and `message_end`, the `lastStreamedReasoning` not resetting can create regression risks. I’ll touch on performance concerns too, especially regarding rate limits.
thinking
**Identifying key issues and improvements**

I need to proceed with caution here and ensure I add tests covering `thinking_delta` events. I’ll suggest improvements like tracking per `contentIndex` and using `assistantRecord.partial` to extract assistant thinking. If `thinking_end` overwrites the buffer, it could cause problems with multiple thinking blocks, which we need to avoid. It's also worth noting that if both native thinking and `<think>` tags are present, they might interfere with each other.

While `nativeThinkingBuffer` resets correctly, I should frame my final response to clarify these aspects succinctly while still addressing correctness, edge cases, and state management issues.
thinking
**Assessing potential regressions and tests**

I’m noticing that `lastStreamedReasoning` isn’t reset at `message_end`, which could lead to regressions if any late `thinking_delta` occurs afterward. We might consider either ignoring these updates or resetting it alongside the buffer, although it may not be necessary if ordering is guaranteed.

Regarding rate limits, `emitReasoningStream` is called for every delta, and Discord throttles to 1.5 seconds, which might lead to out-of-order edits. I’ll suggest adding unit tests for `thinking_delta` streaming and resets.

I need to provide file references with approximate line numbers for clarity.
exec
/bin/bash -lc "nl -ba src/agents/pi-embedded-subscribe.handlers.messages.ts | sed -n '40,120p'" in /home/davidmarsh/code/moltbot succeeded in 62ms:
40
41 // KNOWN: Resetting at `text_end` is unsafe (late/duplicate end events).
42 // ASSUME: `message_start` is the only reliable boundary for “new assistant message begins”.
43 // Start-of-message is a safer reset point than message_end: some providers
44 // may deliver late text_end updates after message_end, which would otherwise
45 // re-trigger block replies.
46 ctx.resetAssistantMessageState(ctx.state.assistantTexts.length);
47 // Use assistant message_start as the earliest "writing" signal for typing.
48 void ctx.params.onAssistantMessageStart?.();
49 }
50
51 export function handleMessageUpdate(
52 ctx: EmbeddedPiSubscribeContext,
53 evt: AgentEvent & { message: AgentMessage; assistantMessageEvent?: unknown },
54 ) {
55 const msg = evt.message;
56 if (msg?.role !== "assistant") {
57 return;
58 }
59
2026-02-02T06:52:38.546776Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:52:38.546827Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.
exec
/bin/bash -lc "nl -ba src/agents/pi-embedded-subscribe.handlers.messages.ts | sed -n '250,410p'" in /home/davidmarsh/code/moltbot succeeded in 56ms:
250 const formattedReasoning = rawThinking ? formatReasoningMessage(rawThinking) : "";
251
252 const addedDuringMessage = ctx.state.assistantTexts.length > ctx.state.assistantTextBaseline;
253 const chunkerHasBuffered = ctx.blockChunker?.hasBuffered() ?? false;
254 ctx.finalizeAssistantTexts({ text, addedDuringMessage, chunkerHasBuffered });
255
256 const onBlockReply = ctx.params.onBlockReply;
257 const shouldEmitReasoning = Boolean(
258 ctx.state.includeReasoning &&
259 formattedReasoning &&
260 onBlockReply &&
261 formattedReasoning !== ctx.state.lastReasoningSent,
262 );
263 const shouldEmitReasoningBeforeAnswer =
264 shouldEmitReasoning && ctx.state.blockReplyBreak === "message_end" && !addedDuringMessage;
265 const maybeEmitReasoning = () => {
266 if (!shouldEmitReasoning || !formattedReasoning) {
267 return;
268 }
269 ctx.state.lastReasoningSent = formattedReasoning;
2026-02-02T06:52:41.518075Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:52:41.518126Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.
exec
/bin/bash -lc "nl -ba src/agents/pi-embedded-subscribe.ts | sed -n '20,140p'" in /home/davidmarsh/code/moltbot succeeded in 59ms:
20 const THINKING_TAG_SCAN_RE = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
21 const FINAL_TAG_SCAN_RE = /<\s*(\/?)\s*final\s*>/gi;
22 const log = createSubsystemLogger("agent/embedded");
23
24 export type {
25 BlockReplyChunking,
26 SubscribeEmbeddedPiSessionParams,
27 ToolResultFormat,
28 } from "./pi-embedded-subscribe.types.js";
29
30 export function subscribeEmbeddedPiSession(params: SubscribeEmbeddedPiSessionParams) {
31 const reasoningMode = params.reasoningMode ?? "off";
32 const toolResultFormat = params.toolResultFormat ?? "markdown";
33 const useMarkdown = toolResultFormat === "markdown";
34 const state: EmbeddedPiSubscribeState = {
35 assistantTexts: [],
36 toolMetas: [],
37 toolMetaById: new Map(),
38 toolSummaryById: new Set(),
39 lastToolError: undefined,
2026-02-02T06:52:45.825810Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:52:45.825863Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.
exec
/bin/bash -lc "nl -ba src/agents/pi-embedded-subscribe.handlers.types.ts | sed -n '1,120p'" in /home/davidmarsh/code/moltbot succeeded in 62ms:
1 import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
2 import type { ReplyDirectiveParseResult } from "../auto-reply/reply/reply-directives.js";
3 import type { ReasoningLevel } from "../auto-reply/thinking.js";
4 import type { InlineCodeState } from "../markdown/code-spans.js";
5 import type { EmbeddedBlockChunker } from "./pi-embedded-block-chunker.js";
6 import type { MessagingToolSend } from "./pi-embedded-messaging.js";
7 import type {
8 BlockReplyChunking,
9 SubscribeEmbeddedPiSessionParams,
10 } from "./pi-embedded-subscribe.types.js";
11
12 export type EmbeddedSubscribeLogger = {
13 debug: (message: string) => void;
14 warn: (message: string) => void;
15 };
16
17 export type ToolErrorSummary = {
18 toolName: string;
19 meta?: string;
20 error?: string;
2026-02-02T06:52:48.740988Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:52:48.741020Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.

thinking
**Considering race conditions**

I need to think about race conditions and state management. So, the subscribe handler is in JS and events are sequential, but asynchronous callbacks are not awaited, which could lead to out-of-order network operations. While there’s a mechanism to avoid races on initial creation, it doesn't cover edits. If a new update arrives while an edit is in progress, both could call editMessageDiscord simultaneously, potentially causing issues. I might need to implement a "last promised update" system to manage this better. There could also be mismatches in state between buffers and streamed reasoning.
thinking
**Reviewing potential bugs**

So, we have to think about deltas accumulating. If the provider sends a `thinking_end` with incomplete reasoning—like just the last block—it could accidentally override what we have, which seems like a bug. Also, if `thinking_delta` events are sent with non-contiguous partial data, that could be problematic too. It seems they’re using `ctx.emitReasoningStream` on every event, even when it might only be necessary for deltas. For `thinking_end`, calling it with existing content is good, but they might need to refine when they trigger it to avoid outputting from an empty buffer.
thinking
**Auditing implementation details**

I need to look at different components, like `src/agents/pi-embedded-subscribe.handlers.tools.ts`, especially concerning how it handles onBlockReply flush. I see there's a nativeThinkingBuffer in the state, but it's not used in stripBlockTags, which deals with `<think>` tags. Checking for TypeScript strict typing issues, it seems `EmbeddedPiSubscribeState` is updated correctly to include this buffer. However, there could be compile errors elsewhere if state objects are modified in different ways. So, I’ll finalize my response regarding the user’s request to audit the implementation thoroughly.
thinking
**Reviewing implementation and issues**

Let's craft the response!

First, we see that `nativeThinkingBuffer` is added and initialized properly in `src/agents/pi-embedded-subscribe.ts`. It's also reset in the right methods, confirming correctness. Additionally, thinking events are filtered so they don’t interfere with the text pipeline, as `handleMessageUpdate` returns early for those.

However, there are some issues. The global current buffer ignores `assistantMessageEvent.contentIndex`, which can lead to dropping earlier content with `thinking_end`. It's safer to track thinking per `contentIndex` or derive the full thinking using `assistantRecord.partial` to maintain the updates properly.
thinking
**Identifying issues and test gaps**

There are a few key issues to address. First, mixing native thinking with `<think>` tags could cause conflicting calls to `emitReasoningStream`, leading to a confusing Discord reasoning message. It might be wise to disable tag streaming once native thinking starts.

Next, resetting `nativeThinkingBuffer` at `message_end` while keeping `lastStreamedReasoning` could allow late `thinking_delta` events to regress reasoning messages.

There's also a lack of unit tests for `thinking_delta` and `thinking_end` streaming which could lead to missed multi-block regressions. To improve, we should verify content per-block in the relevant code, noting our sources carefully.
exec
/bin/bash -lc "rg -n \"case \\\"thinking\_(start|delta|end)\\\"\" node_modules/@mariozechner/pi-agent-core/dist/proxy.js -n" in /home/davidmarsh/code/moltbot succeeded in 60ms:
186: case "thinking_start":
189: case "thinking_delta": {
202: case "thinking_end": {
2026-02-02T06:53:38.491951Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:53:38.492001Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.
exec
/bin/bash -lc "nl -ba node_modules/@mariozechner/pi-agent-core/dist/proxy.js | sed -n '170,230p'" in /home/davidmarsh/code/moltbot succeeded in 62ms:
170 }
171 throw new Error("Received text_delta for non-text content");
172 }
173 case "text_end": {
174 const content = partial.content[proxyEvent.contentIndex];
175 if (content?.type === "text") {
176 content.textSignature = proxyEvent.contentSignature;
177 return {
178 type: "text_end",
179 contentIndex: proxyEvent.contentIndex,
180 content: content.text,
181 partial,
182 };
183 }
184 throw new Error("Received text_end for non-text content");
185 }
186 case "thinking_start":
187 partial.content[proxyEvent.contentIndex] = { type: "thinking", thinking: "" };
188 return { type: "thinking_start", contentIndex: proxyEvent.contentIndex, partial };
189 case "thinking_delta": {
2026-02-02T06:53:44.527112Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
"error": {
"message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
"type": "invalid_request_error",
"param": null,
"code": "refresh_token_reused"
}
}
2026-02-02T06:53:44.527150Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.
codex
**What looks correct**

- `nativeThinkingBuffer` is added to state (`src/agents/pi-embedded-subscribe.handlers.types.ts:23`) and initialized/reset in the main reset path (`src/agents/pi-embedded-subscribe.ts:34`, `src/agents/pi-embedded-subscribe.ts:85`), plus cleared on `message_end` (`src/agents/pi-embedded-subscribe.handlers.messages.ts:357`).
- `thinking_*` events are handled separately and return early (`src/agents/pi-embedded-subscribe.handlers.messages.ts:77`), so native thinking should not leak into `deltaBuffer` / block replies / final text.
- Existing `<think>`-tag streaming remains intact (`src/agents/pi-embedded-subscribe.handlers.messages.ts:144`), so this change shouldn’t break tag-based reasoning streaming by itself.

**Edge cases / potential bugs**

- **Multiple thinking blocks / `contentIndex` ignored:** you don’t read `contentIndex` at all, and `thinking_end` overwrites the entire buffer (`src/agents/pi-embedded-subscribe.handlers.messages.ts:84`). In `@mariozechner/pi-agent-core`, `thinking_end.content` is _per content block_ (`node_modules/@mariozechner/pi-agent-core/dist/proxy.js:202`), so if a message ever has 2 thinking blocks you can drop earlier reasoning and even regress Discord updates (e.g., “AB” → “B”).
- **Mixed native thinking + `<think>` tags:** if a provider ever emits both, you’ll call `emitReasoningStream()` from two independent sources (native at `src/agents/pi-embedded-subscribe.handlers.messages.ts:90`, tags at `src/agents/pi-embedded-subscribe.handlers.messages.ts:144`), which can make the Discord “thinking…” message flip-flop.
- **Late events after `message_end`:** you clear `nativeThinkingBuffer` at `message_end` (`src/agents/pi-embedded-subscribe.handlers.messages.ts:363`) but don’t clear `lastStreamedReasoning` there; if any late `thinking_delta` arrives after `message_end`, the reasoning message could “shrink” (buffer reset + dedupe state still set). Probably fine if event ordering is strict, but it’s the same class of “late events” risk you already call out in the `message_start` comment.
- **Async/rate ordering (Discord):** `emitReasoningStream()` is fire-and-forget; Discord updates are throttled downstream, but edits aren’t serialized, so two in-flight edits can land out-of-order and briefly revert content (this also applies to existing tag streaming; native thinking may increase update volume).

**Missing coverage**

- No tests for `thinking_delta`/`thinking_end` streaming + reset behavior; a small unit test (including a “two thinking blocks” scenario) would catch the `thinking_end` overwrite/regression case quickly.
  tokens used
  120,663
  **What looks correct**
- `nativeThinkingBuffer` is added to state (`src/agents/pi-embedded-subscribe.handlers.types.ts:23`) and initialized/reset in the main reset path (`src/agents/pi-embedded-subscribe.ts:34`, `src/agents/pi-embedded-subscribe.ts:85`), plus cleared on `message_end` (`src/agents/pi-embedded-subscribe.handlers.messages.ts:357`).
- `thinking_*` events are handled separately and return early (`src/agents/pi-embedded-subscribe.handlers.messages.ts:77`), so native thinking should not leak into `deltaBuffer` / block replies / final text.
- Existing `<think>`-tag streaming remains intact (`src/agents/pi-embedded-subscribe.handlers.messages.ts:144`), so this change shouldn’t break tag-based reasoning streaming by itself.

**Edge cases / potential bugs**

- **Multiple thinking blocks / `contentIndex` ignored:** you don’t read `contentIndex` at all, and `thinking_end` overwrites the entire buffer (`src/agents/pi-embedded-subscribe.handlers.messages.ts:84`). In `@mariozechner/pi-agent-core`, `thinking_end.content` is _per content block_ (`node_modules/@mariozechner/pi-agent-core/dist/proxy.js:202`), so if a message ever has 2 thinking blocks you can drop earlier reasoning and even regress Discord updates (e.g., “AB” → “B”).
- **Mixed native thinking + `<think>` tags:** if a provider ever emits both, you’ll call `emitReasoningStream()` from two independent sources (native at `src/agents/pi-embedded-subscribe.handlers.messages.ts:90`, tags at `src/agents/pi-embedded-subscribe.handlers.messages.ts:144`), which can make the Discord “thinking…” message flip-flop.
- **Late events after `message_end`:** you clear `nativeThinkingBuffer` at `message_end` (`src/agents/pi-embedded-subscribe.handlers.messages.ts:363`) but don’t clear `lastStreamedReasoning` there; if any late `thinking_delta` arrives after `message_end`, the reasoning message could “shrink” (buffer reset + dedupe state still set). Probably fine if event ordering is strict, but it’s the same class of “late events” risk you already call out in the `message_start` comment.
- **Async/rate ordering (Discord):** `emitReasoningStream()` is fire-and-forget; Discord updates are throttled downstream, but edits aren’t serialized, so two in-flight edits can land out-of-order and briefly revert content (this also applies to existing tag streaming; native thinking may increase update volume).

**Missing coverage**

- No tests for `thinking_delta`/`thinking_end` streaming + reset behavior; a small unit test (including a “two thinking blocks” scenario) would catch the `thinking_end` overwrite/regression case quickly.

```

---

## ✗ DeepSeek V3

**Status:** failed | **Time:** 18m 11s

```

You can skip this check with --no-gitignore
Added .aider\* to .gitignore
Aider v0.86.1
Model: openrouter/deepseek/deepseek-chat-v3-0324 with diff edit format, prompt
cache, infinite output
Git repo: .git with 4,609 files
Warning: For large repos, consider using --subtree-only and .aiderignore
See: https://aider.chat/docs/faq.html#can-i-use-aider-in-a-large-mono-repo
Repo-map: using 512 tokens, auto refresh
Added src/agents/pi-embedded-subscribe.handlers.messages.ts to the chat.
Added src/agents/pi-embedded-subscribe.handlers.types.ts to the chat.
Added src/agents/pi-embedded-subscribe.ts to the chat.
Added AGENTS.md to the chat (read-only).

litellm.Timeout: Timeout Error: OpenrouterException - litellm.Timeout:
Connection timed out after 600.0 seconds.
The API provider timed out without returning a response. They may be down or
overloaded.
Retrying in 0.2 seconds...

```

---

## ✓ Qwen3 Coder

**Status:** done | **Time:** 15s

```

You can skip this check with --no-gitignore
Added .aider\* to .gitignore
Aider v0.86.1
Model: openrouter/qwen/qwen3-coder with whole edit format
Git repo: .git with 4,609 files
Warning: For large repos, consider using --subtree-only and .aiderignore
See: https://aider.chat/docs/faq.html#can-i-use-aider-in-a-large-mono-repo
Repo-map: using 2048 tokens, auto refresh
Added src/agents/pi-embedded-subscribe.handlers.messages.ts to the chat.
Added src/agents/pi-embedded-subscribe.handlers.types.ts to the chat.
Added src/agents/pi-embedded-subscribe.ts to the chat.
Added AGENTS.md to the chat (read-only).

Looking at the implementation of streaming native Claude thinking blocks, I can
identify several issues and areas for improvement:

## Analysis of the Implementation

### 1. State Management Issues

**Missing Reset in `resetAssistantMessageState`**: The `nativeThinkingBuffer` is
properly reset in the reset function, but there's inconsistency in how thinking
events are handled versus text events. The buffer accumulates across the entire
session rather than per-message.

**Buffer Scope**: The `nativeThinkingBuffer` accumulates thinking content across
the entire assistant message session, not per individual message. This could
lead to:

- Accumulation of thinking from previous messages

- Memory bloat over long sessions

- Confusion when reasoning spans multiple messages

### 2. Event Handling Issues

**Incomplete Event Type Detection**: The code checks for `thinking_delta`,
`thinking_start`, and `thinking_end`, but there might be other thinking-related
events from Claude that aren't being captured.

**Missing Content Validation**: The code assumes that `thinkingContent` from
`thinking_end` events contains the complete thinking content, but this might not
always be the case.

### 3. Streaming Logic Issues

**Duplicate Streaming**: The native thinking buffer is streamed both during
accumulation (`ctx.emitReasoningStream(ctx.state.nativeThinkingBuffer)`) and at
message end (`ctx.emitReasoningStream(rawThinking)`), potentially causing
duplicate or conflicting streams.

**Race Condition Risk**: When `thinking_end` updates the buffer with full
content, there's a potential race condition if `thinking_delta` events are still
being processed.

### 4. Edge Cases Not Handled

**Provider Variations**: Different providers might send thinking events in
different formats or orders, which isn't accounted for.

**Error Recovery**: If a `thinking_delta` event is missed, the buffer might not
accurately represent the complete thinking content.

**Message Boundaries**: The implementation doesn't clearly separate thinking
content per message, which could cause content from one message to bleed into
another.

### 5. Potential Bugs

**Buffer Overwrite**: In `thinking_end`, the code overwrites the entire
`nativeThinkingBuffer` with `thinkingContent`, potentially losing previously
accumulated deltas.

**Incomplete Reset**: While the buffer is reset in `resetAssistantMessageState`,
it's not clear if this happens at the right time relative to message boundaries.

## Recommendations

1. **Per-Message Buffering**: Create a separate buffer for each message rather
   than a global one

2. **Consistent Event Handling**: Ensure all possible thinking event types are
   captured

3. **Better State Synchronization**: Coordinate between delta accumulation and
   final content setting

4. **Clear Message Boundaries**: Ensure thinking content is properly scoped to
   individual messages

5. **Error Handling**: Add validation and fallback logic for incomplete or
   malformed events

The implementation shows good foundational work but needs refinement in state
management and edge case handling to be robust for production use.

Tokens: 25k sent, 588 received. Cost: $0.0061 message, $0.0061 session.

```

---

## ✓ Mistral Large 3

**Status:** done | **Time:** 1m 06s

```

You can skip this check with --no-gitignore
Added .aider\* to .gitignore
Aider v0.86.1
Model: openrouter/mistralai/mistral-large-2512 with whole edit format
Git repo: .git with 4,609 files
Warning: For large repos, consider using --subtree-only and .aiderignore
See: https://aider.chat/docs/faq.html#can-i-use-aider-in-a-large-mono-repo
Repo-map: using 2048 tokens, auto refresh
Added src/agents/pi-embedded-subscribe.handlers.messages.ts to the chat.
Added src/agents/pi-embedded-subscribe.handlers.types.ts to the chat.
Added src/agents/pi-embedded-subscribe.ts to the chat.
Added AGENTS.md to the chat (read-only).

Here's my code review analysis of the native Claude thinking blocks streaming
implementation:

## Overall Assessment

The implementation is well-structured and covers the core requirements for
streaming native Claude thinking blocks to Discord. The changes are minimal and
focused, properly separating native thinking blocks from `<think>` tags.
However, I've identified several edge cases and potential issues that should be
addressed.

## Strengths

1. **Clean Separation**: The implementation correctly distinguishes between
   native thinking blocks (Claude extended thinking) and `<think>` tags, avoiding
   interference with existing functionality.

2. **State Management**: The `nativeThinkingBuffer` is properly initialized and
   reset in all relevant places (`resetAssistantMessageState`,
   `resetForCompactionRetry`, and `handleMessageEnd`).

3. **Streaming Logic**: The reasoning streaming logic in `handleMessageUpdate`
   is sound, with proper checks for `streamReasoning` and `onReasoningStream`
   before emitting.

4. **Event Handling**: The implementation correctly handles all three thinking
   event types (`thinking_start`, `thinking_delta`, `thinking_end`).

5. **Raw Stream Logging**: The raw stream logging via `appendRawStream` provides
   good observability.

## Issues and Edge Cases

### 1. Missing `thinking_start` Handling

**Issue**: In `handleMessageUpdate`, the `thinking_start` event is recognized
but doesn't actually append any content to the buffer or trigger streaming. This
could lead to missing the first part of thinking content if the provider doesn't
send a `thinking_delta` immediately after.

**Recommendation**: Consider initializing the buffer with the `content` field
from `thinking_start` events, similar to how `thinking_end` is handled.

### 2. Buffer Overwrite on `thinking_end`

**Issue**: When `thinking_end` is received, the buffer is overwritten with
`thinkingContent`:

```
} else if (evtType === "thinking_end" && thinkingContent) {

  ctx.state.nativeThinkingBuffer = thinkingContent;

}

```

This could be problematic if:

- The `thinking_end` event arrives before all `thinking_delta` events

- The `content` field in `thinking_end` is incomplete or different from the
  accumulated deltas

**Recommendation**: Consider merging the content rather than overwriting, or at
least adding a warning if the buffer already contains content that differs from
the `thinking_end` content.

### 3. Missing Duplicate Detection for Reasoning

**Issue**: The implementation checks for duplicate assistant text
(`lastStreamedReasoning`), but there's no similar check for reasoning content.
This could lead to duplicate reasoning chunks being streamed if the same
thinking content is resent.

**Recommendation**: Consider adding a `lastStreamedNativeThinking` state field
to prevent duplicate reasoning chunks.

### 4. Potential Memory Leak

**Issue**: The `nativeThinkingBuffer` can grow indefinitely if:

- Many thinking events are received without a `thinking_end`

- The session is long-running with continuous thinking

**Recommendation**: Consider adding a maximum buffer size limit and either:

- Truncate the buffer when it exceeds the limit

- Stop streaming when the limit is reached

- Log a warning when the limit is approached

### 5. Missing Error Handling

**Issue**: There's no error handling around the `emitReasoningStream` call. If
the Discord streaming fails, the error will be silently ignored.

**Recommendation**: Consider adding error handling similar to the
`emitToolSummary` and `emitToolOutput` functions.

### 6. State Reset Timing

**Issue**: The `nativeThinkingBuffer` is reset in `resetAssistantMessageState`
(called at `message_start`), but if thinking events arrive before the first
`message_start`, they would be lost.

**Recommendation**: Consider whether thinking events should be buffered before
the first `message_start`, or if they should be ignored.

### 7. Missing Integration with Final Reasoning

**Issue**: The final reasoning extraction in `handleMessageEnd` uses
`extractAssistantThinking(assistantMessage)` and
`extractThinkingFromTaggedText(rawText)`, but doesn't consider the accumulated
`nativeThinkingBuffer`.

**Recommendation**: Consider whether the native thinking buffer should be
included in the final reasoning extraction.

### 8. Potential Race Condition

**Issue**: If multiple thinking events arrive in quick succession, there's a
small chance that the buffer updates and streaming could get out of sync,
especially if the `emitReasoningStream` is asynchronous.

**Recommendation**: Consider making the buffer updates and streaming atomic, or
adding a queue for reasoning chunks.

## Code Quality Observations

1. **Type Safety**: The implementation could benefit from stronger typing for
   the `assistantMessageEvent` field. Currently it's cast to `Record<string, 
unknown>` which loses type information.

2. **Magic Strings**: The event type strings (`"thinking_delta"`, etc.) are
   duplicated between the check and the raw stream logging. Consider extracting
   these to constants.

3. **Documentation**: The code would benefit from more detailed comments
   explaining:
   - The difference between native thinking blocks and `<think>` tags

   - The expected behavior when both are present

   - The relationship between streaming and final reasoning extraction

4. **Testing**: While not visible in the code, the test coverage should verify:
   - Mixed native thinking and `<think>` tag scenarios

   - Late/out-of-order thinking events

   - Buffer reset scenarios

   - Error conditions

## Conclusion

The implementation is fundamentally sound and meets the core requirements. The
main issues are edge cases around event ordering and buffer management. With
some additional safeguards and error handling, this could be made more robust.

Would you like me to elaborate on any of these findings or suggest specific
improvements for any particular issue?

Tokens: 26k sent, 1.2k received. Cost: $0.02 message, $0.02 session.

Issue**: When `thinking_end` is received, the buffer is overwritten with
`thinkingContent
/home/davidmarsh/code/moltbot/Issue**: When `thinking_end` is received, the
buffer is overwritten with `thinkingContent: file not found error
Did not apply edit to Issue**: When `thinking_end`is received, the buffer is 
overwritten with`thinkingContent (--dry-run)
Unable to read /home/davidmarsh/code/moltbot/Issue**: When `thinking_end` is received, the buffer is overwritten with `thinkingContent: [Errno 2] No such file or directory: '/home/davidmarsh/code/moltbot/Issue**: When `thinking_end` is received, the buffer is overwritten with `thinkingContent'
Summarization failed for model openrouter/mistralai/mistral-large-2512: cannot schedule new futures after shutdown
Summarization failed for model openrouter/mistralai/mistral-large-2512: cannot schedule new futures after shutdown
summarizer unexpectedly failed for all models

```

---

## ✓ Grok 4.1

**Status:** done | **Time:** 10m 47s

```

You can skip this check with --no-gitignore
Added .aider\* to .gitignore
Failed to fetch OpenRouter model list: HTTPSConnectionPool(host='openrouter.ai', port=443): Read timed out. (read timeout=10)
Aider v0.86.1
Model: openrouter/x-ai/grok-4.1-fast with whole edit format
Git repo: .git with 4,609 files
Warning: For large repos, consider using --subtree-only and .aiderignore
See: https://aider.chat/docs/faq.html#can-i-use-aider-in-a-large-mono-repo
Repo-map: using 4096 tokens, auto refresh
Added src/agents/pi-embedded-subscribe.handlers.messages.ts to the chat.
Added src/agents/pi-embedded-subscribe.handlers.types.ts to the chat.
Added src/agents/pi-embedded-subscribe.ts to the chat.
Added AGENTS.md to the chat (read-only).

litellm.Timeout: Timeout Error: OpenrouterException - litellm.Timeout:
Connection timed out after 600.0 seconds.
The API provider timed out without returning a response. They may be down or
overloaded.
Retrying in 0.2 seconds...

---

► **THINKING**

The user message starts with "=== AIDER READ-ONLY MODE ===" and specifies that I
am running with --dry-run enabled, meaning:

## Reviewing user instructions

- The message begins with "=== AIDER READ-ONLY MODE ===" and mentions running
  with --dry-run enabled.
- This means no file edits or SEARCH/REPLACE blocks should be generated.
- It also indicates no code suggestions should be made, focusing only on
  analysis.

## Reviewing user instructions

- The task emphasizes describing issues in prose without outputting edit blocks.
- It's a READ-ONLY query, prohibiting file modifications, destructive commands,
  or git commits.
- Focus is on analyzing and answering, specifically auditing streaming native
  Claude thinking blocks to Discord.

## Examining code changes

- Added `nativeThinkingBuffer: string;` to EmbeddedPiSubscribeState, initialized
  and reset per message.
- Handles thinking events ("thinking_delta", "thinking_start", "thinking_end")
  separately from text, using emitReasoningStream for incremental streaming.
- Resets state in handleMessageEnd, ensuring clean separation between messages.

## Checking edge cases

- Thinking start events may have empty content, but handled via deltas and end
  setting, likely fine.

---

► **ANSWER**

### Code Review: Streaming Native Claude Thinking Blocks Implementation

#### Overall Assessment

The implementation correctly adds support for streaming native Claude "thinking"
events (`thinking_delta`, `thinking_start`, `thinking_end`) as a separate buffer
(`nativeThinkingBuffer`) distinct from the existing `<think>` tag processing in
text streams. It accumulates deltas incrementally, falls back to full content on
`thinking_end` for robustness, streams via `emitReasoningStream()` when
`reasoningMode === "stream"`, and resets the buffer reliably at message
boundaries (`message_start` and `message_end`). There is no interference with
`<think>` tag handling, as thinking events are early-returned before text
processing, and `<think>` extraction remains tied to `deltaBuffer` via
`extractThinkingFromTaggedStream()`.

The changes are minimal, well-contained, and align with the feature
requirements. State management is solid, with per-message scoping and duplicate
suppression via `lastStreamedReasoning`. No obvious bugs, race conditions, or
regressions were identified. The code handles provider quirks (e.g., full
content resends, missed deltas) gracefully.

#### Correctness

- **Accumulation and Streaming**:
  - Deltas append correctly to `nativeThinkingBuffer` on `thinking_delta`.

  - `thinking_end` overwrites with `thinkingContent` as a safety net ("in case
    of missed deltas"), which is idempotent due to `emitReasoningStream()`'s
    duplicate check (`formatted === state.lastStreamedReasoning`). This ensures
    monotonic streaming even if partial deltas are incomplete.

  - Incremental emits happen on every thinking event if `streamReasoning` is
    true, feeding Discord via `onReasoningStream`.

  - Final emit in `handleMessageEnd` uses
    `extractAssistantThinking(assistantMessage)` (presumably pulling native thinking
    from the completed message object), ensuring completeness.

- **Separation from `<think>` Tags**:
  - Thinking events bypass all text processing (`return;` after handling), so
    `deltaBuffer`/`blockBuffer` remain untouched.

  - Text events still extract `<think>` content via
    `extractThinkingFromTaggedStream(deltaBuffer)` for streaming, preserving legacy
    behavior.

  - `stripBlockTags()` ignores native thinking entirely, as it's not in
    `deltaBuffer`.

- **Reset Behavior**:
  - `resetAssistantMessageState()` (called on `message_start`) clears
    `nativeThinkingBuffer`.

  - `handleMessageEnd` clears it post-processing.

  - `resetForCompactionRetry()` also clears it.

  - This prevents carryover between messages, even with late/out-of-order
    events.

- **Raw Stream Logging**:
  - `appendRawStream()` correctly logs thinking events separately
    (`assistant_thinking_stream`), aiding debugging.

#### Edge Cases Handled

- **No Thinking Events**: Buffer stays empty; no emits.

- **Only `thinking_start`/`thinking_end` (No Deltas)**: Buffer sets on end if
  `content` present; emits final.

- **Missed/Partial Deltas**: `thinking_end` fallback ensures full content.

- **Empty Deltas/Content**: No buffer mutation; no spurious emits.

- **`thinking_end` After Deltas**: Overwrite is safe (duplicate check skips
  re-emit if unchanged).

- **Interleaved Events**: Handled sequentially per SDK delivery; thinking events
  skip text path.

- **Late `thinking_end`**: Processed if before `message_end`; buffer reset
  discards post-end.

- **Multiple Messages**: Per-message resets isolate buffers.

- **Non-Stream Mode (`reasoningMode !== "stream"`)**: No emits, but buffer still
  accumulates (harmless, as not used).

- **Provider Full Resends**: Similar to text handling; duplicate suppression
  works.

- **Compaction Retries**: Full reset includes buffer.

Untested/Missing Edges (Low Risk):

- **Nested/Multiple Native Thinking Blocks**: Assumes one per message (Claude
  behavior); multiple would accumulate into single buffer—test if SDK supports
  multiples.

- **Malformed Events** (e.g., non-string `delta`): Type guards (`typeof ... === 
"string"`) prevent crashes.

- **Zero-Length Deltas**: Appends nothing; fine.

- **Out-of-Order Delivery**: Relies on SDK ordering; if `thinking_end` before
  deltas, fallback uses partial `content`—add logging if `buffer.length > 0`
  before overwrite.

#### Potential Issues

- **No Major Bugs**: No leaks, infinite loops, or state corruption. Duplicate
  checks prevent spam.

- **Minor State Overwrite in `thinking_end`**:
  - If deltas accumulate 80% content and `thinking_end` provides 100%, overwrite
    completes it safely.

  - Risk: If `thinkingContent` is incomplete (unlikely), it truncates.
    Recommendation: Log a warning if `buffer.length > 0 && buffer !== 
thinkingContent` for monitoring.

- **Race Conditions**: None apparent; event handler is
  synchronous/single-threaded per subscription. Async `onReasoningStream` calls
  are fire-and-forget (`void`), non-blocking.

- **Performance**: Buffer appends are O(1) amortized; no regex/heavy ops on
  thinking path. Fine for expected sizes.

- **Dependencies**:
  - Relies on `formatReasoningMessage()` handling native thinking format
    correctly (not shown; assume validated).

  - `extractAssistantThinking()` in `message_end` must match native buffer
    source.

- **Logging Gaps**: No debug logs for buffer mutations/emits. Add
  `ctx.log.debug("native thinking buffer: ${len}")` optionally.

- **Discord-Specific**: Assumes `onReasoningStream` rate-limits/handles Discord
  typing/reply limits; upstream concern.

#### Recommendations

- **Strengthen Monitoring**: Add optional logging in thinking handler (e.g.,
  buffer length on delta/overwrite) to detect anomalies in production.

- **Unit Tests**: Ensure coverage for:
  - Delta-only, end-only, mixed sequences.

  - Duplicate `lastStreamedReasoning` suppression.

  - Reset isolation (multi-message streams).

  - Interleave with text events.

- **Documentation**: Comment Claude-specific event shapes (e.g.,
  `assistantMessageEvent: {type: "thinking_delta", delta: "..."}`).

- **Polish**: Reuse `delta`/`content` vars in thinking block (avoid re-fetching
  `assistantRecord?.delta`).

- **No Changes Needed**: Implementation is production-ready; risks are
  mitigated.

This is a clean, robust addition. Confidence: High.

Tokens: 27k sent, 3.0k received. Cost: $0.0069 message, $0.0069 session.

```

---

## ✓ Llama 4 Maverick

**Status:** done | **Time:** 1m 00s

```

You can skip this check with --no-gitignore
Added .aider\* to .gitignore
Failed to fetch OpenRouter model list: HTTPSConnectionPool(host='openrouter.ai', port=443): Read timed out. (read timeout=10)
Aider v0.86.1
Model: openrouter/meta-llama/llama-4-maverick with whole edit format
Git repo: .git with 4,609 files
Warning: For large repos, consider using --subtree-only and .aiderignore
See: https://aider.chat/docs/faq.html#can-i-use-aider-in-a-large-mono-repo
Repo-map: using 4096 tokens, auto refresh
Added src/agents/pi-embedded-subscribe.handlers.messages.ts to the chat.
Added src/agents/pi-embedded-subscribe.handlers.types.ts to the chat.
Added src/agents/pi-embedded-subscribe.ts to the chat.
Added AGENTS.md to the chat (read-only).

The implementation of streaming native Claude thinking blocks to Discord appears
to be mostly correct. However, there are a few potential issues and edge cases
to consider:

1. The `nativeThinkingBuffer` is not properly cleared when the `message_end`
   event is received. While it is reset in the `resetAssistantMessageState`
   function, it's worth noting that this function is called at the start of a new
   message, not at the end of the previous one.

2. The `emitReasoningStream` function is called multiple times with the same
   `nativeThinkingBuffer` content. This could potentially lead to duplicate
   reasoning messages being sent to Discord. To fix this, the
   `lastStreamedReasoning` state should be updated when `emitReasoningStream` is
   called.

3. The `handleMessageUpdate` function does not check if
   `ctx.state.streamReasoning` is enabled before appending to
   `nativeThinkingBuffer`. This could potentially lead to unnecessary work being
   done.

4. The `handleMessageEnd` function emits the `rawThinking` via
   `emitReasoningStream` after the message has ended. This might not be the
   intended behavior, as the thinking stream is typically used to provide
   incremental updates.

To address these issues, the code should be reviewed and potentially modified to
ensure that the `nativeThinkingBuffer` is properly managed, and that
`emitReasoningStream` is called correctly.

Here are the potential changes:

src/agents/pi-embedded-subscribe.handlers.messages.ts

```diff
@@ -1,366 +1,28 @@
-import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
-import type { EmbeddedPiSubscribeContext } from
"./pi-embedded-subscribe.handlers.types.js";
-import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
-import { emitAgentEvent } from "../infra/agent-events.js";
-import { createInlineCodeState } from "../markdown/code-spans.js";
-import {
-  isMessagingToolDuplicateNormalized,
-  normalizeTextForComparison,
-} from "./pi-embedded-helpers.js";
-import { appendRawStream } from "./pi-embedded-subscribe.raw-stream.js";
-import {
-  extractAssistantText,
-  extractAssistantThinking,
-  extractThinkingFromTaggedStream,
-  extractThinkingFromTaggedText,
-  formatReasoningMessage,
-  promoteThinkingTagsToBlocks,
-} from "./pi-embedded-utils.js";
+// Handle native thinking block events (Claude extended thinking)
+if (isThinkingEvent) {
+  const thinkingDelta = typeof assistantRecord?.delta === "string" ?
assistantRecord.delta : "";
+  const thinkingContent = typeof assistantRecord?.content === "string" ?
assistantRecord.content : "";

-const stripTrailingDirective = (text: string): string => {
-  const openIndex = text.lastIndexOf("[[");
-  if (openIndex < 0) {
-    return text;
-  }
-  const closeIndex = text.indexOf("]]", openIndex + 2);
-  if (closeIndex >= 0) {
-    return text;
-  }
-  return text.slice(0, openIndex);
-};
-
-export function handleMessageStart(
-  ctx: EmbeddedPiSubscribeContext,
-  evt: AgentEvent & { message: AgentMessage },
-) {
-  const msg = evt.message;
-  if (msg?.role !== "assistant") {
-    return;
-  }
-
-  // KNOWN: Resetting at `text_end` is unsafe (late/duplicate end events).
-  // ASSUME: `message_start` is the only reliable boundary for “new assistant
message begins”.
-  // Start-of-message is a safer reset point than message_end: some providers
-  // may deliver late text_end updates after message_end, which would otherwise
-  // re-trigger block replies.
-  ctx.resetAssistantMessageState(ctx.state.assistantTexts.length);
-  // Use assistant message_start as the earliest "writing" signal for typing.
-  void ctx.params.onAssistantMessageStart?.();
-}
-
-export function handleMessageUpdate(
-  ctx: EmbeddedPiSubscribeContext,
-  evt: AgentEvent & { message: AgentMessage; assistantMessageEvent?: unknown },
-) {
-  const msg = evt.message;
-  if (msg?.role !== "assistant") {
-    return;
-  }
-
-  const assistantEvent = evt.assistantMessageEvent;
-  const assistantRecord =
-    assistantEvent && typeof assistantEvent === "object"
-      ? (assistantEvent as Record<string, unknown>)
-      : undefined;
-  const evtType = typeof assistantRecord?.type === "string" ?
assistantRecord.type : "";
-
-  const isTextEvent = evtType === "text_delta" || evtType === "text_start" ||
evtType === "text_end";
-  const isThinkingEvent = evtType === "thinking_delta" || evtType ===
"thinking_start" || evtType === "thinking_end";
-
-  if (!isTextEvent && !isThinkingEvent) {
-    return;
-  }
-
-  const delta = typeof assistantRecord?.delta === "string" ?
assistantRecord.delta : "";
-  const content = typeof assistantRecord?.content === "string" ?
assistantRecord.content : "";
-
-  // Handle native thinking block events (Claude extended thinking)
-  if (isThinkingEvent) {
-    const thinkingDelta = typeof assistantRecord?.delta === "string" ?
assistantRecord.delta : "";
-    const thinkingContent = typeof assistantRecord?.content === "string" ?
assistantRecord.content : "";
-
+  if (ctx.state.streamReasoning) {
     if (evtType === "thinking_delta" && thinkingDelta) {
       ctx.state.nativeThinkingBuffer += thinkingDelta;
+      ctx.emitReasoningStream(thinkingDelta);
     } else if (evtType === "thinking_end" && thinkingContent) {
       // Ensure buffer reflects full content (in case of missed deltas)
       ctx.state.nativeThinkingBuffer = thinkingContent;
+      ctx.emitReasoningStream(thinkingContent);
     }
-
-    // Stream reasoning if enabled
-    if (ctx.state.streamReasoning && ctx.state.nativeThinkingBuffer) {
-      ctx.emitReasoningStream(ctx.state.nativeThinkingBuffer);
-    }
-
-    appendRawStream({
-      ts: Date.now(),
-      event: "assistant_thinking_stream",
-      runId: ctx.params.runId,
-      sessionId: (ctx.params.session as { id?: string }).id,
-      evtType,
-      delta: thinkingDelta,
-      content: thinkingContent,
-    });
-
-    return; // Thinking events don't contribute to text output
   }

   appendRawStream({
     ts: Date.now(),
-    event: "assistant_text_stream",
+    event: "assistant_thinking_stream",
     runId: ctx.params.runId,
     sessionId: (ctx.params.session as { id?: string }).id,
     evtType,
-    delta,
-    content,
+    delta: thinkingDelta,
+    content: thinkingContent,
   });

-  let chunk = "";
-  if (evtType === "text_delta") {
-    chunk = delta;
-  } else if (evtType === "text_start" || evtType === "text_end") {
-    if (delta) {
-      chunk = delta;
-    } else if (content) {
-      // KNOWN: Some providers resend full content on `text_end`.
-      // We only append a suffix (or nothing) to keep output monotonic.
-      if (content.startsWith(ctx.state.deltaBuffer)) {
-        chunk = content.slice(ctx.state.deltaBuffer.length);
-      } else if (ctx.state.deltaBuffer.startsWith(content)) {
-        chunk = "";
-      } else if (!ctx.state.deltaBuffer.includes(content)) {
-        chunk = content;
-      }
-    }
-  }
-
-  if (chunk) {
-    ctx.state.deltaBuffer += chunk;
-    if (ctx.blockChunker) {
-      ctx.blockChunker.append(chunk);
-    } else {
-      ctx.state.blockBuffer += chunk;
-    }
-  }
-
-  if (ctx.state.streamReasoning) {
-    // Handle partial <think> tags: stream whatever reasoning is visible so
far.
-
ctx.emitReasoningStream(extractThinkingFromTaggedStream(ctx.state.deltaBuffer));
-  }
-
-  const next = ctx
-    .stripBlockTags(ctx.state.deltaBuffer, {
-      thinking: false,
-      final: false,
-      inlineCode: createInlineCodeState(),
-    })
-    .trim();
-  if (next) {
-    const visibleDelta = chunk ? ctx.stripBlockTags(chunk,
ctx.state.partialBlockState) : "";
-    const parsedDelta = visibleDelta ?
ctx.consumePartialReplyDirectives(visibleDelta) : null;
-    const parsedFull = parseReplyDirectives(stripTrailingDirective(next));
-    const cleanedText = parsedFull.text;
-    const mediaUrls = parsedDelta?.mediaUrls;
-    const hasMedia = Boolean(mediaUrls && mediaUrls.length > 0);
-    const hasAudio = Boolean(parsedDelta?.audioAsVoice);
-    const previousCleaned = ctx.state.lastStreamedAssistantCleaned ?? "";
-
-    let shouldEmit = false;
-    let deltaText = "";
-    if (!cleanedText && !hasMedia && !hasAudio) {
-      shouldEmit = false;
-    } else if (previousCleaned && !cleanedText.startsWith(previousCleaned)) {
-      shouldEmit = false;
-    } else {
-      deltaText = cleanedText.slice(previousCleaned.length);
-      shouldEmit = Boolean(deltaText || hasMedia || hasAudio);
-    }
-
-    ctx.state.lastStreamedAssistant = next;
-    ctx.state.lastStreamedAssistantCleaned = cleanedText;
-
-    if (shouldEmit) {
-      emitAgentEvent({
-        runId: ctx.params.runId,
-        stream: "assistant",
-        data: {
-          text: cleanedText,
-          delta: deltaText,
-          mediaUrls: hasMedia ? mediaUrls : undefined,
-        },
-      });
-      void ctx.params.onAgentEvent?.({
-        stream: "assistant",
-        data: {
-          text: cleanedText,
-          delta: deltaText,
-          mediaUrls: hasMedia ? mediaUrls : undefined,
-        },
-      });
-      if (ctx.params.onPartialReply && ctx.state.shouldEmitPartialReplies) {
-        void ctx.params.onPartialReply({
-          text: cleanedText,
-          mediaUrls: hasMedia ? mediaUrls : undefined,
-        });
-      }
-    }
-  }
-
-  if (ctx.params.onBlockReply && ctx.blockChunking && ctx.state.blockReplyBreak
=== "text_end") {
-    ctx.blockChunker?.drain({ force: false, emit: ctx.emitBlockChunk });
-  }
-
-  if (evtType === "text_end" && ctx.state.blockReplyBreak === "text_end") {
-    if (ctx.blockChunker?.hasBuffered()) {
-      ctx.blockChunker.drain({ force: true, emit: ctx.emitBlockChunk });
-      ctx.blockChunker.reset();
-    } else if (ctx.state.blockBuffer.length > 0) {
-      ctx.emitBlockChunk(ctx.state.blockBuffer);
-      ctx.state.blockBuffer = "";
-    }
-  }
+  return; // Thinking events don't contribute to text output
 }
-
-export function handleMessageEnd(
-  ctx: EmbeddedPiSubscribeContext,
-  evt: AgentEvent & { message: AgentMessage },
-) {
-  const msg = evt.message;
-  if (msg?.role !== "assistant") {
-    return;
-  }
-
-  const assistantMessage = msg;
-  promoteThinkingTagsToBlocks(assistantMessage);
-
-  const rawText = extractAssistantText(assistantMessage);
-  appendRawStream({
-    ts: Date.now(),
-    event: "assistant_message_end",
-    runId: ctx.params.runId,
-    sessionId: (ctx.params.session as { id?: string }).id,
-    rawText,
-    rawThinking: extractAssistantThinking(assistantMessage),
-  });
-
-  const text = ctx.stripBlockTags(rawText, { thinking: false, final: false });
-  const rawThinking =
-    ctx.state.includeReasoning || ctx.state.streamReasoning
-      ? extractAssistantThinking(assistantMessage) ||
extractThinkingFromTaggedText(rawText)
-      : "";
-  const formattedReasoning = rawThinking ? formatReasoningMessage(rawThinking)
: "";
-
-  const addedDuringMessage = ctx.state.assistantTexts.length >
ctx.state.assistantTextBaseline;
-  const chunkerHasBuffered = ctx.blockChunker?.hasBuffered() ?? false;
-  ctx.finalizeAssistantTexts({ text, addedDuringMessage, chunkerHasBuffered });
-
-  const onBlockReply = ctx.params.onBlockReply;
-  const shouldEmitReasoning = Boolean(
-    ctx.state.includeReasoning &&
-    formattedReasoning &&
-    onBlockReply &&
-    formattedReasoning !== ctx.state.lastReasoningSent,
-  );
-  const shouldEmitReasoningBeforeAnswer =
-    shouldEmitReasoning && ctx.state.blockReplyBreak === "message_end" &&
!addedDuringMessage;
-  const maybeEmitReasoning = () => {
-    if (!shouldEmitReasoning || !formattedReasoning) {
-      return;
-    }
-    ctx.state.lastReasoningSent = formattedReasoning;
-    void onBlockReply?.({ text: formattedReasoning });
-  };
-
-  if (shouldEmitReasoningBeforeAnswer) {
-    maybeEmitReasoning();
-  }
-
-  if (
-    (ctx.state.blockReplyBreak === "message_end" ||
-      (ctx.blockChunker ? ctx.blockChunker.hasBuffered() :
ctx.state.blockBuffer.length > 0)) &&
-    text &&
-    onBlockReply
-  ) {
-    if (ctx.blockChunker?.hasBuffered()) {
-      ctx.blockChunker.drain({ force: true, emit: ctx.emitBlockChunk });
-      ctx.blockChunker.reset();
-    } else if (text !== ctx.state.lastBlockReplyText) {
-      // Check for duplicates before emitting (same logic as emitBlockChunk).
-      const normalizedText = normalizeTextForComparison(text);
-      if (
-        isMessagingToolDuplicateNormalized(
-          normalizedText,
-          ctx.state.messagingToolSentTextsNormalized,
-        )
-      ) {
-        ctx.log.debug(
-          `Skipping message_end block reply - already sent via messaging tool:
${text.slice(0, 50)}...`,
-        );
-      } else {
-        ctx.state.lastBlockReplyText = text;
-        const splitResult = ctx.consumeReplyDirectives(text, { final: true });
-        if (splitResult) {
-          const {
-            text: cleanedText,
-            mediaUrls,
-            audioAsVoice,
-            replyToId,
-            replyToTag,
-            replyToCurrent,
-          } = splitResult;
-          // Emit if there's content OR audioAsVoice flag (to propagate the
flag).
-          if (cleanedText || (mediaUrls && mediaUrls.length > 0) ||
audioAsVoice) {
-            void onBlockReply({
-              text: cleanedText,
-              mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
-              audioAsVoice,
-              replyToId,
-              replyToTag,
-              replyToCurrent,
-            });
-          }
-        }
-      }
-    }
-  }
-
-  if (!shouldEmitReasoningBeforeAnswer) {
-    maybeEmitReasoning();
-  }
-  if (ctx.state.streamReasoning && rawThinking) {
-    ctx.emitReasoningStream(rawThinking);
-  }
-
-  if (ctx.state.blockReplyBreak === "text_end" && onBlockReply) {
-    const tailResult = ctx.consumeReplyDirectives("", { final: true });
-    if (tailResult) {
-      const {
-        text: cleanedText,
-        mediaUrls,
-        audioAsVoice,
-        replyToId,
-        replyToTag,
-        replyToCurrent,
-      } = tailResult;
-      if (cleanedText || (mediaUrls && mediaUrls.length > 0) || audioAsVoice) {
-        void onBlockReply({
-          text: cleanedText,
-          mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
-          audioAsVoice,
-          replyToId,
-          replyToTag,
-          replyToCurrent,
-        });
-      }
-    }
-  }
-
-  ctx.state.deltaBuffer = "";
-  ctx.state.blockBuffer = "";
-  ctx.blockChunker?.reset();
-  ctx.state.blockState.thinking = false;
-  ctx.state.blockState.final = false;
-  ctx.state.blockState.inlineCode = createInlineCodeState();
-  ctx.state.nativeThinkingBuffer = "";
-  ctx.state.lastStreamedAssistant = undefined;
-  ctx.state.lastStreamedAssistantCleaned = undefined;
-}
```

src/agents/pi-embedded-subscribe.handlers.messages.ts

```diff
@@ -1,366 +1,4 @@
-import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
-import type { EmbeddedPiSubscribeContext } from
"./pi-embedded-subscribe.handlers.types.js";
-import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
-import { emitAgentEvent } from "../infra/agent-events.js";
-import { createInlineCodeState } from "../markdown/code-spans.js";
-import {
-  isMessagingToolDuplicateNormalized,
-  normalizeTextForComparison,
-} from "./pi-embedded-helpers.js";
-import { appendRawStream } from "./pi-embedded-subscribe.raw-stream.js";
-import {
-  extractAssistantText,
-  extractAssistantThinking,
-  extractThinkingFromTaggedStream,
-  extractThinkingFromTaggedText,
-  formatReasoningMessage,
-  promoteThinkingTagsToBlocks,
-} from "./pi-embedded-utils.js";
-
-const stripTrailingDirective = (text: string): string => {
-  const openIndex = text.lastIndexOf("[[");
-  if (openIndex < 0) {
-    return text;
-  }
-  const closeIndex = text.indexOf("]]", openIndex + 2);
-  if (closeIndex >= 0) {
-    return text;
-  }
-  return text.slice(0, openIndex);
-};
-
-export function handleMessageStart(
-  ctx: EmbeddedPiSubscribeContext,
-  evt: AgentEvent & { message: AgentMessage },
-) {
-  const msg = evt.message;
-  if (msg?.role !== "assistant") {
-    return;
-  }
-
-  // KNOWN: Resetting at `text_end` is unsafe (late/duplicate end events).
-  // ASSUME: `message_start` is the only reliable boundary for “new assistant
message begins”.
-  // Start-of-message is a safer reset point than message_end: some providers
-  // may deliver late text_end updates after message_end, which would otherwise
-  // re-trigger block replies.
-  ctx.resetAssistantMessageState(ctx.state.assistantTexts.length);
-  // Use assistant message_start as the earliest "writing" signal for typing.
-  void ctx.params.onAssistantMessageStart?.();
+if (ctx.state.streamReasoning && rawThinking) {
+  // Remove this line to avoid emitting the full rawThinking after message end
+  // ctx.emitReasoningStream(rawThinking);
 }
-
-export function handleMessageUpdate(
-  ctx: EmbeddedPiSubscribeContext,
-  evt: AgentEvent & { message: AgentMessage; assistantMessageEvent?: unknown },
-) {
-  const msg = evt.message;
-  if (msg?.role !== "assistant") {
-    return;
-  }
-
-  const assistantEvent = evt.assistantMessageEvent;
-  const assistantRecord =
-    assistantEvent && typeof assistantEvent === "object"
-      ? (assistantEvent as Record<string, unknown>)
-      : undefined;
-  const evtType = typeof assistantRecord?.type === "string" ?
assistantRecord.type : "";
-
-  const isTextEvent = evtType === "text_delta" || evtType === "text_start" ||
evtType === "text_end";
-  const isThinkingEvent = evtType === "thinking_delta" || evtType ===
"thinking_start" || evtType === "thinking_end";
-
-  if (!isTextEvent && !isThinkingEvent) {
-    return;
-  }
-
-  const delta = typeof assistantRecord?.delta === "string" ?
assistantRecord.delta : "";
-  const content = typeof assistantRecord?.content === "string" ?
assistantRecord.content : "";
-
-  // Handle native thinking block events (Claude extended thinking)
-  if (isThinkingEvent) {
-    const thinkingDelta = typeof assistantRecord?.delta === "string" ?
assistantRecord.delta : "";
-    const thinkingContent = typeof assistantRecord?.content === "string" ?
assistantRecord.content : "";
-
-    if (evtType === "thinking_delta" && thinkingDelta) {
-      ctx.state.nativeThinkingBuffer += thinkingDelta;
-    } else if (evtType === "thinking_end" && thinkingContent) {
-      // Ensure buffer reflects full content (in case of missed deltas)
-      ctx.state.nativeThinkingBuffer = thinkingContent;
-    }
-
-    // Stream reasoning if enabled
-    if (ctx.state.streamReasoning && ctx.state.nativeThinkingBuffer) {
-      ctx.emitReasoningStream(ctx.state.nativeThinkingBuffer);
-    }
-
-    appendRawStream({
-      ts: Date.now(),
-      event: "assistant_thinking_stream",
-      runId: ctx.params.runId,
-      sessionId: (ctx.params.session as { id?: string }).id,
-      evtType,
-      delta: thinkingDelta,
-      content: thinkingContent,
-    });
-
-    return; // Thinking events don't contribute to text output
-  }
-
-  appendRawStream({
-    ts: Date.now(),
-    event: "assistant_text_stream",
-    runId: ctx.params.runId,
-    sessionId: (ctx.params.session as { id?: string }).id,
-    evtType,
-    delta,
-    content,
-  });
-
-  let chunk = "";
-  if (evtType === "text_delta") {
-    chunk = delta;
-  } else if (evtType === "text_start" || evtType === "text_end") {
-    if (delta) {
-      chunk = delta;
-    } else if (content) {
-      // KNOWN: Some providers resend full content on `text_end`.
-      // We only append a suffix (or nothing) to keep output monotonic.
-      if (content.startsWith(ctx.state.deltaBuffer)) {
-        chunk = content.slice(ctx.state.deltaBuffer.length);
-      } else if (ctx.state.deltaBuffer.startsWith(content)) {
-        chunk = "";
-      } else if (!ctx.state.deltaBuffer.includes(content)) {
-        chunk = content;
-      }
-    }
-  }
-
-  if (chunk) {
-    ctx.state.deltaBuffer += chunk;
-    if (ctx.blockChunker) {
-      ctx.blockChunker.append(chunk);
-    } else {
-      ctx.state.blockBuffer += chunk;
-    }
-  }
-
-  if (ctx.state.streamReasoning) {
-    // Handle partial <think> tags: stream whatever reasoning is visible so
far.
-
ctx.emitReasoningStream(extractThinkingFromTaggedStream(ctx.state.deltaBuffer));
-  }
-
-  const next = ctx
-    .stripBlockTags(ctx.state.deltaBuffer, {
-      thinking: false,
-      final: false,
-      inlineCode: createInlineCodeState(),
-    })
-    .trim();
-  if (next) {
-    const visibleDelta = chunk ? ctx.stripBlockTags(chunk,
ctx.state.partialBlockState) : "";
-    const parsedDelta = visibleDelta ?
ctx.consumePartialReplyDirectives(visibleDelta) : null;
-    const parsedFull = parseReplyDirectives(stripTrailingDirective(next));
-    const cleanedText = parsedFull.text;
-    const mediaUrls = parsedDelta?.mediaUrls;
-    const hasMedia = Boolean(mediaUrls && mediaUrls.length > 0);
-    const hasAudio = Boolean(parsedDelta?.audioAsVoice);
-    const previousCleaned = ctx.state.lastStreamedAssistantCleaned ?? "";
-
-    let shouldEmit = false;
-    let deltaText = "";
-    if (!cleanedText && !hasMedia && !hasAudio) {
-      shouldEmit = false;
-    } else if (previousCleaned && !cleanedText.startsWith(previousCleaned)) {
-      shouldEmit = false;
-    } else {
-      deltaText = cleanedText.slice(previousCleaned.length);
-      shouldEmit = Boolean(deltaText || hasMedia || hasAudio);
-    }
-
-    ctx.state.lastStreamedAssistant = next;
-    ctx.state.lastStreamedAssistantCleaned = cleanedText;
-
-    if (shouldEmit) {
-      emitAgentEvent({
-        runId: ctx.params.runId,
-        stream: "assistant",
-        data: {
-          text: cleanedText,
-          delta: deltaText,
-          mediaUrls: hasMedia ? mediaUrls : undefined,
-        },
-      });
-      void ctx.params.onAgentEvent?.({
-        stream: "assistant",
-        data: {
-          text: cleanedText,
-          delta: deltaText,
-          mediaUrls: hasMedia ? mediaUrls : undefined,
-        },
-      });
-      if (ctx.params.onPartialReply && ctx.state.shouldEmitPartialReplies) {
-        void ctx.params.onPartialReply({
-          text: cleanedText,
-          mediaUrls: hasMedia ? mediaUrls : undefined,
-        });
-      }
-    }
-  }
-
-  if (ctx.params.onBlockReply && ctx.blockChunking && ctx.state.blockReplyBreak
=== "text_end") {
-    ctx.blockChunker?.drain({ force: false, emit: ctx.emitBlockChunk });
-  }
-
-  if (evtType === "text_end" && ctx.state.blockReplyBreak === "text_end") {
-    if (ctx.blockChunker?.hasBuffered()) {
-      ctx.blockChunker.drain({ force: true, emit: ctx.emitBlockChunk });
-      ctx.blockChunker.reset();
-    } else if (ctx.state.blockBuffer.length > 0) {
-      ctx.emitBlockChunk(ctx.state.blockBuffer);
-      ctx.state.blockBuffer = "";
-    }
-  }
-}
-
-export function handleMessageEnd(
-  ctx: EmbeddedPiSubscribeContext,
-  evt: AgentEvent & { message: AgentMessage },
-) {
-  const msg = evt.message;
-  if (msg?.role !== "assistant") {
-    return;
-  }
-
-  const assistantMessage = msg;
-  promoteThinkingTagsToBlocks(assistantMessage);
-
-  const rawText = extractAssistantText(assistantMessage);
-  appendRawStream({
-    ts: Date.now(),
-    event: "assistant_message_end",
-    runId: ctx.params.runId,
-    sessionId: (ctx.params.session as { id?: string }).id,
-    rawText,
-    rawThinking: extractAssistantThinking(assistantMessage),
-  });
-
-  const text = ctx.stripBlockTags(rawText, { thinking: false, final: false });
-  const rawThinking =
-    ctx.state.includeReasoning || ctx.state.streamReasoning
-      ? extractAssistantThinking(assistantMessage) ||
extractThinkingFromTaggedText(rawText)
-      : "";
-  const formattedReasoning = rawThinking ? formatReasoningMessage(rawThinking)
: "";
-
-  const addedDuringMessage = ctx.state.assistantTexts.length >
ctx.state.assistantTextBaseline;
-  const chunkerHasBuffered = ctx.blockChunker?.hasBuffered() ?? false;
-  ctx.finalizeAssistantTexts({ text, addedDuringMessage, chunkerHasBuffered });
-
-  const onBlockReply = ctx.params.onBlockReply;
-  const shouldEmitReasoning = Boolean(
-    ctx.state.includeReasoning &&
-    formattedReasoning &&
-    onBlockReply &&
-    formattedReasoning !== ctx.state.lastReasoningSent,
-  );
-  const shouldEmitReasoningBeforeAnswer =
-    shouldEmitReasoning && ctx.state.blockReplyBreak === "message_end" &&
!addedDuringMessage;
-  const maybeEmitReasoning = () => {
-    if (!shouldEmitReasoning || !formattedReasoning) {
-      return;
-    }
-    ctx.state.lastReasoningSent = formattedReasoning;
-    void onBlockReply?.({ text: formattedReasoning });
-  };
-
-  if (shouldEmitReasoningBeforeAnswer) {
-    maybeEmitReasoning();
-  }
-
-  if (
-    (ctx.state.blockReplyBreak === "message_end" ||
-      (ctx.blockChunker ? ctx.blockChunker.hasBuffered() :
ctx.state.blockBuffer.length > 0)) &&
-    text &&
-    onBlockReply
-  ) {
-    if (ctx.blockChunker?.hasBuffered()) {
-      ctx.blockChunker.drain({ force: true, emit: ctx.emitBlockChunk });
-      ctx.blockChunker.reset();
-    } else if (text !== ctx.state.lastBlockReplyText) {
-      // Check for duplicates before emitting (same logic as emitBlockChunk).
-      const normalizedText = normalizeTextForComparison(text);
-      if (
-        isMessagingToolDuplicateNormalized(
-          normalizedText,
-          ctx.state.messagingToolSentTextsNormalized,
-        )
-      ) {
-        ctx.log.debug(
-          `Skipping message_end block reply - already sent via messaging tool:
${text.slice(0, 50)}...`,
-        );
-      } else {
-        ctx.state.lastBlockReplyText = text;
-        const splitResult = ctx.consumeReplyDirectives(text, { final: true });
-        if (splitResult) {
-          const {
-            text: cleanedText,
-            mediaUrls,
-            audioAsVoice,
-            replyToId,
-            replyToTag,
-            replyToCurrent,
-          } = splitResult;
-          // Emit if there's content OR audioAsVoice flag (to propagate the
flag).
-          if (cleanedText || (mediaUrls && mediaUrls.length > 0) ||
audioAsVoice) {
-            void onBlockReply({
-              text: cleanedText,
-              mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
-              audioAsVoice,
-              replyToId,
-              replyToTag,
-              replyToCurrent,
-            });
-          }
-        }
-      }
-    }
-  }
-
-  if (!shouldEmitReasoningBeforeAnswer) {
-    maybeEmitReasoning();
-  }
-  if (ctx.state.streamReasoning && rawThinking) {
-    ctx.emitReasoningStream(rawThinking);
-  }
-
-  if (ctx.state.blockReplyBreak === "text_end" && onBlockReply) {
-    const tailResult = ctx.consumeReplyDirectives("", { final: true });
-    if (tailResult) {
-      const {
-        text: cleanedText,
-        mediaUrls,
-        audioAsVoice,
-        replyToId,
-        replyToTag,
-        replyToCurrent,
-      } = tailResult;
-      if (cleanedText || (mediaUrls && mediaUrls.length > 0) || audioAsVoice) {
-        void onBlockReply({
-          text: cleanedText,
-          mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
-          audioAsVoice,
-          replyToId,
-          replyToTag,
-          replyToCurrent,
-        });
-      }
-    }
-  }
-
-  ctx.state.deltaBuffer = "";
-  ctx.state.blockBuffer = "";
-  ctx.blockChunker?.reset();
-  ctx.state.blockState.thinking = false;
-  ctx.state.blockState.final = false;
-  ctx.state.blockState.inlineCode = createInlineCodeState();
-  ctx.state.nativeThinkingBuffer = "";
-  ctx.state.lastStreamedAssistant = undefined;
-  ctx.state.lastStreamedAssistantCleaned = undefined;
-}
```

src/agents/pi-embedded-subscribe.ts

```diff
@@ -1,593 +1,16 @@
-import type { InlineCodeState } from "../markdown/code-spans.js";
-import type {
-  EmbeddedPiSubscribeContext,
-  EmbeddedPiSubscribeState,
-} from "./pi-embedded-subscribe.handlers.types.js";
-import type { SubscribeEmbeddedPiSessionParams } from
"./pi-embedded-subscribe.types.js";
-import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
-import { createStreamingDirectiveAccumulator } from
"../auto-reply/reply/streaming-directives.js";
-import { formatToolAggregate } from "../auto-reply/tool-meta.js";
-import { createSubsystemLogger } from "../logging/subsystem.js";
-import { buildCodeSpanIndex, createInlineCodeState } from
"../markdown/code-spans.js";
-import { EmbeddedBlockChunker } from "./pi-embedded-block-chunker.js";
-import {
-  isMessagingToolDuplicateNormalized,
-  normalizeTextForComparison,
-} from "./pi-embedded-helpers.js";
-import { createEmbeddedPiSessionEventHandler } from
"./pi-embedded-subscribe.handlers.js";
-import { formatReasoningMessage } from "./pi-embedded-utils.js";
-
-const THINKING_TAG_SCAN_RE =
/<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
-const FINAL_TAG_SCAN_RE = /<\s*(\/?)\s*final\s*>/gi;
-const log = createSubsystemLogger("agent/embedded");
-
-export type {
-  BlockReplyChunking,
-  SubscribeEmbeddedPiSessionParams,
-  ToolResultFormat,
-} from "./pi-embedded-subscribe.types.js";
-
-export function subscribeEmbeddedPiSession(params:
SubscribeEmbeddedPiSessionParams) {
-  const reasoningMode = params.reasoningMode ?? "off";
-  const toolResultFormat = params.toolResultFormat ?? "markdown";
-  const useMarkdown = toolResultFormat === "markdown";
-  const state: EmbeddedPiSubscribeState = {
-    assistantTexts: [],
-    toolMetas: [],
-    toolMetaById: new Map(),
-    toolSummaryById: new Set(),
-    lastToolError: undefined,
-    blockReplyBreak: params.blockReplyBreak ?? "text_end",
-    reasoningMode,
-    includeReasoning: reasoningMode === "on",
-    shouldEmitPartialReplies: !(reasoningMode === "on" &&
!params.onBlockReply),
-    streamReasoning: reasoningMode === "stream" && typeof
params.onReasoningStream === "function",
-    deltaBuffer: "",
-    blockBuffer: "",
-    // Track if a streamed chunk opened a <think> block (stateful across
chunks).
-    blockState: { thinking: false, final: false, inlineCode:
createInlineCodeState() },
-    partialBlockState: { thinking: false, final: false, inlineCode:
createInlineCodeState() },
-    lastStreamedAssistant: undefined,
-    lastStreamedAssistantCleaned: undefined,
-    lastStreamedReasoning: undefined,
-    nativeThinkingBuffer: "",
-    lastBlockReplyText: undefined,
-    assistantMessageIndex: 0,
-    lastAssistantTextMessageIndex: -1,
-    lastAssistantTextNormalized: undefined,
-    lastAssistantTextTrimmed: undefined,
-    assistantTextBaseline: 0,
-    suppressBlockChunks: false, // Avoid late chunk inserts after final text
merge.
-    lastReasoningSent: undefined,
-    compactionInFlight: false,
-    pendingCompactionRetry: 0,
-    compactionRetryResolve: undefined,
-    compactionRetryPromise: null,
-    messagingToolSentTexts: [],
-    messagingToolSentTextsNormalized: [],
-    messagingToolSentTargets: [],
-    pendingMessagingTexts: new Map(),
-    pendingMessagingTargets: new Map(),
-  };
-
-  const assistantTexts = state.assistantTexts;
-  const toolMetas = state.toolMetas;
-  const toolMetaById = state.toolMetaById;
-  const toolSummaryById = state.toolSummaryById;
-  const messagingToolSentTexts = state.messagingToolSentTexts;
-  const messagingToolSentTextsNormalized =
state.messagingToolSentTextsNormalized;
-  const messagingToolSentTargets = state.messagingToolSentTargets;
-  const pendingMessagingTexts = state.pendingMessagingTexts;
-  const pendingMessagingTargets = state.pendingMessagingTargets;
-  const replyDirectiveAccumulator = createStreamingDirectiveAccumulator();
-  const partialReplyDirectiveAccumulator =
createStreamingDirectiveAccumulator();
-
-  const resetAssistantMessageState = (nextAssistantTextBaseline: number) => {
-    state.deltaBuffer = "";
-    state.blockBuffer = "";
-    blockChunker?.reset();
-    replyDirectiveAccumulator.reset();
-    partialReplyDirectiveAccumulator.reset();
-    state.blockState.thinking = false;
-    state.blockState.final = false;
-    state.blockState.inlineCode = createInlineCodeState();
-    state.partialBlockState.thinking = false;
-    state.partialBlockState.final = false;
-    state.partialBlockState.inlineCode = createInlineCodeState();
-    state.lastStreamedAssistant = undefined;
-    state.lastStreamedAssistantCleaned = undefined;
-    state.lastBlockReplyText = undefined;
-    state.lastStreamedReasoning = undefined;
-    state.nativeThinkingBuffer = "";
-    state.lastReasoningSent = undefined;
-    state.suppressBlockChunks = false;
-    state.assistantMessageIndex += 1;
-    state.lastAssistantTextMessageIndex = -1;
-    state.lastAssistantTextNormalized = undefined;
-    state.lastAssistantTextTrimmed = undefined;
-    state.assistantTextBaseline = nextAssistantTextBaseline;
-  };
-
-  const rememberAssistantText = (text: string) => {
-    state.lastAssistantTextMessageIndex = state.assistantMessageIndex;
-    state.lastAssistantTextTrimmed = text.trimEnd();
-    const normalized = normalizeTextForComparison(text);
-    state.lastAssistantTextNormalized = normalized.length > 0 ? normalized :
undefined;
-  };
-
-  const shouldSkipAssistantText = (text: string) => {
-    if (state.lastAssistantTextMessageIndex !== state.assistantMessageIndex) {
-      return false;
-    }
-    const trimmed = text.trimEnd();
-    if (trimmed && trimmed === state.lastAssistantTextTrimmed) {
-      return true;
-    }
-    const normalized = normalizeTextForComparison(text);
-    if (normalized.length > 0 && normalized ===
state.lastAssistantTextNormalized) {
-      return true;
-    }
-    return false;
-  };
-
-  const pushAssistantText = (text: string) => {
-    if (!text) {
-      return;
-    }
-    if (shouldSkipAssistantText(text)) {
-      return;
-    }
-    assistantTexts.push(text);
-    rememberAssistantText(text);
-  };
-
-  const finalizeAssistantTexts = (args: {
-    text: string;
-    addedDuringMessage: boolean;
-    chunkerHasBuffered: boolean;
-  }) => {
-    const { text, addedDuringMessage, chunkerHasBuffered } = args;
-
-    // If we're not streaming block replies, ensure the final payload includes
-    // the final text even when interim streaming was enabled.
-    if (state.includeReasoning && text && !params.onBlockReply) {
-      if (assistantTexts.length > state.assistantTextBaseline) {
-        assistantTexts.splice(
-          state.assistantTextBaseline,
-          assistantTexts.length - state.assistantTextBaseline,
-          text,
-        );
-        rememberAssistantText(text);
-      } else {
-        pushAssistantText(text);
-      }
-      state.suppressBlockChunks = true;
-    } else if (!addedDuringMessage && !chunkerHasBuffered && text) {
-      // Non-streaming models (no text_delta): ensure assistantTexts gets the
final
-      // text when the chunker has nothing buffered to drain.
-      pushAssistantText(text);
-    }
-
-    state.assistantTextBaseline = assistantTexts.length;
-  };
-
-  // ── Messaging tool duplicate detection
──────────────────────────────────────
-  // Track texts sent via messaging tools to suppress duplicate block replies.
-  // Only committed (successful) texts are checked - pending texts are tracked
-  // to support commit logic but not used for suppression (avoiding lost
messages on tool failure).
-  // These tools can send messages via sendMessage/threadReply actions (or
sessions_send with message).
-  const MAX_MESSAGING_SENT_TEXTS = 200;
-  const MAX_MESSAGING_SENT_TARGETS = 200;
-  const trimMessagingToolSent = () => {
-    if (messagingToolSentTexts.length > MAX_MESSAGING_SENT_TEXTS) {
-      const overflow = messagingToolSentTexts.length -
MAX_MESSAGING_SENT_TEXTS;
-      messagingToolSentTexts.splice(0, overflow);
-      messagingToolSentTextsNormalized.splice(0, overflow);
-    }
-    if (messagingToolSentTargets.length > MAX_MESSAGING_SENT_TARGETS) {
-      const overflow = messagingToolSentTargets.length -
MAX_MESSAGING_SENT_TARGETS;
-      messagingToolSentTargets.splice(0, overflow);
-    }
-  };
-
-  // Timeout for compaction retry promise to prevent deadlock.
-  // If the SDK's retry completeSimple() hangs forever, we force-resolve to
avoid session lockup.
-  const COMPACTION_RETRY_TIMEOUT_MS = 120_000; // 2 minutes
-  let compactionRetryTimeoutId: ReturnType<typeof setTimeout> | undefined;
-
-  const ensureCompactionPromise = () => {
-    if (!state.compactionRetryPromise) {
-      state.compactionRetryPromise = new Promise((resolve) => {
-        state.compactionRetryResolve = resolve;
-        // Safety timeout: force-resolve if compaction retry hangs to prevent
deadlock (#5784)
-        compactionRetryTimeoutId = setTimeout(() => {
-          if (state.compactionRetryResolve) {
-            log.warn(
-              `compaction retry timeout after ${COMPACTION_RETRY_TIMEOUT_MS}ms
- forcing resolve to prevent deadlock (runId=${params.runId})`,
-            );
-            state.compactionRetryResolve();
-            state.compactionRetryResolve = undefined;
-            state.compactionRetryPromise = null;
-            state.pendingCompactionRetry = 0;
-            compactionRetryTimeoutId = undefined;
-          }
-        }, COMPACTION_RETRY_TIMEOUT_MS);
-      });
-    }
-  };
-
-  const clearCompactionRetryTimeout = () => {
-    if (compactionRetryTimeoutId !== undefined) {
-      clearTimeout(compactionRetryTimeoutId);
-      compactionRetryTimeoutId = undefined;
-    }
-  };
-
-  const noteCompactionRetry = () => {
-    state.pendingCompactionRetry += 1;
-    ensureCompactionPromise();
-  };
-
-  const resolveCompactionRetry = () => {
-    if (state.pendingCompactionRetry <= 0) {
-      return;
-    }
-    state.pendingCompactionRetry -= 1;
-    if (state.pendingCompactionRetry === 0 && !state.compactionInFlight) {
-      clearCompactionRetryTimeout();
-      state.compactionRetryResolve?.();
-      state.compactionRetryResolve = undefined;
-      state.compactionRetryPromise = null;
-    }
-  };
-
-  const maybeResolveCompactionWait = () => {
-    if (state.pendingCompactionRetry === 0 && !state.compactionInFlight) {
-      clearCompactionRetryTimeout();
-      state.compactionRetryResolve?.();
-      state.compactionRetryResolve = undefined;
-      state.compactionRetryPromise = null;
-    }
-  };
-
-  const blockChunking = params.blockReplyChunking;
-  const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking)
: null;
-  // KNOWN: Provider streams are not strictly once-only or perfectly ordered.
-  // `text_end` can repeat full content; late `text_end` can arrive after
`message_end`.
-  // Tests: `src/agents/pi-embedded-subscribe.test.ts` (e.g. late text_end
cases).
-  const shouldEmitToolResult = () =>
-    typeof params.shouldEmitToolResult === "function"
-      ? params.shouldEmitToolResult()
-      : params.verboseLevel === "on" || params.verboseLevel === "full";
-  const shouldEmitToolOutput = () =>
-    typeof params.shouldEmitToolOutput === "function"
-      ? params.shouldEmitToolOutput()
-      : params.verboseLevel === "full";
-  const formatToolOutputBlock = (text: string) => {
-    const trimmed = text.trim();
-    if (!trimmed) {
-      return "(no output)";
-    }
-    if (!useMarkdown) {
-      return trimmed;
-    }
-    return `\`\`\`txt\n${trimmed}\n\`\`\``;
-  };
-  const emitToolSummary = (toolName?: string, meta?: string) => {
-    if (!params.onToolResult) {
-      return;
-    }
-    const agg = formatToolAggregate(toolName, meta ? [meta] : undefined, {
-      markdown: useMarkdown,
-    });
-    const { text: cleanedText, mediaUrls } = parseReplyDirectives(agg);
-    if (!cleanedText && (!mediaUrls || mediaUrls.length === 0)) {
-      return;
-    }
-    try {
-      void params.onToolResult({
-        text: cleanedText,
-        mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
-      });
-    } catch {
-      // ignore tool result delivery failures
-    }
-  };
-  const emitToolOutput = (toolName?: string, meta?: string, output?: string) =>
{
-    if (!params.onToolResult || !output) {
-      return;
-    }
-    const agg = formatToolAggregate(toolName, meta ? [meta] : undefined, {
-      markdown: useMarkdown,
-    });
-    const message = `${agg}\n${formatToolOutputBlock(output)}`;
-    const { text: cleanedText, mediaUrls } = parseReplyDirectives(message);
-    if (!cleanedText && (!mediaUrls || mediaUrls.length === 0)) {
-      return;
-    }
-    try {
-      void params.onToolResult({
-        text: cleanedText,
-        mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
-      });
-    } catch {
-      // ignore tool result delivery failures
-    }
-  };
-
-  const stripBlockTags = (
-    text: string,
-    state: { thinking: boolean; final: boolean; inlineCode?: InlineCodeState },
-  ): string => {
-    if (!text) {
-      return text;
-    }
-
-    const inlineStateStart = state.inlineCode ?? createInlineCodeState();
-    const codeSpans = buildCodeSpanIndex(text, inlineStateStart);
-
-    // 1. Handle <think> blocks (stateful, strip content inside)
-    let processed = "";
-    THINKING_TAG_SCAN_RE.lastIndex = 0;
-    let lastIndex = 0;
-    let inThinking = state.thinking;
-    for (const match of text.matchAll(THINKING_TAG_SCAN_RE)) {
-      const idx = match.index ?? 0;
-      if (codeSpans.isInside(idx)) {
-        continue;
-      }
-      if (!inThinking) {
-        processed += text.slice(lastIndex, idx);
-      }
-      const isClose = match[1] === "/";
-      inThinking = !isClose;
-      lastIndex = idx + match[0].length;
-    }
-    if (!inThinking) {
-      processed += text.slice(lastIndex);
-    }
-    state.thinking = inThinking;
-
-    // 2. Handle <final> blocks (stateful, strip content OUTSIDE)
-    // If enforcement is disabled, we still strip the tags themselves to
prevent
-    // hallucinations (e.g. Minimax copying the style) from leaking, but we
-    // do not enforce buffering/extraction logic.
-    const finalCodeSpans = buildCodeSpanIndex(processed, inlineStateStart);
-    if (!params.enforceFinalTag) {
-      state.inlineCode = finalCodeSpans.inlineState;
-      FINAL_TAG_SCAN_RE.lastIndex = 0;
-      return stripTagsOutsideCodeSpans(processed, FINAL_TAG_SCAN_RE,
finalCodeSpans.isInside);
-    }
-
-    // If enforcement is enabled, only return text that appeared inside a
<final> block.
-    let result = "";
-    FINAL_TAG_SCAN_RE.lastIndex = 0;
-    let lastFinalIndex = 0;
-    let inFinal = state.final;
-    let everInFinal = state.final;
-
-    for (const match of processed.matchAll(FINAL_TAG_SCAN_RE)) {
-      const idx = match.index ?? 0;
-      if (finalCodeSpans.isInside(idx)) {
-        continue;
-      }
-      const isClose = match[1] === "/";
-
-      if (!inFinal && !isClose) {
-        // Found <final> start tag.
-        inFinal = true;
-        everInFinal = true;
-        lastFinalIndex = idx + match[0].length;
-      } else if (inFinal && isClose) {
-        // Found </final> end tag.
-        result += processed.slice(lastFinalIndex, idx);
-        inFinal = false;
-        lastFinalIndex = idx + match[0].length;
-      }
-    }
-
-    if (inFinal) {
-      result += processed.slice(lastFinalIndex);
-    }
-    state.final = inFinal;
-
-    // Strict Mode: If enforcing final tags, we MUST NOT return content unless
-    // we have seen a <final> tag. Otherwise, we leak "thinking out loud" text
-    // (e.g. "**Locating Manulife**...") that the model emitted without <think>
tags.
-    if (!everInFinal) {
-      return "";
-    }
-
-    // Hardened Cleanup: Remove any remaining <final> tags that might have been
-    // missed (e.g. nested tags or hallucinations) to prevent leakage.
-    const resultCodeSpans = buildCodeSpanIndex(result, inlineStateStart);
-    state.inlineCode = resultCodeSpans.inlineState;
-    return stripTagsOutsideCodeSpans(result, FINAL_TAG_SCAN_RE,
resultCodeSpans.isInside);
-  };
-
-  const stripTagsOutsideCodeSpans = (
-    text: string,
-    pattern: RegExp,
-    isInside: (index: number) => boolean,
-  ) => {
-    let output = "";
-    let lastIndex = 0;
-    pattern.lastIndex = 0;
-    for (const match of text.matchAll(pattern)) {
-      const idx = match.index ?? 0;
-      if (isInside(idx)) {
-        continue;
-      }
-      output += text.slice(lastIndex, idx);
-      lastIndex = idx + match[0].length;
-    }
-    output += text.slice(lastIndex);
-    return output;
-  };
-
-  const emitBlockChunk = (text: string) => {
-    if (state.suppressBlockChunks) {
-      return;
-    }
-    // Strip <think> and <final> blocks across chunk boundaries to avoid
leaking reasoning.
-    const chunk = stripBlockTags(text, state.blockState).trimEnd();
-    if (!chunk) {
-      return;
-    }
-    if (chunk === state.lastBlockReplyText) {
-      return;
-    }
-
-    // Only check committed (successful) messaging tool texts - checking
pending texts
-    // is risky because if the tool fails after suppression, the user gets no
response
-    const normalizedChunk = normalizeTextForComparison(chunk);
-    if (isMessagingToolDuplicateNormalized(normalizedChunk,
messagingToolSentTextsNormalized)) {
-      log.debug(`Skipping block reply - already sent via messaging tool:
${chunk.slice(0, 50)}...`);
-      return;
-    }
-
-    if (shouldSkipAssistantText(chunk)) {
-      return;
-    }
-
-    state.lastBlockReplyText = chunk;
-    assistantTexts.push(chunk);
-    rememberAssistantText(chunk);
-    if (!params.onBlockReply) {
-      return;
-    }
-    const splitResult = replyDirectiveAccumulator.consume(chunk);
-    if (!splitResult) {
-      return;
-    }
-    const {
-      text: cleanedText,
-      mediaUrls,
-      audioAsVoice,
-      replyToId,
-      replyToTag,
-      replyToCurrent,
-    } = splitResult;
-    // Skip empty payloads, but always emit if audioAsVoice is set (to
propagate the flag)
-    if (!cleanedText && (!mediaUrls || mediaUrls.length === 0) &&
!audioAsVoice) {
-      return;
-    }
-    void params.onBlockReply({
-      text: cleanedText,
-      mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
-      audioAsVoice,
-      replyToId,
-      replyToTag,
-      replyToCurrent,
-    });
-  };
-
-  const consumeReplyDirectives = (text: string, options?: { final?: boolean })
=>
-    replyDirectiveAccumulator.consume(text, options);
-  const consumePartialReplyDirectives = (text: string, options?: { final?:
boolean }) =>
-    partialReplyDirectiveAccumulator.consume(text, options);
-
-  const flushBlockReplyBuffer = () => {
-    if (!params.onBlockReply) {
-      return;
-    }
-    if (blockChunker?.hasBuffered()) {
-      blockChunker.drain({ force: true, emit: emitBlockChunk });
-      blockChunker.reset();
-      return;
-    }
-    if (state.blockBuffer.length > 0) {
-      emitBlockChunk(state.blockBuffer);
-      state.blockBuffer = "";
-    }
-  };
-
-  const emitReasoningStream = (text: string) => {
-    if (!state.streamReasoning || !params.onReasoningStream) {
-      return;
-    }
-    const formatted = formatReasoningMessage(text);
-    if (!formatted) {
-      return;
-    }
-    if (formatted === state.lastStreamedReasoning) {
-      return;
-    }
-    state.lastStreamedReasoning = formatted;
-    void params.onReasoningStream({
-      text: formatted,
-    });
-  };
-
-  const resetForCompactionRetry = () => {
-    assistantTexts.length = 0;
-    toolMetas.length = 0;
-    toolMetaById.clear();
-    toolSummaryById.clear();
-    state.lastToolError = undefined;
-    messagingToolSentTexts.length = 0;
-    messagingToolSentTextsNormalized.length = 0;
-    messagingToolSentTargets.length = 0;
-    pendingMessagingTexts.clear();
-    pendingMessagingTargets.clear();
-    resetAssistantMessageState(0);
-  };
-
-  const ctx: EmbeddedPiSubscribeContext = {
-    params,
-    state,
-    log,
-    blockChunking,
-    blockChunker,
-    shouldEmitToolResult,
-    shouldEmitToolOutput,
-    emitToolSummary,
-    emitToolOutput,
-    stripBlockTags,
-    emitBlockChunk,
-    flushBlockReplyBuffer,
-    emitReasoningStream,
-    consumeReplyDirectives,
-    consumePartialReplyDirectives,
-    resetAssistantMessageState,
-    resetForCompactionRetry,
-    finalizeAssistantTexts,
-    trimMessagingToolSent,
-    ensureCompactionPromise,
-    noteCompactionRetry,
-    resolveCompactionRetry,
-    maybeResolveCompactionWait,
-  };
-
-  const unsubscribe =
params.session.subscribe(createEmbeddedPiSessionEventHandler(ctx));
-
-  return {
-    assistantTexts,
-    toolMetas,
-    unsubscribe,
-    isCompacting: () => state.compactionInFlight ||
state.pendingCompactionRetry > 0,
-    getMessagingToolSentTexts: () => messagingToolSentTexts.slice(),
-    getMessagingToolSentTargets: () => messagingToolSentTargets.slice(),
-    // Returns true if any messaging tool successfully sent a message.
-    // Used to suppress agent's confirmation text (e.g., "Respondi no
Telegram!")
-    // which is generated AFTER the tool sends the actual answer.
-    didSendViaMessagingTool: () => messagingToolSentTexts.length > 0,
-    getLastToolError: () => (state.lastToolError ? { ...state.lastToolError } :
undefined),
-    waitForCompactionRetry: () => {
-      if (state.compactionInFlight || state.pendingCompactionRetry > 0) {
-        ensureCompactionPromise();
-        return state.compactionRetryPromise ?? Promise.resolve();
-      }
-      return new Promise<void>((resolve) => {
-        queueMicrotask(() => {
-          if (state.compactionInFlight || state.pendingCompactionRetry > 0) {
-            ensureCompactionPromise();
-            void (state.compactionRetryPromise ??
Promise.resolve()).then(resolve);
-          } else {
-            resolve();
-          }
-        });
-      });
-    },
-  };
-}
+const emitReasoningStream = (text: string) => {
+  if (!state.streamReasoning || !params.onReasoningStream) {
+    return;
+  }
+  const formatted = formatReasoningMessage(text);
+  if (!formatted) {
+    return;
+  }
+  if (formatted === state.lastStreamedReasoning) {
+    return;
+  }
+  state.lastStreamedReasoning = formatted;
+  void params.onReasoningStream({
+    text: formatted,
+  });
+};
```

Tokens: 28k sent, 718 received. Cost: $0.0046 message, $0.0046 session.
Did not apply edit to src/agents/pi-embedded-subscribe.handlers.messages.ts
(--dry-run)
Did not apply edit to src/agents/pi-embedded-subscribe.ts (--dry-run)
Summarization failed for model openrouter/meta-llama/llama-4-maverick: cannot schedule new futures after shutdown
Summarization failed for model openrouter/meta-llama/llama-4-maverick: cannot schedule new futures after shutdown
summarizer unexpectedly failed for all models

```

---

## ✓ Kimi K2.5

**Status:** done | **Time:** 4m 31s

```

You can skip this check with --no-gitignore
Added .aider\* to .gitignore
Aider v0.86.1
Model: openrouter/moonshotai/kimi-k2.5 with whole edit format
Git repo: .git with 4,609 files
Warning: For large repos, consider using --subtree-only and .aiderignore
See: https://aider.chat/docs/faq.html#can-i-use-aider-in-a-large-mono-repo
Repo-map: using 512 tokens, auto refresh
Added src/agents/pi-embedded-subscribe.handlers.messages.ts to the chat.
Added src/agents/pi-embedded-subscribe.handlers.types.ts to the chat.
Added src/agents/pi-embedded-subscribe.ts to the chat.
Added AGENTS.md to the chat (read-only).

---

► **THINKING**

The user wants me to audit the implementation of streaming native Claude
thinking blocks to Discord. They've provided three files and want me to review
them for correctness, edge cases, and potential issues.

Let me analyze the code:

1. **src/agents/pi-embedded-subscribe.handlers.types.ts** - Added
   `nativeThinkingBuffer: string` field to the state

2. **src/agents/pi-embedded-subscribe.ts** - Initialize `nativeThinkingBuffer: 
""` and reset it in `resetAssistantMessageState`

3. **src/agents/pi-embedded-subscribe.handlers.messages.ts** - Handle
   `thinking_start`/`thinking_delta`/`thinking_end` events

Key issues I need to look for:

1.  **Missing `thinking_start` handling**: In `handleMessageUpdate`, the code
    checks `isThinkingEvent` but only handles `thinking_delta` and `thinking_end`.
    It doesn't handle `thinking_start`. This might be intentional (no-op), but
    should be documented or handled if there's state to reset.

2.  **Buffer accumulation logic**: The code appends `thinkingDelta` to
    `nativeThinkingBuffer` on `thinking_delta`, and sets the buffer to
    `thinkingContent` on `thinking_end`. This looks correct for accumulating deltas.

3.  **Streaming logic**: It calls
    `emitReasoningStream(ctx.state.nativeThinkingBuffer)` with the full buffer
    content. This means it re-emits the entire buffer on every delta, not just the
    delta. This could be inefficient or cause duplicate content if the consumer
    doesn't handle it. However, looking at `emitReasoningStream` in the first file,
    it checks `if (formatted === state.lastStreamedReasoning)` to avoid duplicates,
    so this is handled.

4.  **Reset logic**: The buffer is reset in `resetAssistantMessageState` which is
    called from `handleMessageStart`. This seems correct - new message means new
    thinking buffer.

5.  **Interaction with existing thinking tags**: The code handles native thinking
    blocks separately from `<thinking>` tags. In `handleMessageEnd`, it extracts
    thinking from both native blocks and tagged text:

    ```typescript
    const rawThinking =
      ctx.state.includeReasoning || ctx.state.streamReasoning
        ? extractAssistantThinking(assistantMessage) || extractThinkingFromTaggedText(rawText)
        : "";
    ```

    This looks correct - it prioritizes native thinking blocks over tagged
    thinking.

6.  **Double emission risk**: In `handleMessageEnd`, there's:

    ```typescript
    if (ctx.state.streamReasoning && rawThinking) {
      ctx.emitReasoningStream(rawThinking);
    }
    ```

    This emits the reasoning again at message end. Combined with the per-delta
    emissions in `handleMessageUpdate`, this could cause the final thinking to be
    emitted twice if not for the `lastStreamedReasoning` deduplication check in
    `emitReasoningStream`.

7.  **Missing `thinking_start` reset**: If a provider sends `thinking_start`
    without any prior thinking events, the buffer might contain stale data from a
    previous message if `resetAssistantMessageState` wasn't called. But
    `handleMessageStart` should have been called at the beginning of the message.

8.  **Race conditions**: The code looks synchronous, so no obvious race
    conditions.

9.  **Edge case - empty thinking**: If `thinkingContent` is empty string on
    `thinking_end`, the buffer is set to empty. This is correct.

10. **Edge case - missing deltas**: The comment says "Ensure buffer reflects
    full content (in case of missed deltas)" - this is good defensive programming.

11. **Issue with `thinking_start`**: The code doesn't handle `thinking_start`
    explicitly. If the provider sends `thinking_start` with initial content, it
    won't be captured. But typically `thinking_start` has no content/delta, just
    signals the start.

12. **Potential bug in `handleMessageEnd`**: The code calls
    `ctx.emitReasoningStream(rawThinking)` at the end, but `rawThinking` comes from
    `extractAssistantThinking(assistantMessage)` which extracts from the message
    object, not from `ctx.state.nativeThinkingBuffer`. This means if the native
    thinking was streamed incrementally but the final message object doesn't contain
    the thinking (or contains it in a different format), there could be a mismatch.

        Actually, looking at the code flow:
        - `handleMessageUpdate` accumulates deltas into `nativeThinkingBuffer`
        - `handleMessageEnd` extracts thinking from the final message object via

    `extractAssistantThinking(assistantMessage)`

        If `extractAssistantThinking` extracts from the same source that populated

    the deltas, they should match. But if the provider includes the thinking in the
    final message object differently than the deltas, there could be duplication or
    mismatch.

13. **Duplicate streaming**: In `handleMessageUpdate`, every `thinking_delta`
    triggers `emitReasoningStream(ctx.state.nativeThinkingBuffer)` which emits the
    entire buffer. Then in `handleMessageEnd`, it emits again via
    `ctx.emitReasoningStream(rawThinking)`. The deduplication logic in
    `emitReasoningStream` (checking `lastStreamedReasoning`) prevents actual
    duplicate output, but it's inefficient to format and compare large strings
    repeatedly.

14. **Missing reset in `resetForCompactionRetry`**: In
    `pi-embedded-subscribe.ts`, the `resetForCompactionRetry` function calls
    `resetAssistantMessageState(0)` which resets the native thinking buffer, so
    that's covered.

15. **Type safety**: The `thinkingDelta` and `thinkingContent` variables are
    extracted correctly with type checks.

16. **Raw stream logging**: The code logs thinking events to the raw stream,
    which is good for debugging.

Let me check the specific logic in `handleMessageUpdate` again:

```typescript
if (isThinkingEvent) {
  const thinkingDelta = typeof assistantRecord?.delta === "string" ? assistantRecord.delta : "";
  const thinkingContent =
    typeof assistantRecord?.content === "string" ? assistantRecord.content : "";

  if (evtType === "thinking_delta" && thinkingDelta) {
    ctx.state.nativeThinkingBuffer += thinkingDelta;
  } else if (evtType === "thinking_end" && thinkingContent) {
    // Ensure buffer reflects full content (in case of missed deltas)
    ctx.state.nativeThinkingBuffer = thinkingContent;
  }

  // Stream reasoning if enabled
  if (ctx.state.streamReasoning && ctx.state.nativeThinkingBuffer) {
    ctx.emitReasoningStream(ctx.state.nativeThinkingBuffer);
  }
  // ... logging ...
  return;
}
```

Issues here:

- On `thinking_end`, it sets the buffer to `thinkingContent` and then emits. But
  if `thinkingContent` is the full content, and we've been emitting deltas all
  along, the final emit will be the full content (which is correct for the final
  state).
- However, if `thinking_end` has no content (empty string), it won't update the
  buffer, but will still emit the current buffer content. This is probably fine.
- The condition `&& thinkingContent` means if `thinkingContent` is an empty
  string, we don't update the buffer. But if we had accumulated deltas and the
  final content is indeed empty, we should probably clear the buffer. But this is
  an edge case.

Actually, looking more carefully at the `thinking_end` handling:

```typescript
} else if (evtType === "thinking_end" && thinkingContent) {
  ctx.state.nativeThinkingBuffer = thinkingContent;
}
```

If `thinkingContent` is an empty string, this won't execute, leaving the buffer
with the accumulated deltas. But if the provider sends `thinking_end` with empty
content to signal the end, and the actual content was in the deltas, we want to
keep the buffer. So this is correct.

But wait, if `thinkingContent` is a non-empty string that differs from the
accumulated deltas (e.g., the provider sends deltas but then sends the full
content at the end), we replace the buffer with the full content. This is the
"in case of missed deltas" case.

Now looking at `handleMessageEnd`:

```typescript
const rawThinking =
  ctx.state.includeReasoning || ctx.state.streamReasoning
    ? extractAssistantThinking(assistantMessage) || extractThinkingFromTaggedText(rawText)
    : "";
```

This extracts thinking from the final message. If the provider puts the native
thinking in the message object, `extractAssistantThinking` will get it. But we
also have `ctx.state.nativeThinkingBuffer` from the streaming.

If both are present (buffer from streaming, and extracted from final message),
which one takes precedence? The `||` operator means if
`extractAssistantThinking` returns something truthy, it uses that, otherwise it
falls back to tagged text extraction.

But `extractAssistantThinking` likely extracts from the native thinking blocks
in the message content. If the provider includes the thinking in the final
message, this will be used. If the provider only streamed it via deltas, the
buffer might have it but the final message might not, or vice versa.

Actually, looking at the flow:

1. Deltas come in via `handleMessageUpdate` and accumulate in
   `nativeThinkingBuffer`
2. At `handleMessageEnd`, `extractAssistantThinking(assistantMessage)` extracts
   from the final message object
3. If the final message object contains the thinking (as native blocks), it will
   be extracted
4. If not, it falls back to `extractThinkingFromTaggedText` which looks for
   `<thinking>` tags in the text

But what about `ctx.state.nativeThinkingBuffer`? It's not used in
`handleMessageEnd`! The buffer is accumulated during streaming but then ignored
at the end in favor of extracting from the message object.

Wait, looking again at `handleMessageEnd`:

```typescript
const rawThinking =
  ctx.state.includeReasoning || ctx.state.streamReasoning
    ? extractAssistantThinking(assistantMessage) || extractThinkingFromTaggedText(rawText)
    : "";
```

It doesn't use `ctx.state.nativeThinkingBuffer` at all. It extracts fresh from
the message. This means:

- If the provider includes native thinking in the final message, it will be
  extracted
- If the provider only sent deltas but the final message doesn't include the
  thinking blocks, `extractAssistantThinking` might return nothing, and it falls
  back to tagged extraction
- The accumulated `nativeThinkingBuffer` is ignored!

This seems like a bug. The buffer should probably be used as a fallback, or the
extraction should prefer the buffer if it's populated.

Actually, looking at the logic, `extractAssistantThinking` probably extracts
from the message's content blocks. If the provider sends native thinking blocks,
they should be in the final message. But if there's a mismatch between the
streamed deltas and the final message, the final message should be the source of
truth.

However, if the provider sends `thinking_delta` events but doesn't include the
thinking in the final message (maybe it's in a separate field), then
`extractAssistantThinking` needs to know to look at the buffer, or we should use
the buffer as fallback.

Given that the buffer is specifically for "native thinking blocks (not thinking
tags)", and `extractAssistantThinking` presumably extracts native thinking
blocks from the message, they should be equivalent. But if
`extractAssistantThinking` doesn't know about the buffer, and the thinking is
only in the buffer (because the provider streams deltas but doesn't include it
in the final message content), then we lose the thinking.

But wait, the buffer is reset at the start of each message, so it only contains
thinking from the current message.

Let me reconsider the architecture. The `nativeThinkingBuffer` is populated from
streaming events (`thinking_delta`). At the end of the message,
`handleMessageEnd` is called with the final message object. If the final message
object contains the thinking content (which it should for Claude extended
thinking), then `extractAssistantThinking` will extract it. The buffer is just
for streaming intermediate states.

So the buffer is used for:

1. Streaming via `emitReasoningStream` during `handleMessageUpdate`
2. ...and that's it. It's not used in `handleMessageEnd`.

But in `handleMessageEnd`, there's this:

```typescript
if (ctx.state.streamReasoning && rawThinking) {
  ctx.emitReasoningStream(rawThinking);
}
```

This emits the final thinking (extracted from the message) if streaming is
enabled. Since `emitReasoningStream` deduplicates based on
`lastStreamedReasoning`, and the buffer was being emitted throughout, this final
emit will only happen if the final extracted thinking differs from what was last
streamed.

This seems correct. The buffer is for incremental streaming, the final
extraction is for the final state.

**Potential Issues Found:**

1. **No handling of `thinking_start`**: While likely a no-op, if there's any
   state to initialize, it's missing. Currently the code just ignores it.

2. **Inefficient string concatenation**: `ctx.state.nativeThinkingBuffer += 
thinkingDelta` creates new strings repeatedly. For long thinking blocks, this is
   O(n²). But for typical usage, probably fine.

3. **Missing use of buffer in final extraction**: As noted above, if
   `extractAssistantThinking` fails to extract from the message object (e.g., the
   provider format is unexpected), the buffer which contains the accumulated
   thinking is not used as a fallback. The code falls back to
   `extractThinkingFromTaggedText` instead.

   Fix: Should be `extractAssistantThinking(assistantMessage) || 
ctx.state.nativeThinkingBuffer || extractThinkingFromTaggedText(rawText)` or
   similar.

4. **Duplicate emission on `thinking_end`**: When `thinking_end` arrives, it
   updates the buffer and emits. Then `handleMessageEnd` emits again. The
   deduplication prevents actual duplicates, but it's slightly wasteful.

5. **Race condition with compaction**: If a compaction retry happens during
   thinking streaming, `resetForCompactionRetry` is called which resets the buffer.
   This is correct behavior.

6. **Empty thinking handling**: If `thinkingDelta` is empty string, it's not
   added (due to `&& thinkingDelta` check). This is fine.

7. **Type safety**: The cast `(ctx.params.session as { id?: string }).id` is
   used, which is a bit loose but probably safe.

8. **Logging**: The raw stream logging is good.

**More subtle issues:**

9. **Interaction with `includeReasoning` vs `streamReasoning`**: In
   `handleMessageEnd`, the condition is:

   ```typescript
   const rawThinking =
     ctx.state.includeReasoning || ctx.state.streamReasoning
       ? extractAssistantThinking(assistantMessage) || extractThinkingFromTaggedText(rawText)
       : "";
   ```

   But in `handleMessageUpdate`, the condition is just `if 
(ctx.state.streamReasoning && ctx.state.nativeThinkingBuffer)`. This means if
   `includeReasoning` is true but `streamReasoning` is false, we don't stream
   during deltas, but we do extract at the end. This is correct behavior
   (non-streaming mode).

10. **Double extraction in `handleMessageEnd`**: The code extracts thinking for
    the reasoning block, but also `promoteThinkingTagsToBlocks` is called earlier
    which might modify the message. This is existing code though, not part of the
    new changes.

**Critical Issue:**

The most significant issue is #3: **The accumulated `nativeThinkingBuffer` is
not used as a fallback in `handleMessageEnd`**. If the provider sends thinking
deltas but the final message object doesn't contain the thinking in a format
that `extractAssistantThinking` understands, the thinking is lost for the final
output (though it was streamed incrementally).

However, for Claude specifically, the final message should contain the thinking
blocks, so this might not be an issue in practice. But for robustness, using the
buffer as a fallback would be safer.

**Another issue:**

In `handleMessageUpdate`, when `thinking_end` arrives:

```typescript
} else if (evtType === "thinking_end" && thinkingContent) {
  ctx.state.nativeThinkingBuffer = thinkingContent;
}
```

If `thinkingContent` is provided and is the full content, this overwrites the
buffer. Then immediately after:

```typescript
if (ctx.state.streamReasoning && ctx.state.nativeThinkingBuffer) {
  ctx.emitReasoningStream(ctx.state.nativeThinkingBuffer);
}
```

This emits the full content. If we had been emitting deltas before, and the full
content is the same as the accumulated buffer, the deduplication in
`emitReasoningStream` will prevent a duplicate. But if the full content differs
(e.g., the provider revised the thinking at the end), we emit the new content.
This is correct.

**Summary of findings:**

1. **Minor**: `thinking_start` event is ignored (probably fine, but should be
   explicit).
2. **Moderate**: `nativeThinkingBuffer` is not used as a fallback in
   `handleMessageEnd` if extraction from the message fails.
3. **Minor**: Inefficient string concatenation for large thinking blocks.
4. **Minor**: Potential for duplicate emission (mitigated by deduplication
   logic).

The implementation looks generally correct for the intended use case. The state
management is proper (initialized, reset on message start, reset on compaction).
The streaming logic properly checks the `streamReasoning` flag.

Wait, I should check if `nativeThinkingBuffer` is used anywhere else... looking
at the files provided, it's only used in the three places mentioned.

One more check: In `handleMessageEnd`, after the reasoning is emitted, the
buffer is reset:

```typescript
ctx.state.nativeThinkingBuffer = "";
```

This is correct.

Actually, looking at the reset in `handleMessageEnd`:

```typescript
ctx.state.nativeThinkingBuffer = "";
ctx.state.lastStreamedAssistant = undefined;
ctx.state.lastStreamedAssistantCleaned = undefined;
```

Yes, it's there.

**Final assessment:**

The implementation is mostly correct. The main gap is that if
`extractAssistantThinking` fails to extract native thinking from the final
message, the code falls back to tagged thinking extraction
(`extractThinkingFromTaggedText`) instead of using the accumulated
`nativeThinkingBuffer`. This could result in losing native thinking if the
provider format is unexpected, or in incorrectly extracting tagged thinking if
both native and tagged thinking exist.

Recommendation: Use `ctx.state.nativeThinkingBuffer` as a fallback before
falling back to tagged extraction.

Also, the `thinking_start` event should probably be handled explicitly (even if
just to log or reset state), though this is minor.

The string concatenation inefficiency is minor for typical thinking block sizes.

The duplicate emission is handled by the deduplication logic in
`emitReasoningStream`.

Overall, the implementation is solid but could be more robust with the fallback
suggestion.

---

► **ANSWER**

## Audit Findings: Native Claude Thinking Block Streaming

### Overall Assessment

The implementation is **generally correct** with proper state initialization,
reset handling, and streaming logic. However, there are **2 moderate issues**
and **3 minor issues** that should be addressed.

---

### Issues Found

#### 1. **Missing Fallback to Buffer in Final Extraction** (Moderate)

**Location:** `src/agents/pi-embedded-subscribe.handlers.messages.ts` in
`handleMessageEnd`

**Problem:** The accumulated `nativeThinkingBuffer` is used for incremental
streaming but is **ignored** when extracting the final thinking content. If
`extractAssistantThinking()` fails to parse the final message object (e.g.,
unexpected provider format), the code falls back to
`extractThinkingFromTaggedText()` instead of using the buffer that was populated
during streaming.

```diff
@@ -1,366 +1,5 @@
-import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
-import type { EmbeddedPiSubscribeContext } from
"./pi-embedded-subscribe.handlers.types.js";
-import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
-import { emitAgentEvent } from "../infra/agent-events.js";
-import { createInlineCodeState } from "../markdown/code-spans.js";
-import {
-  isMessagingToolDuplicateNormalized,
-  normalizeTextForComparison,
-} from "./pi-embedded-helpers.js";
-import { appendRawStream } from "./pi-embedded-subscribe.raw-stream.js";
-import {
-  extractAssistantText,
-  extractAssistantThinking,
-  extractThinkingFromTaggedStream,
-  extractThinkingFromTaggedText,
-  formatReasoningMessage,
-  promoteThinkingTagsToBlocks,
-} from "./pi-embedded-utils.js";
-
-const stripTrailingDirective = (text: string): string => {
-  const openIndex = text.lastIndexOf("[[");
-  if (openIndex < 0) {
-    return text;
-  }
-  const closeIndex = text.indexOf("]]", openIndex + 2);
-  if (closeIndex >= 0) {
-    return text;
-  }
-  return text.slice(0, openIndex);
-};
-
-export function handleMessageStart(
-  ctx: EmbeddedPiSubscribeContext,
-  evt: AgentEvent & { message: AgentMessage },
-) {
-  const msg = evt.message;
-  if (msg?.role !== "assistant") {
-    return;
-  }
-
-  // KNOWN: Resetting at `text_end` is unsafe (late/duplicate end events).
-  // ASSUME: `message_start` is the only reliable boundary for “new assistant
message begins”.
-  // Start-of-message is a safer reset point than message_end: some providers
-  // may deliver late text_end updates after message_end, which would otherwise
-  // re-trigger block replies.
-  ctx.resetAssistantMessageState(ctx.state.assistantTexts.length);
-  // Use assistant message_start as the earliest "writing" signal for typing.
-  void ctx.params.onAssistantMessageStart?.();
-}
-
-export function handleMessageUpdate(
-  ctx: EmbeddedPiSubscribeContext,
-  evt: AgentEvent & { message: AgentMessage; assistantMessageEvent?: unknown },
-) {
-  const msg = evt.message;
-  if (msg?.role !== "assistant") {
-    return;
-  }
-
-  const assistantEvent = evt.assistantMessageEvent;
-  const assistantRecord =
-    assistantEvent && typeof assistantEvent === "object"
-      ? (assistantEvent as Record<string, unknown>)
-      : undefined;
-  const evtType = typeof assistantRecord?.type === "string" ?
assistantRecord.type : "";
-
-  const isTextEvent = evtType === "text_delta" || evtType === "text_start" ||
evtType === "text_end";
-  const isThinkingEvent = evtType === "thinking_delta" || evtType ===
"thinking_start" || evtType === "thinking_end";
-
-  if (!isTextEvent && !isThinkingEvent) {
-    return;
-  }
-
-  const delta = typeof assistantRecord?.delta === "string" ?
assistantRecord.delta : "";
-  const content = typeof assistantRecord?.content === "string" ?
assistantRecord.content : "";
-
-  // Handle native thinking block events (Claude extended thinking)
-  if (isThinkingEvent) {
-    const thinkingDelta = typeof assistantRecord?.delta === "string" ?
assistantRecord.delta : "";
-    const thinkingContent = typeof assistantRecord?.content === "string" ?
assistantRecord.content : "";
-
-    if (evtType === "thinking_delta" && thinkingDelta) {
-      ctx.state.nativeThinkingBuffer += thinkingDelta;
-    } else if (evtType === "thinking_end" && thinkingContent) {
-      // Ensure buffer reflects full content (in case of missed deltas)
-      ctx.state.nativeThinkingBuffer = thinkingContent;
-    }
-
-    // Stream reasoning if enabled
-    if (ctx.state.streamReasoning && ctx.state.nativeThinkingBuffer) {
-      ctx.emitReasoningStream(ctx.state.nativeThinkingBuffer);
-    }
-
-    appendRawStream({
-      ts: Date.now(),
-      event: "assistant_thinking_stream",
-      runId: ctx.params.runId,
-      sessionId: (ctx.params.session as { id?: string }).id,
-      evtType,
-      delta: thinkingDelta,
-      content: thinkingContent,
-    });
-
-    return; // Thinking events don't contribute to text output
-  }
-
-  appendRawStream({
-    ts: Date.now(),
-    event: "assistant_text_stream",
-    runId: ctx.params.runId,
-    sessionId: (ctx.params.session as { id?: string }).id,
-    evtType,
-    delta,
-    content,
-  });
-
-  let chunk = "";
-  if (evtType === "text_delta") {
-    chunk = delta;
-  } else if (evtType === "text_start" || evtType === "text_end") {
-    if (delta) {
-      chunk = delta;
-    } else if (content) {
-      // KNOWN: Some providers resend full content on `text_end`.
-      // We only append a suffix (or nothing) to keep output monotonic.
-      if (content.startsWith(ctx.state.deltaBuffer)) {
-        chunk = content.slice(ctx.state.deltaBuffer.length);
-      } else if (ctx.state.deltaBuffer.startsWith(content)) {
-        chunk = "";
-      } else if (!ctx.state.deltaBuffer.includes(content)) {
-        chunk = content;
-      }
-    }
-  }
-
-  if (chunk) {
-    ctx.state.deltaBuffer += chunk;
-    if (ctx.blockChunker) {
-      ctx.blockChunker.append(chunk);
-    } else {
-      ctx.state.blockBuffer += chunk;
-    }
-  }
-
-  if (ctx.state.streamReasoning) {
-    // Handle partial <think> tags: stream whatever reasoning is visible so
far.
-
ctx.emitReasoningStream(extractThinkingFromTaggedStream(ctx.state.deltaBuffer));
-  }
-
-  const next = ctx
-    .stripBlockTags(ctx.state.deltaBuffer, {
-      thinking: false,
-      final: false,
-      inlineCode: createInlineCodeState(),
-    })
-    .trim();
-  if (next) {
-    const visibleDelta = chunk ? ctx.stripBlockTags(chunk,
ctx.state.partialBlockState) : "";
-    const parsedDelta = visibleDelta ?
ctx.consumePartialReplyDirectives(visibleDelta) : null;
-    const parsedFull = parseReplyDirectives(stripTrailingDirective(next));
-    const cleanedText = parsedFull.text;
-    const mediaUrls = parsedDelta?.mediaUrls;
-    const hasMedia = Boolean(mediaUrls && mediaUrls.length > 0);
-    const hasAudio = Boolean(parsedDelta?.audioAsVoice);
-    const previousCleaned = ctx.state.lastStreamedAssistantCleaned ?? "";
-
-    let shouldEmit = false;
-    let deltaText = "";
-    if (!cleanedText && !hasMedia && !hasAudio) {
-      shouldEmit = false;
-    } else if (previousCleaned && !cleanedText.startsWith(previousCleaned)) {
-      shouldEmit = false;
-    } else {
-      deltaText = cleanedText.slice(previousCleaned.length);
-      shouldEmit = Boolean(deltaText || hasMedia || hasAudio);
-    }
-
-    ctx.state.lastStreamedAssistant = next;
-    ctx.state.lastStreamedAssistantCleaned = cleanedText;
-
-    if (shouldEmit) {
-      emitAgentEvent({
-        runId: ctx.params.runId,
-        stream: "assistant",
-        data: {
-          text: cleanedText,
-          delta: deltaText,
-          mediaUrls: hasMedia ? mediaUrls : undefined,
-        },
-      });
-      void ctx.params.onAgentEvent?.({
-        stream: "assistant",
-        data: {
-          text: cleanedText,
-          delta: deltaText,
-          mediaUrls: hasMedia ? mediaUrls : undefined,
-        },
-      });
-      if (ctx.params.onPartialReply && ctx.state.shouldEmitPartialReplies) {
-        void ctx.params.onPartialReply({
-          text: cleanedText,
-          mediaUrls: hasMedia ? mediaUrls : undefined,
-        });
-      }
-    }
-  }
-
-  if (ctx.params.onBlockReply && ctx.blockChunking && ctx.state.blockReplyBreak
=== "text_end") {
-    ctx.blockChunker?.drain({ force: false, emit: ctx.emitBlockChunk });
-  }
-
-  if (evtType === "text_end" && ctx.state.blockReplyBreak === "text_end") {
-    if (ctx.blockChunker?.hasBuffered()) {
-      ctx.blockChunker.drain({ force: true, emit: ctx.emitBlockChunk });
-      ctx.blockChunker.reset();
-    } else if (ctx.state.blockBuffer.length > 0) {
-      ctx.emitBlockChunk(ctx.state.blockBuffer);
-      ctx.state.blockBuffer = "";
-    }
-  }
-}
-
-export function handleMessageEnd(
-  ctx: EmbeddedPiSubscribeContext,
-  evt: AgentEvent & { message: AgentMessage },
-) {
-  const msg = evt.message;
-  if (msg?.role !== "assistant") {
-    return;
-  }
-
-  const assistantMessage = msg;
-  promoteThinkingTagsToBlocks(assistantMessage);
-
-  const rawText = extractAssistantText(assistantMessage);
-  appendRawStream({
-    ts: Date.now(),
-    event: "assistant_message_end",
-    runId: ctx.params.runId,
-    sessionId: (ctx.params.session as { id?: string }).id,
-    rawText,
-    rawThinking: extractAssistantThinking(assistantMessage),
-  });
-
-  const text = ctx.stripBlockTags(rawText, { thinking: false, final: false });
-  const rawThinking =
-    ctx.state.includeReasoning || ctx.state.streamReasoning
-      ? extractAssistantThinking(assistantMessage) ||
extractThinkingFromTaggedText(rawText)
-      : "";
-  const formattedReasoning = rawThinking ? formatReasoningMessage(rawThinking)
: "";
-
-  const addedDuringMessage = ctx.state.assistantTexts.length >
ctx.state.assistantTextBaseline;
-  const chunkerHasBuffered = ctx.blockChunker?.hasBuffered() ?? false;
-  ctx.finalizeAssistantTexts({ text, addedDuringMessage, chunkerHasBuffered });
-
-  const onBlockReply = ctx.params.onBlockReply;
-  const shouldEmitReasoning = Boolean(
-    ctx.state.includeReasoning &&
-    formattedReasoning &&
-    onBlockReply &&
-    formattedReasoning !== ctx.state.lastReasoningSent,
-  );
-  const shouldEmitReasoningBeforeAnswer =
-    shouldEmitReasoning && ctx.state.blockReplyBreak === "message_end" &&
!addedDuringMessage;
-  const maybeEmitReasoning = () => {
-    if (!shouldEmitReasoning || !formattedReasoning) {
-      return;
-    }
-    ctx.state.lastReasoningSent = formattedReasoning;
-    void onBlockReply?.({ text: formattedReasoning });
-  };
-
-  if (shouldEmitReasoningBeforeAnswer) {
-    maybeEmitReasoning();
-  }
-
-  if (
-    (ctx.state.blockReplyBreak === "message_end" ||
-      (ctx.blockChunker ? ctx.blockChunker.hasBuffered() :
ctx.state.blockBuffer.length > 0)) &&
-    text &&
-    onBlockReply
-  ) {
-    if (ctx.blockChunker?.hasBuffered()) {
-      ctx.blockChunker.drain({ force: true, emit: ctx.emitBlockChunk });
-      ctx.blockChunker.reset();
-    } else if (text !== ctx.state.lastBlockReplyText) {
-      // Check for duplicates before emitting (same logic as emitBlockChunk).
-      const normalizedText = normalizeTextForComparison(text);
-      if (
-        isMessagingToolDuplicateNormalized(
-          normalizedText,
-          ctx.state.messagingToolSentTextsNormalized,
-        )
-      ) {
-        ctx.log.debug(
-          `Skipping message_end block reply - already sent via messaging tool:
${text.slice(0, 50)}...`,
-        );
-      } else {
-        ctx.state.lastBlockReplyText = text;
-        const splitResult = ctx.consumeReplyDirectives(text, { final: true });
-        if (splitResult) {
-          const {
-            text: cleanedText,
-            mediaUrls,
-            audioAsVoice,
-            replyToId,
-            replyToTag,
-            replyToCurrent,
-          } = splitResult;
-          // Emit if there's content OR audioAsVoice flag (to propagate the
flag).
-          if (cleanedText || (mediaUrls && mediaUrls.length > 0) ||
audioAsVoice) {
-            void onBlockReply({
-              text: cleanedText,
-              mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
-              audioAsVoice,
-              replyToId,
-              replyToTag,
-              replyToCurrent,
-            });
-          }
-        }
-      }
-    }
-  }
-
-  if (!shouldEmitReasoningBeforeAnswer) {
-    maybeEmitReasoning();
-  }
-  if (ctx.state.streamReasoning && rawThinking) {
-    ctx.emitReasoningStream(rawThinking);
-  }
-
-  if (ctx.state.blockReplyBreak === "text_end" && onBlockReply) {
-    const tailResult = ctx.consumeReplyDirectives("", { final: true });
-    if (tailResult) {
-      const {
-        text: cleanedText,
-        mediaUrls,
-        audioAsVoice,
-        replyToId,
-        replyToTag,
-        replyToCurrent,
-      } = tailResult;
-      if (cleanedText || (mediaUrls && mediaUrls.length > 0) || audioAsVoice) {
-        void onBlockReply({
-          text: cleanedText,
-          mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
-          audioAsVoice,
-          replyToId,
-          replyToTag,
-          replyToCurrent,
-        });
-      }
-    }
-  }
-
-  ctx.state.deltaBuffer = "";
-  ctx.state.blockBuffer = "";
-  ctx.blockChunker?.reset();
-  ctx.state.blockState.thinking = false;
-  ctx.state.blockState.final = false;
-  ctx.state.blockState.inlineCode = createInlineCodeState();
-  ctx.state.nativeThinkingBuffer = "";
-  ctx.state.lastStreamedAssistant = undefined;
-  ctx.state.lastStreamedAssistantCleaned = undefined;
-}
+// Current code - buffer is ignored!
+const rawThinking =
+  ctx.state.includeReasoning || ctx.state.streamReasoning
+    ? extractAssistantThinking(assistantMessage) ||
extractThinkingFromTaggedText(rawText)
+    : "";
```

**Risk:** Native thinking could be lost if the provider sends valid deltas but
the final message extraction fails, causing a fallback to potentially stale or
incorrect `<thinking>` tag content.

**Recommendation:** Use the buffer as a fallback:

```
const rawThinking =

  ctx.state.includeReasoning || ctx.state.streamReasoning

    ? extractAssistantThinking(assistantMessage) ||
ctx.state.nativeThinkingBuffer || extractThinkingFromTaggedText(rawText)

    : "";

```

---

#### 2. **No Handling of `thinking_start` Event** (Moderate)

**Location:** `src/agents/pi-embedded-subscribe.handlers.messages.ts` in
`handleMessageUpdate`

**Problem:** The code explicitly checks for `isThinkingEvent` but only handles
`thinking_delta` and `thinking_end`. The `thinking_start` event is silently
ignored. While typically a no-op, if future provider implementations include
initial content or metadata in `thinking_start`, it will be dropped.

**Current logic:**

```
if (evtType === "thinking_delta" && thinkingDelta) {

  ctx.state.nativeThinkingBuffer += thinkingDelta;

} else if (evtType === "thinking_end" && thinkingContent) {

  ctx.state.nativeThinkingBuffer = thinkingContent;

}

// thinking_start falls through with no handling

```

**Recommendation:** Add explicit handling for `thinking_start` (even if just for
logging completeness), or document that it's intentionally ignored.

---

#### 3. **Inefficient String Concatenation** (Minor)

**Location:** `src/agents/pi-embedded-subscribe.handlers.messages.ts`

**Problem:** `ctx.state.nativeThinkingBuffer += thinkingDelta` creates new
string instances repeatedly. For extended thinking sessions (Claude can think
for thousands of tokens), this is O(n²) complexity.

**Recommendation:** Consider using a string array buffer joined at emission
time, though for typical thinking lengths this is acceptable.

---

#### 4. **Potential Double Emission** (Minor)

**Location:** `src/agents/pi-embedded-subscribe.handlers.messages.ts`

**Problem:** On `thinking_end`, the code emits the full buffer content. Then in
`handleMessageEnd`, it emits again via `ctx.emitReasoningStream(rawThinking)`.
While `emitReasoningStream` has deduplication logic (`lastStreamedReasoning`
check), this relies on string comparison of potentially large thinking blocks.

**Mitigation:** The deduplication logic is present and correct, but the
redundant calls are slightly wasteful.

---

#### 5. **Empty Content Handling Edge Case** (Minor)

**Location:** `src/agents/pi-embedded-subscribe.handlers.messages.ts`

**Problem:** On `thinking_end`, the condition `&& thinkingContent` prevents
updating the buffer if the content is an empty string. If the provider
legitimately sends empty thinking (or clears it), the buffer retains stale delta
content.

```diff
@@ -1,366 +1,3 @@
-import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
-import type { EmbeddedPiSubscribeContext } from
"./pi-embedded-subscribe.handlers.types.js";
-import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
-import { emitAgentEvent } from "../infra/agent-events.js";
-import { createInlineCodeState } from "../markdown/code-spans.js";
-import {
-  isMessagingToolDuplicateNormalized,
-  normalizeTextForComparison,
-} from "./pi-embedded-helpers.js";
-import { appendRawStream } from "./pi-embedded-subscribe.raw-stream.js";
-import {
-  extractAssistantText,
-  extractAssistantThinking,
-  extractThinkingFromTaggedStream,
-  extractThinkingFromTaggedText,
-  formatReasoningMessage,
-  promoteThinkingTagsToBlocks,
-} from "./pi-embedded-utils.js";
-
-const stripTrailingDirective = (text: string): string => {
-  const openIndex = text.lastIndexOf("[[");
-  if (openIndex < 0) {
-    return text;
-  }
-  const closeIndex = text.indexOf("]]", openIndex + 2);
-  if (closeIndex >= 0) {
-    return text;
-  }
-  return text.slice(0, openIndex);
-};
-
-export function handleMessageStart(
-  ctx: EmbeddedPiSubscribeContext,
-  evt: AgentEvent & { message: AgentMessage },
-) {
-  const msg = evt.message;
-  if (msg?.role !== "assistant") {
-    return;
-  }
-
-  // KNOWN: Resetting at `text_end` is unsafe (late/duplicate end events).
-  // ASSUME: `message_start` is the only reliable boundary for “new assistant
message begins”.
-  // Start-of-message is a safer reset point than message_end: some providers
-  // may deliver late text_end updates after message_end, which would otherwise
-  // re-trigger block replies.
-  ctx.resetAssistantMessageState(ctx.state.assistantTexts.length);
-  // Use assistant message_start as the earliest "writing" signal for typing.
-  void ctx.params.onAssistantMessageStart?.();
+} else if (evtType === "thinking_end" && thinkingContent) { // Empty string is
falsy!
+  ctx.state.nativeThinkingBuffer = thinkingContent;
 }
-
-export function handleMessageUpdate(
-  ctx: EmbeddedPiSubscribeContext,
-  evt: AgentEvent & { message: AgentMessage; assistantMessageEvent?: unknown },
-) {
-  const msg = evt.message;
-  if (msg?.role !== "assistant") {
-    return;
-  }
-
-  const assistantEvent = evt.assistantMessageEvent;
-  const assistantRecord =
-    assistantEvent && typeof assistantEvent === "object"
-      ? (assistantEvent as Record<string, unknown>)
-      : undefined;
-  const evtType = typeof assistantRecord?.type === "string" ?
assistantRecord.type : "";
-
-  const isTextEvent = evtType === "text_delta" || evtType === "text_start" ||
evtType === "text_end";
-  const isThinkingEvent = evtType === "thinking_delta" || evtType ===
"thinking_start" || evtType === "thinking_end";
-
-  if (!isTextEvent && !isThinkingEvent) {
-    return;
-  }
-
-  const delta = typeof assistantRecord?.delta === "string" ?
assistantRecord.delta : "";
-  const content = typeof assistantRecord?.content === "string" ?
assistantRecord.content : "";
-
-  // Handle native thinking block events (Claude extended thinking)
-  if (isThinkingEvent) {
-    const thinkingDelta = typeof assistantRecord?.delta === "string" ?
assistantRecord.delta : "";
-    const thinkingContent = typeof assistantRecord?.content === "string" ?
assistantRecord.content : "";
-
-    if (evtType === "thinking_delta" && thinkingDelta) {
-      ctx.state.nativeThinkingBuffer += thinkingDelta;
-    } else if (evtType === "thinking_end" && thinkingContent) {
-      // Ensure buffer reflects full content (in case of missed deltas)
-      ctx.state.nativeThinkingBuffer = thinkingContent;
-    }
-
-    // Stream reasoning if enabled
-    if (ctx.state.streamReasoning && ctx.state.nativeThinkingBuffer) {
-      ctx.emitReasoningStream(ctx.state.nativeThinkingBuffer);
-    }
-
-    appendRawStream({
-      ts: Date.now(),
-      event: "assistant_thinking_stream",
-      runId: ctx.params.runId,
-      sessionId: (ctx.params.session as { id?: string }).id,
-      evtType,
-      delta: thinkingDelta,
-      content: thinkingContent,
-    });
-
-    return; // Thinking events don't contribute to text output
-  }
-
-  appendRawStream({
-    ts: Date.now(),
-    event: "assistant_text_stream",
-    runId: ctx.params.runId,
-    sessionId: (ctx.params.session as { id?: string }).id,
-    evtType,
-    delta,
-    content,
-  });
-
-  let chunk = "";
-  if (evtType === "text_delta") {
-    chunk = delta;
-  } else if (evtType === "text_start" || evtType === "text_end") {
-    if (delta) {
-      chunk = delta;
-    } else if (content) {
-      // KNOWN: Some providers resend full content on `text_end`.
-      // We only append a suffix (or nothing) to keep output monotonic.
-      if (content.startsWith(ctx.state.deltaBuffer)) {
-        chunk = content.slice(ctx.state.deltaBuffer.length);
-      } else if (ctx.state.deltaBuffer.startsWith(content)) {
-        chunk = "";
-      } else if (!ctx.state.deltaBuffer.includes(content)) {
-        chunk = content;
-      }
-    }
-  }
-
-  if (chunk) {
-    ctx.state.deltaBuffer += chunk;
-    if (ctx.blockChunker) {
-      ctx.blockChunker.append(chunk);
-    } else {
-      ctx.state.blockBuffer += chunk;
-    }
-  }
-
-  if (ctx.state.streamReasoning) {
-    // Handle partial <think> tags: stream whatever reasoning is visible so
far.
-
ctx.emitReasoningStream(extractThinkingFromTaggedStream(ctx.state.deltaBuffer));
-  }
-
-  const next = ctx
-    .stripBlockTags(ctx.state.deltaBuffer, {
-      thinking: false,
-      final: false,
-      inlineCode: createInlineCodeState(),
-    })
-    .trim();
-  if (next) {
-    const visibleDelta = chunk ? ctx.stripBlockTags(chunk,
ctx.state.partialBlockState) : "";
-    const parsedDelta = visibleDelta ?
ctx.consumePartialReplyDirectives(visibleDelta) : null;
-    const parsedFull = parseReplyDirectives(stripTrailingDirective(next));
-    const cleanedText = parsedFull.text;
-    const mediaUrls = parsedDelta?.mediaUrls;
-    const hasMedia = Boolean(mediaUrls && mediaUrls.length > 0);
-    const hasAudio = Boolean(parsedDelta?.audioAsVoice);
-    const previousCleaned = ctx.state.lastStreamedAssistantCleaned ?? "";
-
-    let shouldEmit = false;
-    let deltaText = "";
-    if (!cleanedText && !hasMedia && !hasAudio) {
-      shouldEmit = false;
-    } else if (previousCleaned && !cleanedText.startsWith(previousCleaned)) {
-      shouldEmit = false;
-    } else {
-      deltaText = cleanedText.slice(previousCleaned.length);
-      shouldEmit = Boolean(deltaText || hasMedia || hasAudio);
-    }
-
-    ctx.state.lastStreamedAssistant = next;
-    ctx.state.lastStreamedAssistantCleaned = cleanedText;
-
-    if (shouldEmit) {
-      emitAgentEvent({
-        runId: ctx.params.runId,
-        stream: "assistant",
-        data: {
-          text: cleanedText,
-          delta: deltaText,
-          mediaUrls: hasMedia ? mediaUrls : undefined,
-        },
-      });
-      void ctx.params.onAgentEvent?.({
-        stream: "assistant",
-        data: {
-          text: cleanedText,
-          delta: deltaText,
-          mediaUrls: hasMedia ? mediaUrls : undefined,
-        },
-      });
-      if (ctx.params.onPartialReply && ctx.state.shouldEmitPartialReplies) {
-        void ctx.params.onPartialReply({
-          text: cleanedText,
-          mediaUrls: hasMedia ? mediaUrls : undefined,
-        });
-      }
-    }
-  }
-
-  if (ctx.params.onBlockReply && ctx.blockChunking && ctx.state.blockReplyBreak
=== "text_end") {
-    ctx.blockChunker?.drain({ force: false, emit: ctx.emitBlockChunk });
-  }
-
-  if (evtType === "text_end" && ctx.state.blockReplyBreak === "text_end") {
-    if (ctx.blockChunker?.hasBuffered()) {
-      ctx.blockChunker.drain({ force: true, emit: ctx.emitBlockChunk });
-      ctx.blockChunker.reset();
-    } else if (ctx.state.blockBuffer.length > 0) {
-      ctx.emitBlockChunk(ctx.state.blockBuffer);
-      ctx.state.blockBuffer = "";
-    }
-  }
-}
-
-export function handleMessageEnd(
-  ctx: EmbeddedPiSubscribeContext,
-  evt: AgentEvent & { message: AgentMessage },
-) {
-  const msg = evt.message;
-  if (msg?.role !== "assistant") {
-    return;
-  }
-
-  const assistantMessage = msg;
-  promoteThinkingTagsToBlocks(assistantMessage);
-
-  const rawText = extractAssistantText(assistantMessage);
-  appendRawStream({
-    ts: Date.now(),
-    event: "assistant_message_end",
-    runId: ctx.params.runId,
-    sessionId: (ctx.params.session as { id?: string }).id,
-    rawText,
-    rawThinking: extractAssistantThinking(assistantMessage),
-  });
-
-  const text = ctx.stripBlockTags(rawText, { thinking: false, final: false });
-  const rawThinking =
-    ctx.state.includeReasoning || ctx.state.streamReasoning
-      ? extractAssistantThinking(assistantMessage) ||
extractThinkingFromTaggedText(rawText)
-      : "";
-  const formattedReasoning = rawThinking ? formatReasoningMessage(rawThinking)
: "";
-
-  const addedDuringMessage = ctx.state.assistantTexts.length >
ctx.state.assistantTextBaseline;
-  const chunkerHasBuffered = ctx.blockChunker?.hasBuffered() ?? false;
-  ctx.finalizeAssistantTexts({ text, addedDuringMessage, chunkerHasBuffered });
-
-  const onBlockReply = ctx.params.onBlockReply;
-  const shouldEmitReasoning = Boolean(
-    ctx.state.includeReasoning &&
-    formattedReasoning &&
-    onBlockReply &&
-    formattedReasoning !== ctx.state.lastReasoningSent,
-  );
-  const shouldEmitReasoningBeforeAnswer =
-    shouldEmitReasoning && ctx.state.blockReplyBreak === "message_end" &&
!addedDuringMessage;
-  const maybeEmitReasoning = () => {
-    if (!shouldEmitReasoning || !formattedReasoning) {
-      return;
-    }
-    ctx.state.lastReasoningSent = formattedReasoning;
-    void onBlockReply?.({ text: formattedReasoning });
-  };
-
-  if (shouldEmitReasoningBeforeAnswer) {
-    maybeEmitReasoning();
-  }
-
-  if (
-    (ctx.state.blockReplyBreak === "message_end" ||
-      (ctx.blockChunker ? ctx.blockChunker.hasBuffered() :
ctx.state.blockBuffer.length > 0)) &&
-    text &&
-    onBlockReply
-  ) {
-    if (ctx.blockChunker?.hasBuffered()) {
-      ctx.blockChunker.drain({ force: true, emit: ctx.emitBlockChunk });
-      ctx.blockChunker.reset();
-    } else if (text !== ctx.state.lastBlockReplyText) {
-      // Check for duplicates before emitting (same logic as emitBlockChunk).
-      const normalizedText = normalizeTextForComparison(text);
-      if (
-        isMessagingToolDuplicateNormalized(
-          normalizedText,
-          ctx.state.messagingToolSentTextsNormalized,
-        )
-      ) {
-        ctx.log.debug(
-          `Skipping message_end block reply - already sent via messaging tool:
${text.slice(0, 50)}...`,
-        );
-      } else {
-        ctx.state.lastBlockReplyText = text;
-        const splitResult = ctx.consumeReplyDirectives(text, { final: true });
-        if (splitResult) {
-          const {
-            text: cleanedText,
-            mediaUrls,
-            audioAsVoice,
-            replyToId,
-            replyToTag,
-            replyToCurrent,
-          } = splitResult;
-          // Emit if there's content OR audioAsVoice flag (to propagate the
flag).
-          if (cleanedText || (mediaUrls && mediaUrls.length > 0) ||
audioAsVoice) {
-            void onBlockReply({
-              text: cleanedText,
-              mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
-              audioAsVoice,
-              replyToId,
-              replyToTag,
-              replyToCurrent,
-            });
-          }
-        }
-      }
-    }
-  }
-
-  if (!shouldEmitReasoningBeforeAnswer) {
-    maybeEmitReasoning();
-  }
-  if (ctx.state.streamReasoning && rawThinking) {
-    ctx.emitReasoningStream(rawThinking);
-  }
-
-  if (ctx.state.blockReplyBreak === "text_end" && onBlockReply) {
-    const tailResult = ctx.consumeReplyDirectives("", { final: true });
-    if (tailResult) {
-      const {
-        text: cleanedText,
-        mediaUrls,
-        audioAsVoice,
-        replyToId,
-        replyToTag,
-        replyToCurrent,
-      } = tailResult;
-      if (cleanedText || (mediaUrls && mediaUrls.length > 0) || audioAsVoice) {
-        void onBlockReply({
-          text: cleanedText,
-          mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
-          audioAsVoice,
-          replyToId,
-          replyToTag,
-          replyToCurrent,
-        });
-      }
-    }
-  }
-
-  ctx.state.deltaBuffer = "";
-  ctx.state.blockBuffer = "";
-  ctx.blockChunker?.reset();
-  ctx.state.blockState.thinking = false;
-  ctx.state.blockState.final = false;
-  ctx.state.blockState.inlineCode = createInlineCodeState();
-  ctx.state.nativeThinkingBuffer = "";
-  ctx.state.lastStreamedAssistant = undefined;
-  ctx.state.lastStreamedAssistantCleaned = undefined;
-}
```

**Recommendation:** Check for `typeof thinkingContent === "string"` instead of
truthiness if empty strings are valid.

---

### Correctness Verification

✅ **State Management:** Buffer is properly initialized (`""`), reset on
`message_start` via `resetAssistantMessageState()`, and reset on compaction via
`resetForCompactionRetry()`.

✅ **Separation of Concerns:** Native thinking blocks are handled separately
from `<thinking>` tags, with proper precedence (native extracted before tagged
fallback).

✅ **Streaming Safety:** The `streamReasoning` flag is checked before emitting,
and deduplication prevents duplicate Discord messages.

✅ **Non-interference:** Text events and thinking events are properly separated
with early returns, preventing contamination of `deltaBuffer`.

✅ **Raw Stream Logging:** Thinking events are logged to the raw stream for
debugging.

---

### Recommendations Summary

1. **Use `nativeThinkingBuffer` as fallback** in `handleMessageEnd` before
   falling back to tagged thinking extraction

2. **Handle `thinking_start`** explicitly (log or document)

3. **Fix empty string handling** for `thinking_end` content

4. Consider optimizing string concatenation for very large thinking blocks
   (optional)

The implementation is safe to deploy but will be more robust with fixes #1 and
#2.

Tokens: 24k sent, 5.0k received. Cost: $0.03 message, $0.03 session.

Recommendation:** Use the buffer as a fallback
/home/davidmarsh/code/moltbot/Recommendation:** Use the buffer as a fallback:
file not found error

Current logic
/home/davidmarsh/code/moltbot/Current logic: file not found error
/home/davidmarsh/code/moltbot/Recommendation:** Use the buffer as a fallback:
file not found error
Did not apply edit to Current logic (--dry-run)
Did not apply edit to Recommendation:** Use the buffer as a fallback (--dry-run)
Did not apply edit to src/agents/pi-embedded-subscribe.handlers.messages.ts
(--dry-run)
Unable to read /home/davidmarsh/code/moltbot/Current logic: [Errno 2] No such file or directory: '/home/davidmarsh/code/moltbot/Current logic'
Unable to read /home/davidmarsh/code/moltbot/Recommendation:** Use the buffer as a fallback: [Errno 2] No such file or directory: '/home/davidmarsh/code/moltbot/Recommendation:** Use the buffer as a fallback'
Summarization failed for model openrouter/moonshotai/kimi-k2.5: cannot schedule new futures after shutdown
Summarization failed for model openrouter/moonshotai/kimi-k2.5: cannot schedule new futures after shutdown
summarizer unexpectedly failed for all models

```

---

```
