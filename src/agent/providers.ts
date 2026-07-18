import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ProviderConfig {
  kind?: "anthropic" | "openai";
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  model_context_window?: number;
}

export const DEFAULT_CONTEXT_WINDOW = 200_000;

export function configDir(): string {
  return join(homedir(), ".cloudcode");
}

export function loadProviders(
  filePath: string = join(configDir(), "providers.json")
): Record<string, ProviderConfig> {
  const defaults: Record<string, ProviderConfig> = { anthropic: {} };
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    if (raw && typeof raw === "object") return { ...defaults, ...raw, anthropic: { ...raw.anthropic } };
  } catch {
    // missing or invalid file: fall through to defaults
  }
  return defaults;
}

export function providerEnv(cfg: ProviderConfig): Record<string, string> {
  const env: Record<string, string> = {};
  if (cfg.baseUrl) env.ANTHROPIC_BASE_URL = cfg.baseUrl;
  if (cfg.apiKey) env.ANTHROPIC_API_KEY = cfg.apiKey;
  return env;
}
