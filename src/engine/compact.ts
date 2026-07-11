import type { MessagesClient } from "./api.js";

const PROMPT = "Summarize the conversation so far for your own future reference: key facts, decisions, code locations, and open tasks. Be dense and complete.";

export async function compactHistory(
  client: MessagesClient,
  model: string,
  messages: unknown[]
): Promise<unknown[]> {
  let summary = "";
  const req = {
    model,
    system: "You compress agent conversation history.",
    messages: [...messages, { role: "user", content: PROMPT }],
    tools: [],
    max_tokens: 2048
  };
  for await (const event of client.create(req, new AbortController().signal)) {
    const e = event as { type?: string; delta?: { type?: string; text?: string } };
    if (e.type === "content_block_delta" && e.delta?.type === "text_delta") summary += e.delta.text ?? "";
  }
  return [{ role: "user", content: `Summary of prior conversation: ${summary}` }];
}
