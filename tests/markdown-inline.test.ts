import { describe, it, expect } from "vitest";
import { renderInline, renderLink } from "../src/ui/markdown/inline.js";
import type { Theme } from "../src/ui/theme.js";

const THEME: Theme = {
  user: "#00ff00", accent: "#ff00ff", muted: "#808080", error: "#ff0000",
  success: "#00ff00", removed: "#ff0000", warning: "#ffff00", thinking: "#808080"
};

describe("inline renderers", () => {
  it("bolds, italicizes, strikes, and colors codespans", () => {
    expect(renderInline("strong", "x")).toBe("\x1b[1mx\x1b[22m");
    expect(renderInline("em", "x")).toBe("\x1b[3mx\x1b[23m");
    expect(renderInline("del", "x")).toBe("\x1b[9mx\x1b[29m");
    expect(renderInline("codespan", "x", THEME)).toContain("\x1b[38;2;255;0;255m");
  });

  it("shows link href only when it differs from the label", () => {
    const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    expect(strip(renderLink("Example", "https://e.com", THEME))).toContain("(https://e.com)");
    // Self-referencing labels and anchors/emails stay clean.
    expect(strip(renderLink("https://e.com", "https://e.com", THEME))).not.toContain("(");
    expect(strip(renderLink("Section", "#anchor", THEME))).not.toContain("(");
    expect(strip(renderLink("Mail", "mailto:a@b.c", THEME))).not.toContain("(");
  });
});
