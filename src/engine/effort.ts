// Named reasoning-effort levels. On current Anthropic models these map
// directly onto the API's `output_config.effort` parameter, which replaced
// the removed fixed `budget_tokens` thinking budget.
export const EFFORT_LEVELS = ["off", "low", "medium", "high"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

// Adaptive thinking shares `max_tokens` with the visible answer, so each
// level grants extra output room on top of the base cap. These are headroom
// figures, not thinking budgets: the model decides how much of it to spend.
export const EFFORT_HEADROOM: Record<Exclude<EffortLevel, "off">, number> = {
  low: 4096,
  medium: 16384,
  high: 32768
};

// Models whose thinking cannot be switched off: an explicit
// `thinking: {type: "disabled"}` returns a 400 on these at any effort level.
// Matched as substrings so provider-prefixed ids (e.g. Bedrock's
// "anthropic.claude-fable-5") resolve too.
const ALWAYS_THINKING = ["claude-fable-5", "claude-mythos-5", "claude-mythos-preview"];

export function allowsDisabledThinking(model: string): boolean {
  return !ALWAYS_THINKING.some(id => model.includes(id));
}

export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === "string" && (EFFORT_LEVELS as readonly string[]).includes(v);
}

// Caps the extra output headroom so headroom + maxTokens never exceeds the
// model's context window, protecting models with smaller windows than
// Anthropic's. Returns 0 when there is no room to spare; thinking still runs
// in that case, just within the base cap.
export function clampEffortHeadroom(headroom: number, contextWindow: number, maxTokens: number): number {
  const cap = contextWindow - maxTokens;
  if (cap <= 0) return 0;
  return Math.min(headroom, cap);
}
