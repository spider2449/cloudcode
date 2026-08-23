import { describe, it, expect } from "vitest";
import {
  renderHeading, renderHr, renderBlockquote, renderCodeBlock
} from "../src/ui/markdown/block.js";
import type { Theme } from "../src/ui/theme.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const THEME: Theme = {
  user: "#00ff00", accent: "#ff00ff", muted: "#808080", error: "#ff0000",
  success: "#00ff00", removed: "#ff0000", warning: "#ffff00", thinking: "#808080"
};

describe("block renderers", () => {
  it("h1 gets an accent rule beneath sized to the text", () => {
    const out = renderHeading("Title", 1, 60, THEME);
    const lines = strip(out).split("\n");
    expect(lines[1]).toMatch(/^─+$/);
    expect(lines[1].length).toBe(5);
  });

  it("h1 rule never exceeds the pane width", () => {
    const lines = strip(renderHeading("x".repeat(80), 1, 40, THEME)).split("\n");
    expect(lines[1].length).toBe(40);
  });

  it("h3 is colored without a rule; h4+ are bold only", () => {
    expect(strip(renderHeading("Sub", 3, 60, THEME))).not.toContain("─");
    expect(renderHeading("Deep", 4)).toContain("\x1b[1m");
  });

  it("hr spans the full width", () => {
    expect(strip(renderHr(40, THEME))).toBe("─".repeat(40));
  });

  it("blockquote prefixes every line with a bar and fits the width", () => {
    const out = renderBlockquote(["word ".repeat(30).trim()], 20, THEME);
    for (const l of strip(out).split("\n")) {
      expect(l.startsWith("▌ ")).toBe(true);
      expect(l.length).toBeLessThanOrEqual(20);
    }
  });

  it("code box frames highlighted content within the width", () => {
    const out = renderCodeBlock("const x = 1;\nconst yy = 22;", "js", 30, THEME);
    const lines = strip(out).split("\n");
    expect(lines[0].startsWith("╭")).toBe(true);
    expect(lines.at(-1)!.startsWith("╰")).toBe(true);
    for (const l of strip(out).split("\n")) expect(l.length).toBeLessThanOrEqual(30);
    expect(strip(out)).toContain("const x = 1;");
  });
});
