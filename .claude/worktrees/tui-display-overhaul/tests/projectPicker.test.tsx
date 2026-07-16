import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { ProjectPicker } from "../src/ui/ProjectPicker.js";
import { ThemeProvider } from "../src/ui/ThemeContext.js";
import { THEMES } from "../src/ui/theme.js";
import { MAX_ROWS } from "../src/ui/SuggestionMenu.js";

const wait = () => new Promise(r => setTimeout(r, 20));

function renderPicker(projects: string[], onPick = vi.fn(), onCancel = vi.fn()) {
  const utils = render(
    <ThemeProvider theme={THEMES.dark}>
      <ProjectPicker projects={projects} currentCwd="/cur" onPick={onPick} onCancel={onCancel} />
    </ThemeProvider>
  );
  return { ...utils, onPick, onCancel };
}

describe("ProjectPicker", () => {
  it("lists projects and marks the current one", () => {
    const { lastFrame } = renderPicker(["/cur", "/other"]);
    expect(lastFrame()).toContain("● /cur");
    expect(lastFrame()).toContain("/other");
  });

  it("picks a project with arrows and enter", async () => {
    const { stdin, onPick } = renderPicker(["/cur", "/other"]);
    await wait();
    stdin.write("\x1b[B"); // down arrow
    await wait();
    stdin.write("\r");
    await wait();
    expect(onPick).toHaveBeenCalledWith("/other");
  });

  it("selecting the current project cancels instead", async () => {
    const { stdin, onPick, onCancel } = renderPicker(["/cur", "/other"]);
    await wait();
    stdin.write("\r");
    await wait();
    expect(onPick).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it("escape cancels", async () => {
    const { stdin, onCancel } = renderPicker(["/cur"]);
    await wait();
    stdin.write("\x1b");
    await wait();
    expect(onCancel).toHaveBeenCalled();
  });

  // Finding 1c (re-review): ProjectPicker used to .map() over every project
  // with no cap, so N recent projects meant N+3 rendered rows — unbounded
  // against App.tsx's overlayRows: 12 assumption. Must cap visible rows to
  // SuggestionMenu's MAX_ROWS regardless of entry count.
  it("caps visible entry rows to MAX_ROWS even with hundreds of recent projects", async () => {
    const projects = Array.from({ length: 200 }, (_, i) => `/proj-${i}`);
    const { lastFrame } = renderPicker(projects);
    await wait();
    const frame = lastFrame() ?? "";
    const entryLines = frame.split("\n").filter(l => l.includes("/proj-"));
    expect(entryLines.length).toBeLessThanOrEqual(MAX_ROWS);
  });
});
