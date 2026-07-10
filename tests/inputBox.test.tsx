import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { InputBox } from "../src/ui/InputBox.js";
import { buildRegistry } from "../src/commands/builtins.js";

const wait = () => new Promise(r => setTimeout(r, 20));

describe("InputBox", () => {
  it("submits typed text on Enter", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBox registry={buildRegistry()} onSubmit={onSubmit} disabled={false} />);
    await wait();
    stdin.write("hi");
    await wait();
    stdin.write("\r");
    await wait();
    expect(onSubmit).toHaveBeenCalledWith("hi");
  });

  it("submits a full line pasted as one chunk with trailing newline", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBox registry={buildRegistry()} onSubmit={onSubmit} disabled={false} />);
    await wait();
    stdin.write("/model claude-opus-4-8\r");
    await wait();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("/model claude-opus-4-8");
  });

  it("submits each line of a multi-line paste separately, leaving nothing behind", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<InputBox registry={buildRegistry()} onSubmit={onSubmit} disabled={false} />);
    await wait();
    stdin.write("/model a\r/model b\r");
    await wait();
    expect(onSubmit.mock.calls).toEqual([["/model a"], ["/model b"]]);
    expect(lastFrame()).not.toContain("model");
  });

  it("shows slash completions", async () => {
    const { stdin, lastFrame } = render(<InputBox registry={buildRegistry()} onSubmit={() => {}} disabled={false} />);
    await wait();
    stdin.write("/pro");
    await wait();
    expect(lastFrame()).toContain("provider");
  });
});
