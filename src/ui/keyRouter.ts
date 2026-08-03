import type { Key } from "./input.js";

const DOUBLE_CTRL_C_MS = 2000;

export interface KeyRouterHost {
  isStreaming(): boolean;
  isOverlayOpen(): boolean;
  interrupt(): void;
  clearScreen(): void;
  exit(): void;
  notice(text: string): void;
  cyclePermissionMode(): void;
  handleOverlayKey(k: Key, input: string | undefined): void;
  handlePaste(text: string): void;
  handleInputKey(k: Key): void;
  recompute(): void;
}

/**
 * Key dispatch for the interactive app, in three phases: globals that fire
 * regardless of focus (interrupt, clear, exit), then the focus owner (an open
 * overlay swallows everything), then the input box. The only state it keeps is
 * the timestamp needed to tell a single Ctrl+C (interrupt) from a double one
 * (exit).
 */
export class KeyRouter {
  private lastCtrlCAt = 0;

  constructor(private host: KeyRouterHost) {}

  handleKeys(ks: Key[]): void {
    for (const k of ks) this.handleKey(k);
  }

  handleKey(k: Key): void {
    // Phase 1: globals.
    if (k.t === "esc" && this.host.isStreaming() && !this.host.isOverlayOpen()) {
      this.host.interrupt();
      return;
    }
    if (k.t === "ctrl" && k.ch === "l") {
      this.host.clearScreen();
      this.host.recompute();
      return;
    }
    if (k.t === "ctrl" && k.ch === "c") {
      const now = Date.now();
      if (now - this.lastCtrlCAt < DOUBLE_CTRL_C_MS) {
        this.host.exit();
      } else {
        this.lastCtrlCAt = now;
        this.host.interrupt();
        this.host.notice("Press Ctrl+C again to exit.");
        this.host.recompute();
      }
      return;
    }

    // Phase 2: focus owner.
    if (this.host.isOverlayOpen()) {
      this.host.handleOverlayKey(k, k.t === "printable" ? k.ch : undefined);
      this.host.recompute();
      return;
    }
    if (k.t === "backtab") {
      this.host.cyclePermissionMode();
      return;
    }
    if (k.t === "paste") {
      this.host.handlePaste(k.text);
      this.host.recompute();
      return;
    }
    this.host.handleInputKey(k);
    this.host.recompute();
  }
}
