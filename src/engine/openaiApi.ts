import type { ProviderConfig } from "../agent/providers.js";
import type { MessagesClient, StreamRequest } from "./api.js";

// Translates between cloudcode's Anthropic-Messages-shaped StreamRequest /
// streaming events and an OpenAI-Chat-Completions-shaped backend (e.g.
// NVIDIA NIM). engine/loop.ts only ever appends deltas to the last block in
// its `blocks` array and relies on content_block_stop (or the next
// content_block_start) to close it, so this translator always closes the
// currently open block before opening a different one rather than
// interleaving concurrent tool-call indices.

interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIChunk {
  choices?: Array<{
    delta?: { content?: string; reasoning_content?: string; tool_calls?: OpenAIToolCallDelta[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function systemText(system: StreamRequest["system"]): string {
  if (typeof system === "string") return system;
  return system.map(block => block.text).join("\n");
}

function flattenToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  return JSON.stringify(content);
}

function translateMessages(messages: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const raw of messages) {
    const msg = raw as { role: string; content: unknown };
    if (typeof msg.content === "string") {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    const blocks = msg.content as Array<Record<string, unknown>>;
    if (msg.role === "assistant") {
      let text = "";
      const toolCalls: unknown[] = [];
      for (const block of blocks) {
        if (block.type === "text") text += (block.text as string) ?? "";
        else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) }
          });
        }
        // "thinking" blocks have no OpenAI replay equivalent; dropped.
      }
      const assistantMsg: Record<string, unknown> = { role: "assistant", content: text || null };
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      out.push(assistantMsg);
      continue;
    }
    // role === "user" with block-array content: either tool_result blocks
    // or (rarely) plain text blocks.
    for (const block of blocks) {
      if (block.type === "tool_result") {
        out.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: flattenToolResultContent(block.content)
        });
      } else if (block.type === "text") {
        out.push({ role: "user", content: (block.text as string) ?? "" });
      }
    }
  }
  return out;
}

function translateRequest(req: StreamRequest) {
  const messages: unknown[] = [{ role: "system", content: systemText(req.system) }, ...translateMessages(req.messages)];
  const tools = (req.tools as Array<{ name: string; description: string; input_schema: unknown }>).map(t => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema }
  }));
  const body: Record<string, unknown> = {
    model: req.model,
    stream: true,
    stream_options: { include_usage: true },
    messages,
    max_tokens: req.max_tokens
  };
  if (tools.length > 0) body.tools = tools;
  return body;
}

function mapStopReason(finishReason: string | undefined): string {
  if (finishReason === "tool_calls") return "tool_use";
  if (finishReason === "length") return "max_tokens";
  return "end_turn";
}

async function* parseSSE(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<OpenAIChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of raw.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "" || data === "[DONE]") continue;
          yield JSON.parse(data) as OpenAIChunk;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function makeOpenAIClient(cfg: ProviderConfig): MessagesClient {
  const baseUrl = (cfg.baseUrl ?? "").replace(/\/$/, "");
  return {
    async *create(req, signal) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey ?? ""}`
        },
        body: JSON.stringify(translateRequest(req)),
        signal
      });
      if (!res.ok || !res.body) {
        const text = res.body ? await res.text() : "";
        throw new Error(`OpenAI-compatible API error ${res.status}: ${text}`);
      }

      type OpenIdentity = { kind: "text" } | { kind: "thinking" } | { kind: "tool_call"; index: number };
      let open: OpenIdentity | undefined;
      let blockIndex = -1;
      let finishReason: string | undefined;
      let usage: { input_tokens: number; output_tokens: number } | undefined;

      function* closeOpen(): Generator<Record<string, unknown>> {
        if (open) {
          yield { type: "content_block_stop", index: blockIndex };
          open = undefined;
        }
      }

      for await (const chunk of parseSSE(res.body, signal)) {
        if (chunk.usage) {
          usage = {
            input_tokens: chunk.usage.prompt_tokens ?? 0,
            output_tokens: chunk.usage.completion_tokens ?? 0
          };
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};

        if (delta.content) {
          if (!open || open.kind !== "text") {
            yield* closeOpen();
            blockIndex++;
            open = { kind: "text" };
            yield { type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } };
          }
          yield { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: delta.content } };
        }

        if (delta.reasoning_content) {
          if (!open || open.kind !== "thinking") {
            yield* closeOpen();
            blockIndex++;
            open = { kind: "thinking" };
            yield { type: "content_block_start", index: blockIndex, content_block: { type: "thinking", thinking: "" } };
          }
          yield {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "thinking_delta", thinking: delta.reasoning_content }
          };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!open || open.kind !== "tool_call" || open.index !== tc.index) {
              yield* closeOpen();
              blockIndex++;
              open = { kind: "tool_call", index: tc.index };
              yield {
                type: "content_block_start",
                index: blockIndex,
                content_block: { type: "tool_use", id: tc.id ?? "", name: tc.function?.name ?? "" }
              };
            }
            if (tc.function?.arguments) {
              yield {
                type: "content_block_delta",
                index: blockIndex,
                delta: { type: "input_json_delta", partial_json: tc.function.arguments }
              };
            }
          }
        }

        if (choice.finish_reason) finishReason = choice.finish_reason;
      }

      yield* closeOpen();
      yield { type: "message_delta", delta: { stop_reason: mapStopReason(finishReason) }, usage };
    }
  } satisfies MessagesClient;
}
