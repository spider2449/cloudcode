import type { Usage } from "./messages.js";

// USD per million tokens: [input, output]. Extend as models are used.
const PRICES: Record<string, [number, number]> = {
  "claude-sonnet-5": [3, 15],
  "claude-opus-4-8": [15, 75],
  "claude-haiku-4-5-20251001": [1, 5]
};

export function costUsd(model: string, usage: Usage): number | undefined {
  const p = Object.entries(PRICES).find(([k]) => model.startsWith(k))?.[1];
  if (!p) return undefined;
  return (usage.input_tokens * p[0] + usage.output_tokens * p[1]) / 1_000_000;
}
