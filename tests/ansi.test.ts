import { describe, it, expect } from "vitest";
import { BRACKETED_PASTE_ON, BRACKETED_PASTE_OFF,
  CURSOR_HIDE, CURSOR_SHOW, CLEAR_AND_HOME, cursorTo, sgr, SGR_RESET, ERASE_DOWN, cursorUp } from "../src/ui/term/ansi.js";

describe("ansi", () => {
  it("exposes the exact escape sequences the spec requires", () => {
    expect(BRACKETED_PASTE_ON).toBe("\x1b[?2004h");
    expect(BRACKETED_PASTE_OFF).toBe("\x1b[?2004l");
    expect(CURSOR_HIDE).toBe("\x1b[?25l");
    expect(CURSOR_SHOW).toBe("\x1b[?25h");
    expect(CLEAR_AND_HOME).toBe("\x1b[2J\x1b[H");
    expect(SGR_RESET).toBe("\x1b[0m");
  });

  it("cursorTo builds a 1-indexed row;col escape", () => {
    expect(cursorTo(1, 1)).toBe("\x1b[1;1H");
    expect(cursorTo(24, 80)).toBe("\x1b[24;80H");
  });

  it("sgr maps known color names to SGR codes and passes through gracefully", () => {
    expect(sgr("red")).toBe("\x1b[31m");
    expect(sgr("green")).toBe("\x1b[32m");
    expect(sgr("yellow")).toBe("\x1b[33m");
    expect(sgr("blue")).toBe("\x1b[34m");
    expect(sgr("magenta")).toBe("\x1b[35m");
    expect(sgr("cyan")).toBe("\x1b[36m");
    expect(sgr("white")).toBe("\x1b[37m");
    expect(sgr("gray")).toBe("\x1b[90m");
    expect(sgr("blackBright")).toBe("\x1b[90m");
    expect(sgr(undefined)).toBe("");
  });
});

describe("relative movement helpers", () => {
  it("ERASE_DOWN clears from cursor to end of screen", () => {
    expect(ERASE_DOWN).toBe("\x1b[0J");
  });

  it("cursorUp emits CUU for positive counts", () => {
    expect(cursorUp(3)).toBe("\x1b[3A");
    expect(cursorUp(1)).toBe("\x1b[1A");
  });

  it("cursorUp emits nothing for zero or negative counts", () => {
    expect(cursorUp(0)).toBe("");
    expect(cursorUp(-2)).toBe("");
  });
});
