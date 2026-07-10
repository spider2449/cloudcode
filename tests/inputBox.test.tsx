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
    stdin.write("hi");
    await wait();
    stdin.write("\r");
    await wait();
    expect(onSubmit).toHaveBeenCalledWith("hi");
  });

  it("shows slash completions", async () => {
    const { stdin, lastFrame } = render(<InputBox registry={buildRegistry()} onSubmit={() => {}} disabled={false} />);
    stdin.write("/pro");
    await wait();
    expect(lastFrame()).toContain("provider");
  });
});
