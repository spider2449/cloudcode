import { CLEAR_ALL_AND_HOME } from "./term/ansi.js";

export interface ResizeGuardDeps {
  isRunning(): boolean;
  write(text: string): void;
  recompute(): void;
  invalidateRenderer(): void;
  recommitBuffer(): void;
}

const SETTLE_MS = 150;

/**
 * Any resize leaves debris that no in-place footer repaint can fix. On a
 * width change the terminal reflows the transcript rows that were
 * committed to scrollback at the old width, garbling history. On a height
 * shrink the host pushes the viewport top -- including previously painted
 * footer rows -- into scrollback, baking stale footer copies there, where
 * no escape sequence can reach them. The only correct recovery for both
 * is a scrollback-clearing reprint of the whole transcript at the settled
 * size. Resize events arrive in storms while the user drags the window
 * edge, so the expensive full repaint is debounced until the size
 * settles; each in-storm frame is still repainted immediately so the
 * footer tracks the live size.
 */
export class ResizeGuard {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private deps: ResizeGuardDeps) {}

  handleResize(): void {
    // A stopped App must be fully inert: without this guard, an instance
    // whose resize callback outlives stop() (e.g. across a project switch)
    // keeps repainting on every resize with its stale, empty renderer state,
    // clearing the screen and stamping an outdated footer over the live
    // App's frames.
    if (!this.deps.isRunning()) return;
    this.deps.recompute();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.deps.isRunning()) return;
      this.deps.write(CLEAR_ALL_AND_HOME);
      this.deps.invalidateRenderer();
      this.deps.recommitBuffer();
      this.deps.recompute();
    }, SETTLE_MS);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
