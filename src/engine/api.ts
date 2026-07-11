import Anthropic from "@anthropic-ai/sdk";
import type { ProviderConfig } from "../agent/providers.js";

export interface StreamRequest {
  model: string;
  system: string | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
  messages: unknown[];
  tools: unknown[];
  max_tokens: number;
}

export interface MessagesClient {
  create(req: StreamRequest, signal: AbortSignal): AsyncIterable<Record<string, unknown>>;
}

export function makeClient(cfg: ProviderConfig): MessagesClient {
  const anthropic = new Anthropic({
    apiKey: cfg.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "none",
    baseURL: cfg.baseUrl
  });
  return {
    async *create(req, signal) {
      const stream = await anthropic.messages.create(
        { ...req, stream: true } as never,
        { signal }
      );
      for await (const event of stream as unknown as AsyncIterable<Record<string, unknown>>) yield event;
    }
  };
}
