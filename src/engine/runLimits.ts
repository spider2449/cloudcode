import { pricingKnown } from "./pricing.js";

export interface RunLimits {
  maxTurns?: number;
  timeoutMs?: number;
  maxCostUsd?: number;
}

export type RunLimitKind = keyof RunLimits;

export class RunLimitError extends Error {
  readonly code = "RUN_LIMIT_REACHED";
  constructor(readonly limit: RunLimitKind, readonly value: number) {
    super(`Run limit reached: ${limit}=${value}`);
    this.name = "RunLimitError";
  }
}

export class RunLimitConfigurationError extends Error {
  readonly code = "INVALID_RUN_LIMIT";
  constructor(message: string) {
    super(message);
    this.name = "RunLimitConfigurationError";
  }
}

export function validateRunLimits(limits: RunLimits | undefined, model: string): void {
  if (!limits) return;
  if (limits.maxTurns !== undefined && (!Number.isSafeInteger(limits.maxTurns) || limits.maxTurns <= 0)) {
    throw new RunLimitConfigurationError("maxTurns must be a positive integer.");
  }
  if (limits.timeoutMs !== undefined && (!Number.isFinite(limits.timeoutMs) || limits.timeoutMs <= 0)) {
    throw new RunLimitConfigurationError("timeoutMs must be a positive duration.");
  }
  if (limits.maxCostUsd !== undefined) {
    if (!Number.isFinite(limits.maxCostUsd) || limits.maxCostUsd <= 0) {
      throw new RunLimitConfigurationError("maxCostUsd must be a positive number.");
    }
    if (!pricingKnown(model)) {
      throw new RunLimitConfigurationError(`Cannot enforce maxCostUsd: pricing is unknown for model "${model}".`);
    }
  }
}
