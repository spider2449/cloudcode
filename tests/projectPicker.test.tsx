import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { ProjectPicker } from "../src/ui/ProjectPicker.js";
import { ThemeProvider } from "../src/ui/ThemeContext.js";
import { THEMES } from "../src/ui/theme.js";

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
});
