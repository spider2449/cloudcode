import Anthropic from "@anthropic-ai/sdk";
import type { ProviderConfig } from "../agent/providers.js";
import { makeOpenAIClient } from "./openaiApi.js";

export interface StreamRequest {
  model: string;
  system: string | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
  messages: unknown[];
  tools: unknown[];
  max_tokens: number;
  thinking?: { type: "adaptive" } | { type: "disabled" };
  output_config?: { effort: "low" | "medium" | "high" };
}

export interface MessagesClient {
  create(req: StreamRequest, signal: AbortSignal): AsyncIterable<Record<string, unknown>>;
}

export const OAUTH_BETA_HEADER = "oauth-2025-04-20";

/** Optional OAuth bearer authentication for anthropic-kind providers. */
export interface ClientAuth {
  authToken: string;
  betaHeader?: string;
}

export function makeClient(cfg: ProviderConfig, auth?: ClientAuth): MessagesClient {
  if (cfg.kind === "openai") return makeOpenAIClient(cfg);
  const anthropic = new Anthropic({
    apiKey: cfg.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "none",
    baseURL: cfg.baseUrl,
    // Explicit keys win; OAuth flows through Bearer auth plus its beta header.
    ...(auth
      ? {
          authToken: auth.authToken,
          defaultHeaders: { "anthropic-beta": auth.betaHeader ?? OAUTH_BETA_HEADER }
        }
      : {})
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
