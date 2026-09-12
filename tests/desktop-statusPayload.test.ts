import { describe, expect, it } from "vitest";
import { formatStatusSegments, type DesktopStatusPayload } from "../src/desktop/statusPayload.js";
import { CHAT_EVENT_TYPES } from "../src/desktop/chatProtocol.js";

function base(over: Partial<DesktopStatusPayload> = {}): DesktopStatusPayload {
  return {
    provider: "anthropic",
    model: "sonnet",
    effort: "off",
    mode: "default",
    networkMode: "providerOnly",
    cwd: "D:/work/proj",
    costUsd: 0,
    statusLineItems: ["model", "mode", "branch", "tokens", "cost", "elapsed", "cwd"],
    ...over
  };
}

describe("desktop statusline segments", () => {
  it("mirrors the TUI model/mode/cwd segments", () => {
    expect(formatStatusSegments(base())).toEqual(["anthropic/sonnet", "default", "D:/work/proj"]);
  });
  it("shows cost/tokens/elapsed only when nonzero", () => {
    expect(formatStatusSegments(base({ costUsd: 0.0123, tokens: 1500, contextPct: 12, elapsedMs: 65_000 }))).toEqual([
      "anthropic/sonnet",
      "default",
      "1.5k tok (12%)",
      "$0.0123",
      "1m 5s",
      "D:/work/proj"
    ]);
  });
  it("overlays the renderer git branch in canonical order", () => {
    expect(formatStatusSegments(base({ branchInfo: { name: "main", dirty: true } }))).toContain("⎇ main*");
  });
  it("supports the served-model arrow like the TUI", () => {
    const segs = formatStatusSegments(
      base({ model: "sonnet", servedModel: "sonnet-5", statusLineItems: ["model", "servedModel", "mode"] })
    );
    expect(segs[0]).toBe("anthropic/sonnet→sonnet-5");
  });
});

describe("desktop status chat events", () => {
  it("declares status and statusline_picker event types", () => {
    expect(CHAT_EVENT_TYPES).toContain("status");
    expect(CHAT_EVENT_TYPES).toContain("statusline_picker");
  });
});
