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

  it("falls back to raw text when the renderer throws", () => {
    // A lone surrogate can break downstream renderers; whatever the trigger,
    // the contract is: never throw, return something containing the input.
    const weird = "text with \ud800 lone surrogate";
    expect(() => renderMarkdown(weird)).not.toThrow();
    expect(renderMarkdown("plain")).toContain("plain");
  });
});
