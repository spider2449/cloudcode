import { describe, it, expect } from "vitest";
import { renderStatusBar, formatTokens, formatElapsed } from "../src/ui/widgets/statusBar.js";
import { THEMES } from "../src/ui/theme.js";

const theme = THEMES.dark;

describe("formatTokens", () => {
  it("formats sub-1000 counts as raw tokens", () => {
    expect(formatTokens(500)).toBe("500 tok");
  });
  it("formats >=1000 counts in k with one decimal", () => {
    expect(formatTokens(12345)).toBe("12.3k tok");
  });
});

describe("formatElapsed", () => {
  it("formats sub-minute durations as seconds", () => {
    expect(formatElapsed(45_000)).toBe("45s");
  });
  it("formats sub-hour durations as minutes and seconds", () => {
    expect(formatElapsed(125_000)).toBe("2m 5s");
  });
  it("formats hour-plus durations as h/m/s", () => {
    expect(formatElapsed(3_725_000)).toBe("1h 2m 5s");
  });
});

describe("renderStatusBar", () => {
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

  it("joins segments with the middle dot in provider/model/mode order", () => {
    const text = renderStatusBar(
      { provider: "anthropic", model: "sonnet", mode: "default", cwd: "/repo" },
      theme, 80
    ).join("\n");
    expect(text).toContain("anthropic/sonnet");
    expect(text).toContain("default");
    expect(text).toContain("/repo");
    expect(text).toContain(" · ");
  });

  it("shows served-model arrow when servedModel differs from requested model", () => {
    const text = renderStatusBar(
      { provider: "anthropic", model: "sonnet", servedModel: "sonnet-5", mode: "default", cwd: "/repo" },
      theme, 80
    ).join("\n");
    expect(text).toContain("sonnet→sonnet-5");
  });

  it("includes git branch with a dirty marker when dirty", () => {
    const text = renderStatusBar(
      { provider: "a", mode: "default", cwd: "/r", gitBranch: "main", gitDirty: true },
      theme, 80
    ).join("\n");
    expect(text).toContain("⎇ main*");
  });

  it("omits token/cost/elapsed segments when not provided or zero", () => {
    const text = renderStatusBar({ provider: "a", mode: "default", cwd: "/r" }, theme, 80).join("\n");
    expect(text).not.toContain("tok");
    expect(text).not.toContain("$");
  });

  it("stays on one row when all segments fit the width", () => {
    const rows = renderStatusBar({ provider: "a", mode: "default", cwd: "/r" }, theme, 80);
    expect(rows).toHaveLength(1);
  });

  it("wraps at segment boundaries onto extra rows when the width is narrow", () => {
    const rows = renderStatusBar(
      { provider: "anthropic", model: "sonnet", mode: "acceptEdits", gitBranch: "master", gitDirty: true, elapsedMs: 55_000, cwd: "D:\\spider\\working\\cloudcode\\release" },
      theme, 44
    );
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      const visible = stripAnsi(row);
      expect(visible.length).toBeLessThanOrEqual(44);
      // Segments are kept whole: rows never end or start mid-separator.
      expect(visible.startsWith("· ")).toBe(false);
      expect(visible.endsWith(" ·")).toBe(false);
    }
    // Nothing is lost: every segment appears somewhere.
    const all = rows.map(stripAnsi).join("\n");
    for (const seg of ["anthropic/sonnet", "acceptEdits", "⎇ master*", "55s", "D:\\spider\\working\\cloudcode\\release"]) {
      expect(all).toContain(seg);
    }
  });

  it("truncates a single segment wider than the terminal with an ellipsis on its own row", () => {
    const rows = renderStatusBar(
      { provider: "a", mode: "default", cwd: "X".repeat(60) },
      theme, 20
    );
    for (const row of rows) expect(stripAnsi(row).length).toBeLessThanOrEqual(20);
    expect(rows.map(stripAnsi).join("\n")).toContain("…");
  });
});

import { renderWorkInd } from "../src/ui/widgets/workInd.js";

describe("renderWorkInd", () => {
  const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  it("cycles the spinner glyph by frame index", () => {
    expect(renderWorkInd(0, "Thinking", 0, THEMES.dark)).toContain(SPINNER[0]);
    expect(renderWorkInd(3, "Thinking", 0, THEMES.dark)).toContain(SPINNER[3]);
    expect(renderWorkInd(SPINNER.length, "Thinking", 0, THEMES.dark)).toContain(SPINNER[0]);
  });

  it("includes the label and elapsed seconds with the interrupt hint", () => {
    const row = renderWorkInd(0, "Running Read", 4200, THEMES.dark);
    expect(row).toContain("Running Read…");
    expect(row).toContain("(4s · Esc to interrupt)");
  });
});

import { renderProgress } from "../src/ui/widgets/progress.js";

describe("renderProgress", () => {
  it("renders a filled/empty bar proportional to pct at the default width", () => {
    const row = renderProgress("Compacting", 50, THEMES.dark);
    expect(row).toContain("Compacting");
    expect(row).toContain("50%");
    expect(row).toContain("█".repeat(10));
    expect(row).toContain("░".repeat(10));
  });

  it("clamps pct to [0,100]", () => {
    expect(renderProgress("X", 150, THEMES.dark)).toContain("100%");
    expect(renderProgress("X", -10, THEMES.dark)).toContain("0%");
  });
});

import { renderMenu, visibleWindow, MAX_ROWS } from "../src/ui/widgets/menu.js";

describe("visibleWindow", () => {
  it("returns the full range when count fits within max", () => {
    expect(visibleWindow(3, 1, 8)).toEqual({ start: 0, end: 3 });
  });
  it("windows around the selected index once count exceeds max", () => {
    expect(visibleWindow(20, 15, 8)).toEqual({ start: 8, end: 16 });
  });
  it("clamps the window to the end of the list", () => {
    expect(visibleWindow(20, 19, 8)).toEqual({ start: 12, end: 20 });
  });
  it("defaults max to MAX_ROWS", () => {
    expect(MAX_ROWS).toBe(8);
  });
});

describe("renderMenu", () => {
  const suggestions = [
    { label: "/clear", description: "Clear the session" },
    { label: "/compact", description: "Compact context" }
  ];
  it("marks the selected row with the pointer glyph and accent color", () => {
    const rows = renderMenu(suggestions, 0, THEMES.dark, 80);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("▶ ");
    expect(rows[0]).toContain("/clear");
    expect(rows[1]).not.toContain("▶ ");
  });
  it("caps rows at MAX_ROWS regardless of suggestion count", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ label: `/cmd${i}`, description: "" }));
    expect(renderMenu(many, 10, THEMES.dark, 80)).toHaveLength(8);
  });
});
