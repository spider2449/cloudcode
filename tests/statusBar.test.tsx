import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { StatusBar, formatTokens, formatElapsed } from "../src/ui/StatusBar.js";

describe("formatTokens", () => {
  it("formats small counts plainly", () => expect(formatTokens(950)).toBe("950 tok"));
  it("formats thousands with one decimal", () => expect(formatTokens(12345)).toBe("12.3k tok"));
});

describe("formatElapsed", () => {
  it("formats minutes and seconds", () => expect(formatElapsed(252000)).toBe("4m 12s"));
  it("formats hours when >= 1h", () => expect(formatElapsed(3723000)).toBe("1h 2m 3s"));
  it("formats seconds only under a minute", () => expect(formatElapsed(9000)).toBe("9s"));
});

describe("StatusBar", () => {
  it("renders all segments", () => {
    const { lastFrame } = render(
      <StatusBar provider="anthropic" model="claude-sonnet-5" mode="default" cwd="/repo"
        costUsd={0.0123} gitBranch="master" gitDirty tokens={12345} contextPct={6} elapsedMs={252000} />
    );
    const f = lastFrame()!;
    expect(f).toContain("anthropic/claude-sonnet-5");
    expect(f).toContain("⎇ master*");
    expect(f).toContain("12.3k tok (6%)");
    expect(f).toContain("$0.0123");
    expect(f).toContain("4m 12s");
    expect(f).toContain("/repo");
  });

  it("omits unavailable segments", () => {
    const { lastFrame } = render(
      <StatusBar provider="anthropic" mode="default" cwd="/repo" />
    );
    const f = lastFrame()!;
    expect(f).not.toContain("⎇");
    expect(f).not.toContain("tok");
    expect(f).not.toContain("$");
    expect(f).toContain("anthropic · default · /repo");
  });

  it("shows requested→served when the API served a different model", () => {
    const { lastFrame } = render(
      <StatusBar provider="anthropic" model="claude-sonnet-5" servedModel="claude-sonnet-5-20260203" mode="default" cwd="/r" />
    );
    expect(lastFrame()).toContain("anthropic/claude-sonnet-5→claude-sonnet-5-20260203");
  });

  it("shows just the model when served matches requested", () => {
    const { lastFrame } = render(
      <StatusBar provider="anthropic" model="m1" servedModel="m1" mode="default" cwd="/r" />
    );
    expect(lastFrame()).toContain("anthropic/m1 ·");
  });

  it("shows the served model when no model was requested", () => {
    const { lastFrame } = render(
      <StatusBar provider="anthropic" servedModel="m2" mode="default" cwd="/r" />
    );
    expect(lastFrame()).toContain("anthropic/m2");
  });

  it("shows tokens without percent when contextPct missing", () => {
    const { lastFrame } = render(
      <StatusBar provider="p" mode="default" cwd="/r" tokens={500} />
    );
    expect(lastFrame()).toContain("500 tok");
    expect(lastFrame()).not.toContain("%");
  });

  it("shows clean branch without asterisk", () => {
    const { lastFrame } = render(
      <StatusBar provider="p" mode="default" cwd="/r" gitBranch="dev" />
    );
    expect(lastFrame()).toContain("⎇ dev");
    expect(lastFrame()).not.toContain("dev*");
  });
});
