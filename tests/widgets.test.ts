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
  it("joins segments with the middle dot in provider/model/mode order", () => {
    const row = renderStatusBar(
      { provider: "anthropic", model: "sonnet", mode: "default", cwd: "/repo" },
      theme, 80
    );
    expect(row).toContain("anthropic/sonnet");
    expect(row).toContain("default");
    expect(row).toContain("/repo");
    expect(row).toContain(" · ");
  });

  it("shows served-model arrow when servedModel differs from requested model", () => {
    const row = renderStatusBar(
      { provider: "anthropic", model: "sonnet", servedModel: "sonnet-5", mode: "default", cwd: "/repo" },
      theme, 80
    );
    expect(row).toContain("sonnet→sonnet-5");
  });

  it("includes git branch with a dirty marker when dirty", () => {
    const row = renderStatusBar(
      { provider: "a", mode: "default", cwd: "/r", gitBranch: "main", gitDirty: true },
      theme, 80
    );
    expect(row).toContain("⎇ main*");
  });

  it("omits token/cost/elapsed segments when not provided or zero", () => {
    const row = renderStatusBar({ provider: "a", mode: "default", cwd: "/r" }, theme, 80);
    expect(row).not.toContain("tok");
    expect(row).not.toContain("$");
  });

  it("appends the scroll hint when scrollHint is true", () => {
    const row = renderStatusBar({ provider: "a", mode: "default", cwd: "/r", scrollHint: true }, theme, 80);
    expect(row).toContain("Press End to jump to latest");
  });
});
