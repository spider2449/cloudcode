import { createInterface } from "node:readline";
import { KeyDecoder, type Key } from "../input.js";
import { ALT_SCREEN_ON, ALT_SCREEN_OFF, BRACKETED_PASTE_ON, BRACKETED_PASTE_OFF, CURSOR_HIDE, CURSOR_SHOW } from "./ansi.js";

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
  private cleaned = false;

  constructor() {
    this.isTTY = process.stdin.isTTY === true;
    if (this.isTTY) {
      process.stdout.write(ALT_SCREEN_ON + BRACKETED_PASTE_ON + CURSOR_HIDE);
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
    process.stdout.write(s);
  }

  onKeys(cb: (keys: Key[]) => void): void {
    this.keysCb = cb;
  }

  onResize(cb: () => void): void {
    process.stdout.on("resize", cb);
  }

  onLine(cb: (line: string) => void): void {
    if (this.isTTY) return;
    const rl = createInterface({ input: process.stdin });
    rl.on("line", cb);
  }

  cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    if (this.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write(BRACKETED_PASTE_OFF + CURSOR_SHOW + ALT_SCREEN_OFF);
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
