import Anthropic from "@anthropic-ai/sdk";
import type { ProviderConfig } from "../agent/providers.js";
import { makeOpenAIClient } from "./openaiApi.js";

export interface ContextManagementEdit {
  type: "clear_tool_uses_20250919";
  trigger: { type: "input_tokens"; value: number };
  keep: { type: "tool_uses"; value: number };
  clear_at_least?: { type: "input_tokens"; value: number };
  exclude_tools?: string[];
  clear_tool_inputs?: false;
}

export interface ContextManagementConfig {
  edits: ContextManagementEdit[];
}

export const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";

export interface StreamRequest {
  model: string;
  system: string | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
  messages: unknown[];
  tools: unknown[];
  max_tokens: number;
  thinking?: { type: "adaptive" } | { type: "disabled" };
  output_config?: { effort: "low" | "medium" | "high" };
  betas?: string[];
  context_management?: ContextManagementConfig;
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
      // Per-request betas (e.g. context-management) ride in the request body;
      // the SDK merges them with defaultHeaders (OAuth) automatically.
      // Separate branches: beta and stable create() overloads are incompatible
      // as a union, so they cannot share one callable reference.
      const stream = req.betas !== undefined && req.betas.length > 0
        ? await anthropic.beta.messages.create({ ...req, stream: true } as never, { signal })
        : await anthropic.messages.create({ ...req, stream: true } as never, { signal });
      for await (const event of stream as unknown as AsyncIterable<Record<string, unknown>>) yield event;
    }
  };
}
