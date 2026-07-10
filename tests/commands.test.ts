import { describe, it, expect, vi } from "vitest";
import { parseSlash } from "../src/commands/registry.js";
import { buildRegistry } from "../src/commands/builtins.js";
import { mergeSkillCommands } from "../src/commands/skillCommands.js";
import type { Skill } from "../src/agent/skills.js";
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
    mcpStatus: vi.fn().mockResolvedValue("github  connected  tools: get_repo"),
    sendPrompt: vi.fn(),
    listSkills: vi.fn().mockReturnValue("/a  does a  (project)"),
    setTheme: vi.fn(),
    listThemes: vi.fn().mockReturnValue("● dark\n  light\n  mono")
  };
}

describe("parseSlash", () => {
  it("parses name and args", () => {
    expect(parseSlash("/model claude-sonnet-5")).toEqual({ name: "model", args: "claude-sonnet-5" });
  });
  it("returns undefined for plain text", () => {
    expect(parseSlash("hello /world")).toBeUndefined();
  });

  it("parses hyphenated kebab-case names", () => {
    expect(parseSlash("/commit-helper fix typo")).toEqual({ name: "commit-helper", args: "fix typo" });
  });

  it("invokes a hyphenated skill command end-to-end", async () => {
    const skill: Skill = { name: "commit-helper", description: "Write a commit", content: "Do the thing.", source: "project" };
    const registry = mergeSkillCommands(buildRegistry(), [skill]);
    const parsed = parseSlash("/commit-helper fix typo")!;
    const cmd = registry.get(parsed.name)!;
    const ctx = { sendPrompt: vi.fn() } as unknown as CommandContext;
    await cmd.run(ctx, parsed.args);
    expect(ctx.sendPrompt).toHaveBeenCalledWith("Do the thing.\n\nARGUMENTS: fix typo");
  });
});

describe("builtins", () => {
  it("registers all v1 commands", () => {
    const names = [...buildRegistry().keys()].sort();
    expect(names).toEqual(["clear", "compact", "cost", "exit", "help", "init", "mcp", "model", "permissions", "provider", "resume", "skills", "theme"]);
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

describe("/compact and /init", () => {
  it("/compact forwards to the SDK", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("compact")!.run(ctx, "");
    expect(ctx.sendPrompt).toHaveBeenCalledWith("/compact");
  });

  it("/init forwards to the SDK", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("init")!.run(ctx, "");
    expect(ctx.sendPrompt).toHaveBeenCalledWith("/init");
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

describe("/skills", () => {
  it("prints the skill list", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("skills")!.run(ctx, "");
    expect(ctx.listSkills).toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith("/a  does a  (project)");
  });
});

describe("/theme", () => {
  it("lists themes when no arg is given", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("theme")!.run(ctx, "");
    expect(ctx.listThemes).toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith("● dark\n  light\n  mono");
    expect(ctx.setTheme).not.toHaveBeenCalled();
  });

  it("switches to a known theme", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("theme")!.run(ctx, "light");
    expect(ctx.setTheme).toHaveBeenCalledWith("light");
    expect(ctx.notice).toHaveBeenCalledWith("Theme: light");
  });

  it("rejects an unknown theme", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("theme")!.run(ctx, "solarized");
    expect(ctx.setTheme).not.toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith("Unknown theme: solarized. Themes: dark, light, mono");
  });

  it("completes theme names", () => {
    const cmd = buildRegistry().get("theme")!;
    expect(cmd.completeArgs!("l", {} as never)).toEqual(["light"]);
  });
});

