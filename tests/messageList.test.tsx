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
});
