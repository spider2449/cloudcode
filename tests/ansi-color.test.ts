import { describe, it, expect, afterEach } from "vitest";
import { sgr, setColorDepth, detectColorDepth } from "../src/ui/term/ansi.js";

afterEach(() => setColorDepth(detectColorDepth()));

describe("detectColorDepth", () => {
  it("honors COLORTERM", () => {
    expect(detectColorDepth({ COLORTERM: "truecolor" }, "linux")).toBe("truecolor");
    expect(detectColorDepth({ COLORTERM: "24bit" }, "linux")).toBe("truecolor");
  });
  it("treats win32 as truecolor (Win10+ conhost supports 24-bit SGR)", () => {
    expect(detectColorDepth({}, "win32")).toBe("truecolor");
  });
  it("falls back via TERM", () => {
    expect(detectColorDepth({ TERM: "xterm-256color" }, "linux")).toBe("256");
    expect(detectColorDepth({ TERM: "xterm" }, "linux")).toBe("16");
  });
});

describe("sgr with hex colors", () => {
  it("emits truecolor sequences", () => {
    setColorDepth("truecolor");
    expect(sgr("#bd93f9")).toBe("\x1b[38;2;189;147;249m");
  });
  it("downgrades to nearest 256-color", () => {
    setColorDepth("256");
    expect(sgr("#ff0000")).toBe("\x1b[38;5;196m");
    expect(sgr("#080808")).toBe("\x1b[38;5;232m");
  });
  it("downgrades to nearest basic-16", () => {
    setColorDepth("16");
    expect(sgr("#ff0000")).toBe("\x1b[91m");  // bright red
    expect(sgr("#800000")).toBe("\x1b[31m");  // dark red
    expect(sgr("#000080")).toBe("\x1b[34m");  // dark blue round-trips
  });
  it("keeps legacy names working and rejects garbage", () => {
    setColorDepth("truecolor");
    expect(sgr("blue")).toBe("\x1b[34m");
    expect(sgr("gray")).toBe("\x1b[90m");
    expect(sgr(undefined)).toBe("");
    expect(sgr("#zzz")).toBe("");
    expect(sgr("")).toBe("");
  });
});
