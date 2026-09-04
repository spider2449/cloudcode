import { describe, expect, it } from "vitest";
import { terminalKeySequence } from "../desktop/renderer/terminalKeys.js";

describe("terminalKeySequence", () => {
  it("encodes Enter and Shift+Enter for the TUI keyboard protocol", () => {
    expect(terminalKeySequence({ type: "keydown", key: "Enter", shiftKey: false })).toBe("\x1b[13u");
    expect(terminalKeySequence({ type: "keydown", key: "Enter", shiftKey: true })).toBe("\x1b[13;2u");
  });

  it("leaves other xterm key events on the default path", () => {
    expect(terminalKeySequence({ type: "keydown", key: "a", shiftKey: false })).toBeUndefined();
    expect(terminalKeySequence({ type: "keyup", key: "Enter", shiftKey: false })).toBeUndefined();
  });
});
