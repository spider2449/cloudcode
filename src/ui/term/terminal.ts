import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { KeyDecoder, type Key } from "../input.js";
import { BRACKETED_PASTE_ON, BRACKETED_PASTE_OFF, CURSOR_HIDE, CURSOR_SHOW, AUTOWRAP_OFF, AUTOWRAP_ON, RESET_SCROLL_REGION, KITTY_KEYBOARD_ON, KITTY_KEYBOARD_OFF } from "./ansi.js";

// Opt-in raw-output capture for diagnosing rendering bugs that only show up
// on a real terminal (resize storms, redraw artifacts) and can't be
// reproduced from a description alone. Set CLOUDCODE_DEBUG_LOG to a file
// path to append every write() call (escape codes visible, not interpreted)
// plus resize events, each tagged with a millisecond timestamp so frames
// can be correlated. Logging failures are swallowed: diagnostics must never
// crash the app they're diagnosing.
function debugLog(line: string): void {
  const path = process.env.CLOUDCODE_DEBUG_LOG;
  if (!path) return;
  try {
    appendFileSync(path, `[${Date.now()}] ${line}\n`);
  } catch {
    // ignore
  }
}

export interface ITerminal {
  isTTY: boolean;
  size(): { rows: number; columns: number };
  write(s: string): void;
  onKeys(cb: (keys: Key[]) => void): void;
  onResize(cb: () => void): void;
  onLine(cb: (line: string) => void): void;
  cleanup(): void;
}

export class Terminal implements ITerminal {
  isTTY: boolean;
  private decoder: KeyDecoder | undefined;
  private keysCb: ((keys: Key[]) => void) | undefined;
  private resizeCb: (() => void) | undefined;
  private resizeListener: (() => void) | undefined;
  private cleaned = false;

  constructor() {
    this.isTTY = process.stdin.isTTY === true;
    if (this.isTTY) {
      // Inline rendering on the normal screen: the transcript lives in the
      // terminal's own scrollback, so native mouse selection, copy, and wheel
      // scrolling work without any mouse capture.
      process.stdout.write(BRACKETED_PASTE_ON + CURSOR_HIDE + AUTOWRAP_OFF + KITTY_KEYBOARD_ON);
      process.stdin.setRawMode(true);
      this.decoder = new KeyDecoder();
      this.decoder.onTimeout = keys => this.keysCb?.(keys);
      process.stdin.on("data", (chunk: Buffer) => {
        const keys = this.decoder!.feed(chunk);
        if (keys.length > 0) this.keysCb?.(keys);
      });
      process.stdin.resume();
    }
  }

  size(): { rows: number; columns: number } {
    return { rows: process.stdout.rows ?? 24, columns: process.stdout.columns ?? 80 };
  }

  write(s: string): void {
    if (process.env.CLOUDCODE_DEBUG_LOG) debugLog(`WRITE ${JSON.stringify(s)}`);
    process.stdout.write(s);
  }

  onKeys(cb: (keys: Key[]) => void): void {
    this.keysCb = cb;
  }

  // Stores a single callback (like onKeys) instead of stacking a new
  // process-level listener per call: each App created against this Terminal
  // (e.g. across project switches in cli.tsx's loop) registers its own
  // handler, and a stale App's listener surviving its stop() means a dead
  // instance keeps repainting on every resize -- clearing the screen and
  // stamping its outdated footer over the live App's frames.
  onResize(cb: () => void): void {
    this.resizeCb = cb;
    if (!this.resizeListener) {
      this.resizeListener = () => {
        if (process.env.CLOUDCODE_DEBUG_LOG) debugLog(`RESIZE ${JSON.stringify(this.size())}`);
        this.resizeCb?.();
      };
      process.stdout.on("resize", this.resizeListener);
    }
  }

  onLine(cb: (line: string) => void): void {
    if (this.isTTY) return;
    const rl = createInterface({ input: process.stdin });
    rl.on("line", cb);
  }

  cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    if (this.resizeListener) {
      process.stdout.removeListener("resize", this.resizeListener);
      this.resizeListener = undefined;
      this.resizeCb = undefined;
    }
    if (this.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write(KITTY_KEYBOARD_OFF + RESET_SCROLL_REGION + AUTOWRAP_ON + BRACKETED_PASTE_OFF + CURSOR_SHOW);
    }
  }
}

export class FakeTerminal implements ITerminal {
  isTTY = false;
  writes: string[] = [];
  private sz: { rows: number; columns: number };
  private lineCb: ((line: string) => void) | undefined;
  private resizeCb: (() => void) | undefined;

  constructor(size: { rows: number; columns: number } = { rows: 24, columns: 80 }) {
    this.sz = size;
  }

  size(): { rows: number; columns: number } {
    return this.sz;
  }

  write(s: string): void {
    this.writes.push(s);
  }

  onKeys(): void {
    // Tests inject Key[] lists directly into App; FakeTerminal never decodes stdin.
  }

  onResize(cb: () => void): void {
    this.resizeCb = cb;
  }

  onLine(cb: (line: string) => void): void {
    this.lineCb = cb;
  }

  cleanup(): void {
    // no-op: FakeTerminal never touches real stdin/stdout
  }

  /** Test helper: simulate a finished non-TTY input line. */
  feedLine(line: string): void {
    this.lineCb?.(line);
  }

  /** Test helper: simulate a terminal resize. */
  resize(size: { rows: number; columns: number }): void {
    this.sz = size;
    this.resizeCb?.();
  }
}
