import { describe, it, expect, vi } from "vitest";
import { parseSlash, completions } from "../src/commands/registry.js";
import { buildRegistry } from "../src/commands/builtins.js";
import type { CommandContext } from "../src/commands/types.js";

function mockCtx(): CommandContext {
  return {
    notice: vi.fn(),
    clearSession: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    switchProvider: vi.fn().mockResolvedValue(undefined),
    openResumePicker: vi.fn(),
    costSummary: vi.fn().mockReturnValue("$0.01"),
    providerNames: vi.fn().mockReturnValue(["anthropic", "local"]),
    exit: vi.fn()
  };
}

describe("parseSlash", () => {
  it("parses name and args", () => {
    expect(parseSlash("/model claude-sonnet-5")).toEqual({ name: "model", args: "claude-sonnet-5" });
  });
  it("returns undefined for plain text", () => {
    expect(parseSlash("hello /world")).toBeUndefined();
  });
});

describe("builtins", () => {
  it("registers all v1 commands", () => {
    const names = [...buildRegistry().keys()].sort();
    expect(names).toEqual(["clear", "cost", "exit", "help", "model", "permissions", "provider", "resume"]);
  });

  it("/model with arg sets model; without arg notices usage", async () => {
    const reg = buildRegistry();
    const ctx = mockCtx();
    await reg.get("model")!.run(ctx, "claude-sonnet-5");
    expect(ctx.setModel).toHaveBeenCalledWith("claude-sonnet-5");
    await reg.get("model")!.run(ctx, "");
    expect(ctx.notice).toHaveBeenCalledWith("Usage: /model <model-name>");
  });

  it("/permissions rejects unknown mode", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("permissions")!.run(ctx, "yolo");
    expect(ctx.setPermissionMode).not.toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith("Valid modes: default, acceptEdits, bypassPermissions");
  });

  it("/provider switches provider", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("provider")!.run(ctx, "local");
    expect(ctx.switchProvider).toHaveBeenCalledWith("local");
  });
});

describe("completions", () => {
  it("matches by prefix", () => {
    expect(completions(buildRegistry(), "pro")).toEqual(["provider"]);
    expect(completions(buildRegistry(), "c")).toEqual(["clear", "cost"]);
  });
});
