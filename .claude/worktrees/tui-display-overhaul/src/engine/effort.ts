// Named reasoning-effort levels mapped to Anthropic extended-thinking budgets.
export const EFFORT_LEVELS = ["off", "low", "medium", "high"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const EFFORT_BUDGETS: Record<Exclude<EffortLevel, "off">, number> = {
  low: 4096,
  medium: 16384,
  high: 32768
};

export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === "string" && (EFFORT_LEVELS as readonly string[]).includes(v);
}
