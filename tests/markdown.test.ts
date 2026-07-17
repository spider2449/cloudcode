import { describe, it, expect, beforeAll } from "vitest";
import { renderMarkdown } from "../src/ui/markdown.js";

describe("renderMarkdown", () => {
  beforeAll(() => {
    process.env.FORCE_COLOR = "3";
  });

  it("styles bold text (output differs from input, keeps content)", () => {
    const out = renderMarkdown("**bold** word");
    expect(out).toContain("bold");
    expect(out).toContain("word");
    expect(out).not.toBe("**bold** word");
  });

  it("renders code blocks with their content preserved", () => {
    const out = renderMarkdown("```js\nconst x = 1;\n```");
    expect(out).toContain("const x = 1;");
  });

  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const THEME = {
    user: "#00ff00", accent: "#ff00ff", muted: "#808080", error: "#ff0000",
    success: "#00ff00", removed: "#ff0000", warning: "#ffff00", thinking: "#808080"
  };
  const TABLE_MD = "| Col A | B | C |\n| --- | --- | --- |\n| a | b | c |\n| longer value here | x | y |";

  it("sizes table columns by content instead of splitting width evenly", () => {
    const out = strip(renderMarkdown(TABLE_MD, 60, THEME));
    // With content-based widths there is room for the long cell on one line;
    // an even 3-way split of 60 would force it to wrap.
    expect(out).toContain("longer value here");
    for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(60);
  });

  it("colors headings with the theme accent instead of chalk defaults", () => {
    const out = renderMarkdown("# Title", 60, THEME);
    expect(out).toContain("\x1b[38;2;255;0;255m");
  });

  it("does not paint table headers with cli-table3's default red when a theme is given", () => {
    const out = renderMarkdown(TABLE_MD, 60, THEME);
    expect(out).not.toContain("\x1b[31m");
  });

  it("indents nested list items by 2 columns per level, not 4", () => {
    const out = strip(renderMarkdown("- top\n  - nested", 60, THEME));
    const nested = out.split("\n").find(l => l.includes("nested"))!;
    expect(nested.length - nested.trimStart().length).toBeLessThanOrEqual(4);
  });

  it("wraps long list items to the width with a hanging indent", () => {
    // marked-terminal's reflowText only reflows paragraphs and headings --
    // list items pass through unwrapped, so without our own wrap the app's
    // generic wrapText hard-cuts them, stranding orphan words at column 0.
    const md = "1. first item with quite a lot of text that must wrap across several lines at this width\n2. second";
    const lines = strip(renderMarkdown(md, 40, THEME)).split("\n");
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(40);
    // Continuation lines align under the item's text, not at column 0.
    const first = lines.findIndex(l => l.includes("first"));
    const textCol = lines[first].indexOf("first");
    for (let i = first + 1; i < lines.length && !lines[i].includes("2."); i++) {
      if (lines[i].trim() === "") continue;
      expect(lines[i].startsWith(" ".repeat(textCol))).toBe(true);
    }
  });

  it("falls back to raw text when the renderer throws", () => {
    // A lone surrogate can break downstream renderers; whatever the trigger,
    // the contract is: never throw, return something containing the input.
    const weird = "text with \ud800 lone surrogate";
    expect(() => renderMarkdown(weird)).not.toThrow();
    expect(renderMarkdown("plain")).toContain("plain");
  });
});
