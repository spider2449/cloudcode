import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The embedded TUI owns its cursor and scrolling presentation: the terminal
// pane must not show xterm's native viewport scrollbar. Its thumb parks at
// the bottom-right corner while following the tail and reads as a spurious
// second input cursor there.
const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "desktop", "renderer", "style.css"),
  "utf8"
);

describe("desktop terminal scrollbar", () => {
  it("hides the xterm viewport scrollbar in the terminal pane", () => {
    expect(css).toMatch(/\.terminal-host\s+\.xterm-viewport\s*\{[^}]*scrollbar-width:\s*none/);
  });

  it("hides the Chromium scrollbar for the xterm viewport", () => {
    expect(css).toMatch(/\.terminal-host\s+\.xterm-viewport::-webkit-scrollbar\s*\{[^}]*display:\s*none/);
  });
});
