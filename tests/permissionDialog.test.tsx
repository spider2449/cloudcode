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

  it("shows four options for file_path requests", async () => {
    const { lastFrame } = render(
      <PermissionDialog request={{ toolName: "Write", input: { file_path: "/p/a.ts" } }} onDecision={() => {}} />
    );
    await wait();
    const frame = lastFrame()!;
    expect(frame).toContain("Yes (y)");
    expect(frame).toContain("Always for this directory (a)");
    expect(frame).toContain("No (n)");
    expect(frame).toContain("Never for this directory (d)");
  });

  it("hotkey 'a' resolves allow with remember", async () => {
    const onDecision = vi.fn();
    const { stdin } = render(
      <PermissionDialog request={{ toolName: "Write", input: { file_path: "/p/a.ts" } }} onDecision={onDecision} />
    );
    await wait();
    stdin.write("a");
    await wait();
    expect(onDecision).toHaveBeenCalledWith(true, "allow");
  });

  it("hotkey 'd' resolves deny with remember", async () => {
    const onDecision = vi.fn();
    const { stdin } = render(
      <PermissionDialog request={{ toolName: "Write", input: { file_path: "/p/a.ts" } }} onDecision={onDecision} />
    );
    await wait();
    stdin.write("d");
    await wait();
    expect(onDecision).toHaveBeenCalledWith(false, "deny");
  });

  it("arrow + Enter selects 'Always for this directory'", async () => {
    const onDecision = vi.fn();
    const { stdin } = render(
      <PermissionDialog request={{ toolName: "Write", input: { file_path: "/p/a.ts" } }} onDecision={onDecision} />
    );
    await wait();
    stdin.write("[C"); // right arrow -> option index 1
    await wait();
    stdin.write("\r");
    await wait();
    expect(onDecision).toHaveBeenCalledWith(true, "allow");
  });

  it("offers Always/Never options for Bash commands", async () => {
    const { lastFrame } = render(
      <PermissionDialog request={{ toolName: "Bash", input: { command: "git status" } }} onDecision={() => {}} />
    );
    await wait();
    const frame = lastFrame()!;
    expect(frame).toContain("Always allow 'git' commands (a)");
    expect(frame).toContain("Never allow 'git' commands (d)");
  });

  it("keeps two options for requests without file_path", async () => {
    const { lastFrame } = render(
      <PermissionDialog request={{ toolName: "Bash", input: { command: "ls" } }} onDecision={() => {}} />
    );
    await wait();
    expect(lastFrame()).not.toContain("Always for this directory");
    expect(lastFrame()).toContain("Yes (y)");
    expect(lastFrame()).toContain("No (n)");
  });
});
