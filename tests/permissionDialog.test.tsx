import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { PermissionDialog } from "../src/ui/PermissionDialog.js";

const wait = () => new Promise(r => setTimeout(r, 20));

describe("PermissionDialog", () => {
  it("renders the tool request and resolves yes on 'y'", async () => {
    const onDecision = vi.fn();
    const { stdin, lastFrame } = render(
      <PermissionDialog request={{ toolName: "Bash", input: { command: "ls" } }} onDecision={onDecision} />
    );
    expect(lastFrame()).toContain("Bash");
    expect(lastFrame()).toContain("ls");
    await wait();
    stdin.write("y");
    await wait();
    expect(onDecision).toHaveBeenCalledWith(true);
  });

  it("resolves no on 'n'", async () => {
    const onDecision = vi.fn();
    const { stdin } = render(
      <PermissionDialog request={{ toolName: "Bash", input: { command: "ls" } }} onDecision={onDecision} />
    );
    await wait();
    stdin.write("n");
    await wait();
    expect(onDecision).toHaveBeenCalledWith(false);
  });
});
