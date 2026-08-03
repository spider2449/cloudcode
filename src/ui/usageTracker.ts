export interface UsageTrackerDeps {
  contextWindow(): number;
  compact(onProgress: (pct: number) => void): Promise<number | undefined>;
  notice(text: string): void;
  onError(text: string): void;
  recompute(): void;
  /** Test hook: fires whenever auto-compact starts. */
  onAutoCompact?(): void;
}

const AUTO_COMPACT_THRESHOLD_PCT = 80;

/**
 * Owns everything the status bar reports about the current session's context
 * budget — accumulated cost, the live token count, how full the context window
 * is — plus the auto-compaction that fires when it gets close to full.
 */
export class UsageTracker {
  cost = 0;
  tokens = 0;
  contextPct: number | undefined;
  compactPct: number | undefined;
  private autoCompacting = false;

  constructor(private deps: UsageTrackerDeps) {}

  /**
   * The cached numbers describe the session being torn down. Clearing them
   * keeps the status bar from advertising the old session's usage against the
   * fresh (usually empty) one — which is also what makes it disagree with the
   * live figure /context reports until the next turn's result overwrites it.
   */
  resetForNewSession(): void {
    this.tokens = 0;
    this.contextPct = undefined;
  }

  addCost(usd: number): void {
    this.cost += usd;
  }

  setCompactProgress(pct: number | undefined): void {
    this.compactPct = pct;
  }

  /** Applies one turn's usage, auto-compacting if the window is nearly full. */
  applyTurnUsage(usage: Record<string, number>): void {
    const input = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    const output = usage.output_tokens ?? 0;
    // Current context size, not a running lifetime sum: `input` already covers
    // the whole resent history, so summing it turn over turn would
    // double-count and drift away from what /context reports.
    this.tokens = input + output;
    const pct = Math.min(100, Math.round((input / this.deps.contextWindow()) * 100));
    this.contextPct = pct;
    if (pct >= AUTO_COMPACT_THRESHOLD_PCT) void this.runAutoCompact();
  }

  /** Applies the post-compaction size reported by a manual or auto compact. */
  applyCompactedSize(estimatedTokens: number | undefined): void {
    if (typeof estimatedTokens !== "number") return;
    this.tokens = estimatedTokens;
    this.contextPct = Math.min(100, Math.round((estimatedTokens / this.deps.contextWindow()) * 100));
  }

  private async runAutoCompact(): Promise<void> {
    if (this.autoCompacting) return;
    this.autoCompacting = true;
    this.deps.onAutoCompact?.();
    this.compactPct = 0;
    this.deps.recompute();
    try {
      this.applyCompactedSize(await this.deps.compact(pct => { this.compactPct = pct; this.deps.recompute(); }));
      this.deps.notice("Context was getting full — compacted automatically.");
    } catch (err) {
      this.deps.onError(`Auto-compact failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.compactPct = undefined;
      this.autoCompacting = false;
      this.deps.recompute();
    }
  }
}
