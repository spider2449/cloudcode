import { describe, it, expect, vi } from "vitest";
import { parseSlash } from "../src/commands/registry.js";
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
    exit: vi.fn(),
    listPermissionRules: vi.fn().mockReturnValue("✓ Write /p/src"),
    clearPermissionRules: vi.fn(),
    mcpStatus: vi.fn().mockResolvedValue("github  connected  tools: get_repo")
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
    expect(names).toEqual(["clear", "cost", "exit", "help", "mcp", "model", "permissions", "provider", "resume"]);
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

describe("/mcp", () => {
  it("prints the formatted MCP status", async () => {
    const ctx = mockCtx();
    const registry = buildRegistry();
    await registry.get("mcp")!.run(ctx, "");
    expect(ctx.notice).toHaveBeenCalledWith("github  connected  tools: get_repo");
  });
});

describe("/permissions list and clear", () => {
  it("lists rules", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("permissions")!.run(ctx, "list");
    expect(ctx.listPermissionRules).toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith("✓ Write /p/src");
    expect(ctx.setPermissionMode).not.toHaveBeenCalled();
  });

  it("clears rules", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("permissions")!.run(ctx, "clear");
    expect(ctx.clearPermissionRules).toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith("Cleared all permission rules for this project.");
    expect(ctx.setPermissionMode).not.toHaveBeenCalled();
  });
});

