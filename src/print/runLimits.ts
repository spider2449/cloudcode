import type { RunLimits } from "../engine/runLimits.js";

export function parsePositiveInteger(value: string, flag: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${flag} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} is too large.`);
  return parsed;
}

export function parsePositiveNumber(value: string, flag: string): number {
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(value)) throw new Error(`${flag} must be a positive number.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive number.`);
  return parsed;
}

export function parseDuration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value);
  if (!match) throw new Error("--timeout must be a positive duration such as 500ms, 10s, 5m, or 1h.");
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] as "ms" | "s" | "m" | "h"];
  const parsed = Number(match[1]) * factor;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("--timeout must resolve to a positive whole number of milliseconds.");
  }
  return parsed;
}

export function parseRunLimits(values: {
  maxTurns?: string; timeout?: string; maxCostUsd?: string;
}): RunLimits {
  return {
    ...(values.maxTurns ? { maxTurns: parsePositiveInteger(values.maxTurns, "--max-turns") } : {}),
    ...(values.timeout ? { timeoutMs: parseDuration(values.timeout) } : {}),
    ...(values.maxCostUsd ? { maxCostUsd: parsePositiveNumber(values.maxCostUsd, "--max-cost-usd") } : {})
  };
}
