import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { MessageList } from "../src/ui/MessageList.js";

describe("MessageList", () => {
  it("renders user, tool, and assistant items with prefixes", () => {
    const { lastFrame } = render(
      <MessageList items={[
        { kind: "user", text: "fix the bug" },
        { kind: "tool", label: "Read /x.ts" },
        { kind: "assistant", text: "Done." }
      ]} />
    );
    const frame = lastFrame()!;
    expect(frame).toContain("> fix the bug");
    expect(frame).toContain("⏺ Read /x.ts");
    expect(frame).toContain("Done.");
  });

  it("renders diff items with signs", () => {
    const { lastFrame } = render(
      <MessageList items={[
        { kind: "diff", lines: [{ sign: "-", text: "old line" }, { sign: "+", text: "new line" }] }
      ]} />
    );
    expect(lastFrame()).toContain("- old line");
    expect(lastFrame()).toContain("+ new line");
  });

  it("renders assistant markdown (bold survives as text)", () => {
    const { lastFrame } = render(
      <MessageList items={[{ kind: "assistant", text: "**hello** world" }]} />
    );
    expect(lastFrame()).toContain("hello");
    expect(lastFrame()).toContain("world");
    expect(lastFrame()).not.toContain("**hello**");
  });
});
