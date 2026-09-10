import type { ChatEvent } from "./chatProtocol.js";
import type { EngineMessage } from "../engine/messages.js";

// Shared per-block mapping for assistant content blocks (Anthropic shape).
function assistantBlocksToEvents(id: string, content: unknown): ChatEvent[] {
  if (!Array.isArray(content)) return [];
  const events: ChatEvent[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const typed = block as { type?: unknown; text?: unknown; name?: unknown; input?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") events.push({ id, type: "text_delta", text: typed.text });
    else if (typed.type === "tool_use" && typeof typed.name === "string") {
      const input = typeof typed.input === "object" && typed.input !== null ? (typed.input as Record<string, unknown>) : undefined;
      events.push({ id, type: "tool_use", toolName: typed.name, toolInput: input });
    }
  }
  return events;
}

export function toChatEvents(id: string, msg: EngineMessage): ChatEvent[] {
  switch (msg.type) {
    case "stream_event":
      if (msg.event.delta.type === "text_delta") return [{ id, type: "text_delta", text: msg.event.delta.text }];
      return [];
    case "assistant": {
      return assistantBlocksToEvents(id, msg.message.content);
    }
    case "tool_result":
      return [{ id, type: "tool_result", text: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) }];
    case "result":
      if (msg.subtype === "error_during_execution") return [{ id, type: "error", text: msg.result }];
      return [];
    case "limit":
      return [{ id, type: "error", text: `Limit reached: ${msg.limit} (${msg.value})` }];
    default:
      return [];
  }
}

// Maps persisted SessionFile entries (Anthropic API messages plus {type:"todos"}
// records) back to chat events for history replay. Anything else is ignored.
export function fromApiMessages(id: string, entries: Array<{ role?: string; content?: unknown; type?: string }>): ChatEvent[] {
  const events: ChatEvent[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    if (entry.role === "user") {
      if (typeof entry.content === "string" && entry.content !== "") events.push({ id, type: "user_text", text: entry.content });
    } else if (entry.role === "assistant") {
      events.push(...assistantBlocksToEvents(id, entry.content));
    }
    // Todos records and unknown shapes map to nothing.
  }
  return events;
}
