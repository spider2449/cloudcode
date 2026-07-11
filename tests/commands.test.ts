import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseSlash } from "../src/commands/registry.js";
import { buildRegistry } from "../src/commands/builtins.js";
import { mergeSkillCommands } from "../src/commands/skillCommands.js";
import type { Skill } from "../src/agent/skills.js";
import type { CommandContext } from "../src/commands/types.js";
import { loadSettings, saveSetting } from "../src/agent/settings.js";
import { loadThemeName } from "../src/ui/theme.js";

vi.mock("../src/agent/settings.js", () => ({
  loadSettings: vi.fn().mockReturnValue({}),
  saveSetting: vi.fn()
}));
vi.mock("../src/ui/theme.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/ui/theme.js")>()),
  loadThemeName: vi.fn().mockReturnValue("dark")
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadSettings).mockReturnValue({});
  vi.mocked(loadThemeName).mockReturnValue("dark");
});

function mockCtx(): CommandContext {
  return {
    notice: vi.fn(),
    clearSession: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    availableModels: vi.fn().mockReturnValue([]),
    currentModel: vi.fn().mockReturnValue(undefined),
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
    compact: vi.fn().mockResolvedValue(undefined),
    setCompactProgress: vi.fn(),
    listSkills: vi.fn().mockReturnValue("/a  does a  (project)"),
    setTheme: vi.fn(),
    listThemes: vi.fn().mockReturnValue("● dark\n  light\n  mono"),
    switchProject: vi.fn(),
    openProjectPicker: vi.fn(),
    currentCwd: vi.fn().mockReturnValue(process.cwd())
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
    expect(names).toEqual(["clear", "compact", "config", "cost", "exit", "help", "init", "mcp", "model", "permissions", "provider", "resume", "set", "skill", "skills", "theme"]);
  });

  it("/model with arg sets model; without arg lists fetched models", async () => {
    const reg = buildRegistry();
    const ctx = mockCtx();
    await reg.get("model")!.run(ctx, "claude-sonnet-5");
    expect(ctx.setModel).toHaveBeenCalledWith("claude-sonnet-5");
    vi.mocked(ctx.availableModels).mockReturnValue(["m-one", "m-two"]);
    vi.mocked(ctx.currentModel).mockReturnValue("m-two");
    await reg.get("model")!.run(ctx, "");
    expect(ctx.notice).toHaveBeenCalledWith("  m-one\n● m-two");
  });

  it("/model without arg falls back to usage when no list is available", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("model")!.run(ctx, "");
    expect(ctx.notice).toHaveBeenCalledWith(
      "Usage: /model <model-name> (model list unavailable for this provider)"
    );
  });

  it("/model completes from the fetched list", () => {
    const cmd = buildRegistry().get("model")!;
    const cctx = { availableModels: () => ["llama-3", "qwen-2.5"] } as never;
    expect(cmd.completeArgs!("ll", cctx)).toEqual(["llama-3"]);
  });

  it("/permissions rejects unknown mode", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("permissions")!.run(ctx, "yolo");
    expect(ctx.setPermissionMode).not.toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith("Valid modes: default, acceptEdits, bypassPermissions");
  });

  it("/provider switches provider and persists it", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("provider")!.run(ctx, "local");
    expect(saveSetting).toHaveBeenCalledWith("provider", "local");
    expect(ctx.switchProvider).toHaveBeenCalledWith("local");
  });

  it("/provider rejects an unknown provider without persisting", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("provider")!.run(ctx, "nope");
    expect(saveSetting).not.toHaveBeenCalled();
    expect(ctx.switchProvider).not.toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith("Unknown provider: nope. Providers: anthropic, local");
  });

  it("/model persists the model", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("model")!.run(ctx, "claude-sonnet-5");
    expect(saveSetting).toHaveBeenCalledWith("model", "claude-sonnet-5");
    expect(ctx.setModel).toHaveBeenCalledWith("claude-sonnet-5");
  });
});

describe("/compact and /init", () => {
  it("/compact calls the engine's compact and notifies", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("compact")!.run(ctx, "");
    expect(ctx.compact).toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith("Conversation compacted.");
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

describe("/config", () => {
  it("lists all keys with persisted values when no arg is given", async () => {
    vi.mocked(loadSettings).mockReturnValue({ provider: "local" });
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "");
    expect(ctx.notice).toHaveBeenCalledWith(
      "provider = local\nmodel = (unset)\npermissionMode = (unset)\ntheme = dark"
    );
  });

  it("shows a single key's value", async () => {
    vi.mocked(loadSettings).mockReturnValue({});
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "model");
    expect(ctx.notice).toHaveBeenCalledWith("model = (unset)");
  });

  it("rejects an unknown key", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "editor vim");
    expect(saveSetting).not.toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith("Unknown key: editor. Keys: provider, model, permissionMode, theme");
  });

  it("sets provider: persists then switches live", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "provider local");
    expect(saveSetting).toHaveBeenCalledWith("provider", "local");
    expect(ctx.switchProvider).toHaveBeenCalledWith("local");
    expect(ctx.notice).toHaveBeenCalledWith("provider = local (saved)");
  });

  it("rejects an unknown provider without persisting", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "provider nope");
    expect(saveSetting).not.toHaveBeenCalled();
    expect(ctx.switchProvider).not.toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith("Unknown provider: nope. Providers: anthropic, local");
  });

  it("sets model: persists then applies live", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "model claude-sonnet-5");
    expect(saveSetting).toHaveBeenCalledWith("model", "claude-sonnet-5");
    expect(ctx.setModel).toHaveBeenCalledWith("claude-sonnet-5");
    expect(ctx.notice).toHaveBeenCalledWith("model = claude-sonnet-5 (saved)");
  });

  it("sets permissionMode with validation", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "permissionMode acceptEdits");
    expect(saveSetting).toHaveBeenCalledWith("permissionMode", "acceptEdits");
    expect(ctx.setPermissionMode).toHaveBeenCalledWith("acceptEdits");
    await buildRegistry().get("config")!.run(ctx, "permissionMode yolo");
    expect(ctx.notice).toHaveBeenCalledWith("Valid modes: default, acceptEdits, bypassPermissions");
  });

  it("applies bypassPermissions live but never persists it", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "permissionMode bypassPermissions");
    expect(ctx.setPermissionMode).toHaveBeenCalledWith("bypassPermissions");
    expect(saveSetting).not.toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith("permissionMode = bypassPermissions (session only, not saved)");
  });

  it("sets theme by delegating to setTheme, never touching settings.json", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("config")!.run(ctx, "theme mono");
    expect(ctx.setTheme).toHaveBeenCalledWith("mono");
    expect(saveSetting).not.toHaveBeenCalledWith("theme", expect.anything());
    expect(ctx.notice).toHaveBeenCalledWith("theme = mono (saved)");
    await buildRegistry().get("config")!.run(ctx, "theme solarized");
    expect(ctx.setTheme).not.toHaveBeenCalledWith("solarized");
    expect(ctx.notice).toHaveBeenCalledWith("Unknown theme: solarized. Themes: dark, light, mono");
  });

  it("completes keys and values", () => {
    const cmd = buildRegistry().get("config")!;
    const cctx = { providerNames: () => ["anthropic", "local"], availableModels: () => ["claude-sonnet-5"] } as never;
    expect(cmd.completeArgs!("p", cctx)).toEqual(["provider", "permissionMode"]);
    expect(cmd.completeArgs!("theme m", cctx)).toEqual(["theme mono"]);
    expect(cmd.completeArgs!("provider l", cctx)).toEqual(["provider local"]);
    expect(cmd.completeArgs!("model cla", cctx)).toEqual(["model claude-sonnet-5"]);
  });
});

describe("/set", () => {
  it("no args prints usage", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("set")!.run(ctx, "");
    expect(ctx.notice).toHaveBeenCalledWith(expect.stringContaining("/set project"));
  });

  it("unknown subcommand prints usage", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("set")!.run(ctx, "banana x");
    expect(ctx.notice).toHaveBeenCalledWith(expect.stringContaining("Unknown /set key: banana"));
  });

  it("project with no path opens the picker", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("set")!.run(ctx, "project");
    expect(ctx.openProjectPicker).toHaveBeenCalled();
  });

  it("project with a valid path switches", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("set")!.run(ctx, `project ${process.cwd()}`);
    expect(ctx.switchProject).toHaveBeenCalledWith(process.cwd());
  });

  it("project with an invalid path notices and does not switch", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("set")!.run(ctx, "project Z:\\definitely\\missing\\dir");
    expect(ctx.switchProject).not.toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith(expect.stringContaining("Not a directory"));
  });
});

