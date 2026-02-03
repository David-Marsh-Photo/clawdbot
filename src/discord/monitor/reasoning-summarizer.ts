import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("reasoning-summarizer");

const SUMMARIZATION_PROMPT = `Convert to 4 bullet points (5-10 words each, present continuous tense like "Analyzing...", "Considering...").
Output ONLY 4 lines starting with "- ". No thinking, no explanation. /no_think`;

export type SummarizerConfig = {
  baseUrl: string; // default: "http://127.0.0.1:8000/v1"
  model: string; // default: "Qwen/Qwen3-8B-AWQ"
  updateIntervalMs: number; // default: 5000
  timeoutMs: number; // default: 15000
};

type SummarizerState = {
  buffer: string;
  lastSummary: string[];
  lastSummarizedAt: number;
  startedAt: number;
  inFlight: boolean;
};

const sessions = new Map<string, SummarizerState>();

export function appendThinking(sessionKey: string, delta: string): void {
  let state = sessions.get(sessionKey);
  if (!state) {
    state = {
      buffer: "",
      lastSummary: [],
      lastSummarizedAt: 0,
      startedAt: Date.now(),
      inFlight: false,
    };
    sessions.set(sessionKey, state);
  }
  state.buffer += delta;
}

export async function getSummaryDisplay(
  sessionKey: string,
  config: SummarizerConfig,
): Promise<string> {
  const state = sessions.get(sessionKey);
  if (!state) {
    return formatDisplay([], 0);
  }

  const elapsed = Date.now() - state.startedAt;
  const timeSinceSummary = Date.now() - state.lastSummarizedAt;

  // Check if we should request new summary
  const shouldSummarize =
    state.buffer.length > 100 && timeSinceSummary >= config.updateIntervalMs && !state.inFlight;

  if (shouldSummarize) {
    state.inFlight = true;
    try {
      const bullets = await requestSummary(state.buffer, config);
      if (bullets.length > 0) {
        state.lastSummary = bullets;
        state.lastSummarizedAt = Date.now();
      }
    } catch (err) {
      log.debug(`summarization failed: ${String(err)}`);
    } finally {
      state.inFlight = false;
    }
  }

  return formatDisplay(state.lastSummary, elapsed);
}

async function requestSummary(buffer: string, config: SummarizerConfig): Promise<string[]> {
  const truncated = buffer.slice(-4000); // Last ~4000 chars

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: SUMMARIZATION_PROMPT },
        { role: "user", content: truncated },
      ],
      max_tokens: 100,
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`vLLM error: ${response.status}`);
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  let text = data.choices?.[0]?.message?.content ?? "";

  // Strip Qwen3 thinking tags if present
  const thinkEndIdx = text.indexOf("</think>");
  if (thinkEndIdx !== -1) {
    text = text.slice(thinkEndIdx + 8).trim();
  }

  return text
    .split("\n")
    .map((line: string) => line.replace(/^[-•]\s*/, "").trim())
    .filter((line: string) => line.length > 0)
    .slice(0, 4);
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function formatDisplay(bullets: string[], elapsedMs: number): string {
  const seconds = Math.round(elapsedMs / 1000);
  const spinnerIdx = Math.floor(elapsedMs / 500) % SPINNER_FRAMES.length;
  const spinner = SPINNER_FRAMES[spinnerIdx];
  const header = `${spinner} **Thinking...** (${seconds}s)`;

  // Ensure exactly 4 bullet lines for consistent height
  const paddedBullets = [...bullets];
  while (paddedBullets.length < 4) {
    paddedBullets.push(paddedBullets.length === 0 ? "Processing..." : "\u200B");
  }

  const bulletLines = paddedBullets
    .slice(0, 4)
    .map((b) => `• ${b.slice(0, 60)}`)
    .join("\n");

  return `${header}\n\`\`\`\n${bulletLines}\n\`\`\``;
}

export function clearSession(sessionKey: string): void {
  sessions.delete(sessionKey);
}
