import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputBox } from "../src/ui/InputBox.js";
import { buildRegistry } from "../src/commands/builtins.js";
import type { CompletionContext } from "../src/commands/completion.js";
import { History } from "../src/agent/history.js";

const wait = () => new Promise(r => setTimeout(r, 20));

const tempHistory = () => new History(join(mkdtempSync(join(tmpdir(), "cc-")), "history.json"));

const completionCtx = (): CompletionContext => ({
  registry: buildRegistry(),
  providerNames: () => [],
  availableModels: () => [],
  listFiles: () => []
});

describe("InputBox", () => {
  it("submits typed text on Enter", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBox completionCtx={completionCtx()} onSubmit={onSubmit} disabled={false} history={tempHistory()} />);
    await wait();
    stdin.write("hi");
    await wait();
    stdin.write("\r");
    await wait();
    expect(onSubmit).toHaveBeenCalledWith("hi");
  });

  it("submits a full line pasted as one chunk with trailing newline", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBox completionCtx={completionCtx()} onSubmit={onSubmit} disabled={false} history={tempHistory()} />);
    await wait();
    stdin.write("/model claude-opus-4-8\r");
    await wait();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("/model claude-opus-4-8");
  });

  it("submits each line of a multi-line paste separately, leaving nothing behind", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<InputBox completionCtx={completionCtx()} onSubmit={onSubmit} disabled={false} history={tempHistory()} />);
    await wait();
    stdin.write("/model a\r/model b\r");
    await wait();
    expect(onSubmit.mock.calls).toEqual([["/model a"], ["/model b"]]);
    expect(lastFrame()).not.toContain("model");
  });

  it("shows slash completions", async () => {
    const { stdin, lastFrame } = render(<InputBox completionCtx={completionCtx()} onSubmit={() => {}} disabled={false} history={tempHistory()} />);
    await wait();
    stdin.write("/pro");
    await wait();
    expect(lastFrame()).toContain("provider");
  });

  it("moves the cursor left and inserts at the cursor", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBox completionCtx={completionCtx()} onSubmit={onSubmit} disabled={false} history={tempHistory()} />);
    await wait();
    stdin.write("ac");
    await wait();
    stdin.write("[D"); // left arrow
    await wait();
    stdin.write("b");
    await wait();
    stdin.write("\r");
    await wait();
    expect(onSubmit).toHaveBeenCalledWith("abc");
  });

  it("recalls history with up arrow and restores draft with down arrow", async () => {
    const onSubmit = vi.fn();
    const history = tempHistory();
    history.add("previous command");
    const { stdin, lastFrame } = render(<InputBox completionCtx={completionCtx()} onSubmit={onSubmit} disabled={false} history={history} />);
    await wait();
    stdin.write("draft");
    await wait();
    stdin.write("[A"); // up arrow
    await wait();
    expect(lastFrame()).toContain("previous command");
    stdin.write("[B"); // down arrow
    await wait();
    expect(lastFrame()).toContain("draft");
  });

  it("adds submitted text to history", async () => {
    const history = tempHistory();
    const { stdin } = render(<InputBox completionCtx={completionCtx()} onSubmit={() => {}} disabled={false} history={history} />);
    await wait();
    stdin.write("remember me\r");
    await wait();
    expect(history.back()).toBe("remember me");
  });

  it("submits on Enter when the input already equals the only suggestion", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBox completionCtx={completionCtx()} onSubmit={onSubmit} disabled={false} history={tempHistory()} />);
    await wait();
    stdin.write("/theme dark");
    await wait();
    stdin.write("\r");
    await wait();
    expect(onSubmit).toHaveBeenCalledWith("/theme dark");
  });

  it("submits a fully typed completion value even with trailing whitespace", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBox completionCtx={completionCtx()} onSubmit={onSubmit} disabled={false} history={tempHistory()} />);
    await wait();
    stdin.write("/config permissionMode bypassPermissions ");
    await wait();
    stdin.write("\r");
    await wait();
    expect(onSubmit).toHaveBeenCalledWith("/config permissionMode bypassPermissions");
  });

  // Finding 1b (re-review): the suggestion menu's rendered row count must
  // never diverge from what was last reported via onMenuRowsChange, even on
  // a render that isn't triggered by a keystroke (e.g. App.tsx's 1s
  // elapsed-timer re-render). Before the fix, InputBox recomputed
  // `suggestions` fresh at render time from the live, mutable
  // completionCtx on EVERY render (including ones with no input event), so
  // if the underlying data (e.g. availableModels()/registry) grew between
  // renders, the menu could render more rows than App.tsx's floor knew
  // about. The fix stores `suggestions` in state, written only inside
  // sync() (called from update()/the Escape branch/the mount effect), so a
  // re-render with unchanged props/state can never show more suggestions
  // than the last onMenuRowsChange report.
  it("re-rendering with a growing completion source does not grow the menu without a matching onMenuRowsChange call", async () => {
    const onMenuRowsChange = vi.fn();
    let models: string[] = [];
    const ctx: CompletionContext = {
      registry: buildRegistry(),
      providerNames: () => [],
      availableModels: () => models,
      listFiles: () => []
    };
    const { stdin, lastFrame, rerender } = render(
      <InputBox
        completionCtx={ctx}
        onSubmit={() => {}}
        disabled={false}
        history={tempHistory()}
        onMenuRowsChange={onMenuRowsChange}
      />
    );
    await wait();
    stdin.write("/model ");
    await wait();
    const reportedAfterTyping = onMenuRowsChange.mock.calls.at(-1)?.[0];
    expect(reportedAfterTyping).toBe(0); // no models available yet

    // Simulate the completion source growing (e.g. fetchModels() resolving)
    // with NO stdin event — just a re-render, like App's elapsed-timer tick.
    models = ["model-a", "model-b", "model-c"];
    onMenuRowsChange.mockClear();
    rerender(
      <InputBox
        completionCtx={ctx}
        onSubmit={() => {}}
        disabled={false}
        history={tempHistory()}
        onMenuRowsChange={onMenuRowsChange}
      />
    );
    await wait();

    // The render must not show more suggestion rows than were reported.
    const shownRows = (lastFrame() ?? "").split("\n").filter(l => l.includes("model-")).length;
    const lastReported = onMenuRowsChange.mock.calls.at(-1)?.[0] ?? reportedAfterTyping;
    expect(shownRows).toBeLessThanOrEqual(lastReported);
  });

  it("continues to a new line when the line ends with backslash", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBox completionCtx={completionCtx()} onSubmit={onSubmit} disabled={false} history={tempHistory()} />);
    await wait();
    stdin.write("line one\\");
    await wait();
    stdin.write("\r");
    await wait();
    expect(onSubmit).not.toHaveBeenCalled();
    stdin.write("line two");
    await wait();
    stdin.write("\r");
    await wait();
    expect(onSubmit).toHaveBeenCalledWith("line one\nline two");
  });
});
