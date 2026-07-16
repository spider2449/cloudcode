import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { ResumePicker } from "../src/ui/ResumePicker.js";
import { ThemeProvider } from "../src/ui/ThemeContext.js";
import { THEMES } from "../src/ui/theme.js";
import { MAX_ROWS } from "../src/ui/SuggestionMenu.js";
import type { SessionEntry } from "../src/agent/sessionIndex.js";

const wait = () => new Promise(r => setTimeout(r, 20));

function entry(i: number): SessionEntry {
  return { id: `id-${i}`, cwd: "/p", firstMessage: `message ${i}`, timestamp: `2024-01-${String(i).padStart(2, "0")}`, provider: "anthropic" };
}

function renderPicker(entries: SessionEntry[], onPick = vi.fn(), onCancel = vi.fn()) {
  const utils = render(
    <ThemeProvider theme={THEMES.dark}>
      <ResumePicker entries={entries} onPick={onPick} onCancel={onCancel} />
    </ThemeProvider>
  );
  return { ...utils, onPick, onCancel };
}

describe("ResumePicker", () => {
  it("lists entries and picks with arrows and enter", async () => {
    const entries = [entry(1), entry(2)];
    const { stdin, onPick } = renderPicker(entries);
    await wait();
    stdin.write("\x1b[B"); // down arrow
    await wait();
    stdin.write("\r");
    await wait();
    expect(onPick).toHaveBeenCalledWith(entries[1]);
  });

  it("escape cancels", async () => {
    const { stdin, onCancel } = renderPicker([entry(1)]);
    await wait();
    stdin.write("\x1b");
    await wait();
    expect(onCancel).toHaveBeenCalled();
  });

  // Finding 1c (re-review): ResumePicker used to .map() over every entry
  // with no cap, so its total height (border + header + N entries) grew
  // unboundedly with past-session count, breaking App.tsx's overlayRows: 12
  // true-upper-bound assumption once N exceeded ~9. It must now cap visible
  // entry rows at SuggestionMenu's MAX_ROWS regardless of how many entries
  // exist.
  it("caps visible entry rows to MAX_ROWS even with hundreds of past sessions", async () => {
    const entries = Array.from({ length: 200 }, (_, i) => entry(i));
    const { lastFrame } = renderPicker(entries);
    await wait();
    const frame = lastFrame() ?? "";
    const entryLines = frame.split("\n").filter(l => l.includes("[anthropic]"));
    expect(entryLines.length).toBeLessThanOrEqual(MAX_ROWS);
  });

  it("scrolls the visible window to keep the selection in view when capped", async () => {
    const entries = Array.from({ length: 200 }, (_, i) => entry(i));
    const { stdin, lastFrame } = renderPicker(entries);
    await wait();
    for (let i = 0; i < 50; i++) {
      stdin.write("\x1b[B"); // down arrow
    }
    await wait();
    const frame = lastFrame() ?? "";
    // Entry 50 (0-indexed, selected after 50 down-arrows) must be visible.
    expect(frame).toContain("message 50");
  });
});
