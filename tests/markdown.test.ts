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

  it("keeps an over-wide table within the pane width", () => {
    // Shape from a real review table: several narrow columns plus one huge
    // Issue column. Proportional shrink floors narrow columns at 6, which
    // must not push the total past the pane width.
    const md =
      "| # | File | Line | Issue | Severity |\n" +
      "| --- | --- | --- | --- | --- |\n" +
      "| 1 | engine/loop.ts | 100 | fire-and-forget with no error handling so a thrown error is silently swallowed and the session file will not be appended at all | Medium |\n" +
      "| 4 | engine/mcpClient.ts | 15-20 | MCP servers spawned as subprocesses with user-configured commands could execute arbitrary code | Low (depends on trust model) |";
    const out = strip(renderMarkdown(md, 80, THEME));
    for (const line of out.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
      // An over-wide table gets re-wrapped into fragments that lose their
      // right border; every rendered line must still be a complete row.
      expect(line).toMatch(/[│┐┤┘]$/);
    }
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

  it("re-wraps loose list items as one paragraph instead of stranding orphan words", () => {
    // With a nested bullet the item becomes a loose list: marked-terminal
    // reflows the item's paragraph at the full width and THEN prepends the
    // list indent, leaving every line a few columns over-width. Wrapping
    // those lines one at a time spills the last word of each onto its own
    // row ("orphan words").
    const md =
      '2. **`edit.ts` uses `text.replace(oldStr, newStr)` — single match only, but the user-facing message says "must match exactly and be unique unless replace_all is true"**\n' +
      "\n" +
      "   - The `replace_all` flag is the only way to do multiple replacements.\n";
    const lines = strip(renderMarkdown(md, 65, THEME)).split("\n");
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(65);
      // No orphan rows: a continuation row holding a single short word.
      const t = line.trim();
      if (t !== "") expect(t.includes(" ") || t.length > 12).toBe(true);
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
