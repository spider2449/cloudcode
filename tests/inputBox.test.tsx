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
