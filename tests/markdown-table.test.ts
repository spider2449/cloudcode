import { describe, it, expect } from "vitest";
import { columnWidths, renderTable } from "../src/ui/markdown/table.js";
import type { Theme } from "../src/ui/theme.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const THEME: Theme = {
  user: "#00ff00", accent: "#ff00ff", muted: "#808080", error: "#ff0000",
  success: "#00ff00", removed: "#ff0000", warning: "#ffff00", thinking: "#808080"
};

describe("columnWidths", () => {
  it("sizes columns by their widest cell when the pane allows it", () => {
    // Content: 3 + 2 + 2 wide; each column costs len+2 → 5+4+4 = 13 ≤ 60-4.
    const widths = columnWidths([3, 2, 2], [[17, 1, 1]], 60);
    expect(widths).toEqual([19, 4, 4]);
  });

  it("shrinks proportionally with a floor and never exceeds the budget", () => {
    const headerLens = [1, 4, 4, 5, 8];
    const rowLens = [
      [1, 14, 5, 130, 6],
      [1, 18, 5, 95, 26]
    ];
    const width = 80;
    const n = headerLens.length;
    const widths = columnWidths(headerLens, rowLens, width);
    expect(widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(width - (n + 1));
    for (const w of widths) expect(w).toBeGreaterThanOrEqual(6);
  });
});

describe("renderTable", () => {
  const HEADER = ["Col A", "B", "C"];
  const ROWS = [["a", "b", "c"], ["longer value here", "x", "y"]];

  it("keeps every rendered line within the pane width", () => {
    const widths = columnWidths(
      HEADER.map((c) => c.length),
      ROWS.map((r) => r.map((c) => c.length)),
      30
    );
    const out = strip(renderTable(HEADER, ROWS, widths, THEME));
    for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(30);
    expect(out).toContain("longer");
  });

  it("does not paint headers red when a theme is given", () => {
    const out = renderTable(HEADER, ROWS, [10, 5, 5], THEME);
    expect(out).not.toContain("\x1b[31m");
  });

  it("pads short rows so borders stay aligned", () => {
    const out = strip(renderTable(["A"], [["x"], ["y", "extra"]], [8], THEME));
    const lines = out.split("\n");
    for (const l of lines.slice(1)) expect(l.length).toBe(lines[1].length);
  });
});
