// Message shapes the TUI consumes. Mirrors the subset of the former
// claude-agent-sdk SDKMessage union that transcript.ts and App.tsx read.
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

export type EngineMessage =
  | { type: "system"; subtype: "init"; session_id: string; tools: string[] }
  | { type: "stream_event"; event: { type: "content_block_delta"; delta: { type: "text_delta"; text: string } | { type: "thinking_delta"; thinking: string } } }
  | { type: "assistant"; message: { content: ContentBlock[] } }
  | { type: "result"; subtype: "success"; total_cost_usd?: number; duration_ms: number; usage?: Usage }
  | { type: "result"; subtype: "error_during_execution"; result: string }
  | { type: "tool_result"; tool_use_id: string; content: unknown; is_error: boolean };

export function textDelta(text: string): EngineMessage {
  return { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } };
}

export function thinkingDelta(thinking: string): EngineMessage {
  return { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking } } };
}

export function assistantMessage(content: ContentBlock[]): EngineMessage {
  return { type: "assistant", message: { content } };
}

export function errorResult(result: string): EngineMessage {
  return { type: "result", subtype: "error_during_execution", result };
}

export function toolResultMessage(tool_use_id: string, content: unknown, is_error: boolean): EngineMessage {
  return { type: "tool_result", tool_use_id, content, is_error };
}
