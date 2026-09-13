import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Native chat has no xterm/PTY backend: no terminal- or xterm-scoped CSS may
// remain in the renderer stylesheet (comments excluded).
const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "renderer", "style.css"),
  "utf8"
);
const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("desktop native chat style", () => {
  it("has no terminal-scoped selectors", () => {
    expect(code).not.toMatch(/terminal-/);
  });

  it("has no xterm selectors", () => {
    expect(code).not.toMatch(/xterm/);
  });
});
