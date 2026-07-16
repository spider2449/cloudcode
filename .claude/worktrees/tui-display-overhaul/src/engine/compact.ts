import type { MessagesClient } from "./api.js";

const PROMPT = "Summarize the conversation so far for your own future reference: key facts, decisions, code locations, and open tasks. Be dense and complete.";

const MAX_TOKENS = 2048;
// Rough chars-per-token estimate for English text; good enough for a progress
// indicator or a status-bar estimate, not for anything that needs to be exact.
const CHARS_PER_TOKEN = 4;

export function estimateTokens(messages: unknown[]): number {
  return Math.round(JSON.stringify(messages).length / CHARS_PER_TOKEN);
}

export async function compactHistory(
  client: MessagesClient,
  model: string,
  messages: unknown[],
  onProgress?: (pct: number) => void
): Promise<unknown[]> {
  let summary = "";
  const last = messages[messages.length - 1] as { role?: string } | undefined;
  // The Messages API requires strict user/assistant alternation. History can
  // end on a "user" message (e.g. right after a tool-result turn), so appending
  // another user message directly would produce two consecutive user turns and
  // the request would be rejected.
  const history = last?.role === "user"
    ? [...messages, { role: "assistant", content: "Understood." }]
    : [...messages];
  const req = {
    model,
    system: "You compress agent conversation history.",
    messages: [...history, { role: "user", content: PROMPT }],
    tools: [],
    max_tokens: MAX_TOKENS
  };
  for await (const event of client.create(req, new AbortController().signal)) {
    const e = event as { type?: string; delta?: { type?: string; text?: string } };
    if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
      summary += e.delta.text ?? "";
      if (onProgress) {
        // The real total length is unknown until the stream ends, so this is
        // an estimate against the max_tokens cap, clamped short of 100% until
        // the stream actually finishes below.
        const estimatedTokens = summary.length / CHARS_PER_TOKEN;
        onProgress(Math.min(99, Math.floor((estimatedTokens / MAX_TOKENS) * 100)));
      }
    }
  }
  onProgress?.(100);
  return [{ role: "user", content: `Summary of prior conversation: ${summary}` }];
}
