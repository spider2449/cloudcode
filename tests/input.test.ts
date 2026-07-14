import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KeyDecoder, type Key } from "../src/ui/input.js";

function b(s: string): Buffer { return Buffer.from(s, "binary"); }

describe("KeyDecoder", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("decodes enter, tab, backtab, backspace, delete", () => {
    const d = new KeyDecoder();
    expect(d.feed(b("\r"))).toEqual([{ t: "enter" }]);
    expect(d.feed(b("\n"))).toEqual([{ t: "enter" }]);
    expect(d.feed(b("\t"))).toEqual([{ t: "tab" }]);
    expect(d.feed(b("\x1b[Z"))).toEqual([{ t: "backtab" }]);
    expect(d.feed(b("\x7f"))).toEqual([{ t: "backspace" }]);
    expect(d.feed(b("\x1b[3~"))).toEqual([{ t: "delete" }]);
  });

  it("decodes both cursor-mode arrow variants", () => {
    const d = new KeyDecoder();
    expect(d.feed(b("\x1b[A"))).toEqual([{ t: "up" }]);
    expect(d.feed(b("\x1bOA"))).toEqual([{ t: "up" }]);
    expect(d.feed(b("\x1b[B"))).toEqual([{ t: "down" }]);
    expect(d.feed(b("\x1b[C"))).toEqual([{ t: "right" }]);
    expect(d.feed(b("\x1b[D"))).toEqual([{ t: "left" }]);
  });

  it("decodes home/end and pgup/pgdn variants", () => {
    const d = new KeyDecoder();
    for (const seq of ["\x1b[H", "\x1b[1~", "\x1bOH"]) expect(d.feed(b(seq))).toEqual([{ t: "home" }]);
    for (const seq of ["\x1b[F", "\x1b[4~", "\x1bOF"]) expect(d.feed(b(seq))).toEqual([{ t: "end" }]);
    expect(d.feed(b("\x1b[5~"))).toEqual([{ t: "pgup" }]);
    expect(d.feed(b("\x1b[6~"))).toEqual([{ t: "pgdn" }]);
  });

  it("decodes SGR mouse wheel reports and drops other mouse events", () => {
    const d = new KeyDecoder();
    expect(d.feed(b("\x1b[<64;10;5M"))).toEqual([{ t: "wheel", dir: "up" }]);
    expect(d.feed(b("\x1b[<65;10;5M"))).toEqual([{ t: "wheel", dir: "down" }]);
    // Button press (0) and release (m form) are consumed without emitting keys.
    expect(d.feed(b("\x1b[<0;10;5M"))).toEqual([]);
    expect(d.feed(b("\x1b[<0;10;5m"))).toEqual([]);
    // A split sequence waits for the rest instead of misparsing.
    expect(d.feed(b("\x1b[<64;10"))).toEqual([]);
    expect(d.feed(b(";5M"))).toEqual([{ t: "wheel", dir: "up" }]);
  });

  it("decodes Ctrl-A..Z from bytes 0x01..0x1A", () => {
    const d = new KeyDecoder();
    expect(d.feed(Buffer.from([0x03]))).toEqual([{ t: "ctrl", ch: "c" }]);
    expect(d.feed(Buffer.from([0x02]))).toEqual([{ t: "ctrl", ch: "b" }]);
    expect(d.feed(Buffer.from([0x06]))).toEqual([{ t: "ctrl", ch: "f" }]);
    expect(d.feed(Buffer.from([0x01]))).toEqual([{ t: "ctrl", ch: "a" }]);
  });

  it("decodes printable characters", () => {
    const d = new KeyDecoder();
    expect(d.feed(b("h"))).toEqual([{ t: "printable", ch: "h" }]);
  });

  it("decodes multiple keys delivered in one chunk", () => {
    const d = new KeyDecoder();
    const keys = d.feed(b("hi\r"));
    expect(keys).toEqual([{ t: "printable", ch: "h" }, { t: "printable", ch: "i" }, { t: "enter" }]);
  });

  it("decodes a bracketed paste payload as one event", () => {
    const d = new KeyDecoder();
    const keys = d.feed(b("\x1b[200~hello\nworld\x1b[201~"));
    expect(keys).toEqual([{ t: "paste", text: "hello\nworld" }]);
  });

  it("retains a partial escape sequence across feed() calls", () => {
    const d = new KeyDecoder();
    expect(d.feed(b("\x1b["))).toEqual([]);
    expect(d.feed(b("A"))).toEqual([{ t: "up" }]);
  });

  it("emits esc after a 25ms timeout with no continuation bytes", () => {
    const d = new KeyDecoder();
    const onKeys = vi.fn();
    d.onTimeout = (keys: Key[]) => onKeys(keys);
    expect(d.feed(b("\x1b"))).toEqual([]);
    vi.advanceTimersByTime(25);
    expect(onKeys).toHaveBeenCalledWith([{ t: "esc" }]);
  });

  it("parses a lone Escape as an escape-sequence prefix when continuation bytes arrive within 25ms", () => {
    const d = new KeyDecoder();
    expect(d.feed(b("\x1b"))).toEqual([]);
    vi.advanceTimersByTime(10);
    expect(d.feed(b("[A"))).toEqual([{ t: "up" }]);
  });

  it("decodes Alt+printable as a single alt key when a printable follows Escape directly in the same chunk", () => {
    const d = new KeyDecoder();
    expect(d.feed(b("\x1bx"))).toEqual([{ t: "alt", ch: "x" }]);
  });

  it("discards an unrecognized but complete CSI sequence instead of wedging the decoder", () => {
    const d = new KeyDecoder();
    // \x1b[I is a terminal focus-in report; not in SEQUENCES, but complete.
    expect(d.feed(b("\x1b[I"))).toEqual([]);
    // The decoder must still parse subsequent keys, not get stuck re-scanning the discarded bytes.
    expect(d.feed(b("h"))).toEqual([{ t: "printable", ch: "h" }]);
  });

  it("decodes CSI u Enter/Shift+Enter reports from the Kitty keyboard protocol", () => {
    const d = new KeyDecoder();
    expect(d.feed(b("\x1b[13u"))).toEqual([{ t: "enter" }]);
    expect(d.feed(b("\x1b[13;1u"))).toEqual([{ t: "enter" }]);
    expect(d.feed(b("\x1b[13;2u"))).toEqual([{ t: "shift-enter" }]);
  });

  it("decodes CSI u Tab/Shift+Tab reports from the Kitty keyboard protocol", () => {
    const d = new KeyDecoder();
    expect(d.feed(b("\x1b[9u"))).toEqual([{ t: "tab" }]);
    expect(d.feed(b("\x1b[9;1u"))).toEqual([{ t: "tab" }]);
    expect(d.feed(b("\x1b[9;2u"))).toEqual([{ t: "backtab" }]);
  });

  it("decodes ESC+CR/LF as Shift+Enter (VS Code integrated terminal's encoding)", () => {
    const d = new KeyDecoder();
    expect(d.feed(b("\x1b\r"))).toEqual([{ t: "shift-enter" }]);
    expect(d.feed(b("\x1b\n"))).toEqual([{ t: "shift-enter" }]);
  });

  it("discards an unrecognized modified-arrow CSI sequence (e.g. Ctrl+Up)", () => {
    const d = new KeyDecoder();
    expect(d.feed(b("\x1b[1;5A"))).toEqual([]);
    expect(d.feed(b("h"))).toEqual([{ t: "printable", ch: "h" }]);
  });
});
