import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { WorkingIndicator } from "../src/ui/WorkingIndicator.js";

describe("WorkingIndicator", () => {
  it("shows label and elapsed seconds", () => {
    const { lastFrame } = render(<WorkingIndicator label="Running Bash" startedAt={Date.now() - 3500} />);
    expect(lastFrame()).toContain("Running Bash…");
    expect(lastFrame()).toMatch(/\(3s · Esc to interrupt\)/);
  });
});
