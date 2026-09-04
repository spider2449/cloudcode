import { describe, expect, it, vi } from "vitest";
import { runSlashCommand } from "../src/commands/runtime.js";
import type { Command, CommandContext } from "../src/commands/types.js";

describe("runSlashCommand", () => {
  it("leaves ordinary prompts for the agent", () => {
    expect(runSlashCommand("hello", new Map(), {} as CommandContext, {
      onUnknown: vi.fn(), onError: vi.fn()
    })).toBeUndefined();
  });

  it("runs registry commands with parsed arguments", async () => {
    const run = vi.fn(async () => {});
    const registry = new Map<string, Command>([["effort", { name: "effort", description: "", run }]]);
    const context = {} as CommandContext;

    await runSlashCommand("/effort high", registry, context, {
      onUnknown: vi.fn(), onError: vi.fn()
    });

    expect(run).toHaveBeenCalledWith(context, "high");
  });

  it("handles unknown commands without invoking the agent", async () => {
    const onUnknown = vi.fn();
    await runSlashCommand("/missing", new Map(), {} as CommandContext, {
      onUnknown, onError: vi.fn()
    });
    expect(onUnknown).toHaveBeenCalledWith("missing");
  });
});
