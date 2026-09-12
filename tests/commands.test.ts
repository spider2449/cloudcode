import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSlash } from "../src/commands/registry.js";
import { buildRegistry, listLinkedSkillNames } from "../src/commands/builtins.js";
import { mergeSkillCommands } from "../src/commands/skillCommands.js";
import { linkRepoSkills, type Skill } from "../src/agent/skills.js";
import type { CommandContext } from "../src/commands/types.js";
import { loadSettings, saveSetting } from "../src/agent/settings.js";
import { loadThemeName } from "../src/ui/theme.js";
import { mockCtx } from "./helpers/commandContext.js";

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
    expect(names).toEqual(["changes", "clear", "compact", "config", "context", "cost", "diff", "effort", "exit", "help", "init", "mcp", "memory", "model", "new", "permissions", "provider", "resume", "review", "set", "skill", "skills", "statusline", "theme", "undo"]);
  });

  it("/new starts a new session", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("new")!.run(ctx, "");
    expect(ctx.clearSession).toHaveBeenCalled();
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

describe("change commands", () => {
  it("/changes lists all or only the latest checkpoint", async () => {
    const ctx = mockCtx();
    vi.mocked(ctx.changeSummaries).mockReturnValue([{
      id: "12345678-rest", startedAt: "now", status: "complete",
      changes: [{ path: "a.ts", kind: "modified", undoAvailable: true }]
    }]);
    await buildRegistry().get("changes")!.run(ctx, "latest");
    expect(ctx.changeSummaries).toHaveBeenCalledWith(true);
    expect(ctx.notice).toHaveBeenCalledWith(expect.stringContaining("a.ts"));
  });

  it("/diff delegates an optional path", async () => {
    const ctx = mockCtx();
    vi.mocked(ctx.changeDiff).mockReturnValue({ content: "--- a.ts", truncated: false });
    await buildRegistry().get("diff")!.run(ctx, "a.ts");
    expect(ctx.changeDiff).toHaveBeenCalledWith("a.ts");
    expect(ctx.notice).toHaveBeenCalledWith("--- a.ts");
  });

  it("/undo previews by default and applies only with --yes", async () => {
    const ctx = mockCtx();
    vi.mocked(ctx.previewUndo).mockReturnValue({
      checkpointId: "12345678-rest", operations: [{ path: "a.ts", action: "restore" }], conflicts: []
    });
    vi.mocked(ctx.undoLatest).mockReturnValue({
      checkpointId: "12345678-rest", operations: [{ path: "a.ts", action: "restore" }],
      conflicts: [], applied: true, rollbackErrors: []
    });
    const command = buildRegistry().get("undo")!;
    await command.run(ctx, "");
    expect(ctx.undoLatest).not.toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith(expect.stringContaining("/undo --yes"));
    await command.run(ctx, "--yes");
    expect(ctx.undoLatest).toHaveBeenCalledOnce();
  });

  it("/review gathers a read-only Git snapshot and starts a review turn", async () => {
    const ctx = mockCtx();
    vi.mocked(ctx.gitReview).mockResolvedValue({
      isGitRepo: true, status: "1 .M N... a.ts", diff: "diff --git a/a.ts b/a.ts", truncated: false
    });
    await buildRegistry().get("review")!.run(ctx, "--staged");
    expect(ctx.gitReview).toHaveBeenCalledWith(true);
    expect(ctx.sendPrompt).toHaveBeenCalledWith(expect.stringContaining("Do not modify files"));
    expect(ctx.sendPrompt).toHaveBeenCalledWith(expect.stringContaining("<git_diff>"));
  });
});

describe("/mcp", () => {
  it("prints the formatted MCP status", async () => {
    const ctx = mockCtx();
    const registry = buildRegistry();
    await registry.get("mcp")!.run(ctx, "");
    expect(ctx.notice).toHaveBeenCalledWith("github  connected  tools: get_repo");
  });

  it("disables a server by name", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("mcp")!.run(ctx, "disable gh");
    expect(ctx.mcpSetEnabled).toHaveBeenCalledWith("gh", false);
    expect(ctx.notice).toHaveBeenCalledWith("Disabled gh (project). Use /clear to reconnect.");
  });

  it("prints usage for bad args", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("mcp")!.run(ctx, "disable");
    expect(ctx.notice).toHaveBeenCalledWith("Usage: /mcp [disable|enable <name>]");
    expect(ctx.mcpSetEnabled).not.toHaveBeenCalled();
  });

  it("completes subcommands and server names", () => {
    const command = buildRegistry().get("mcp")!;
    const completion = { mcpServerNames: () => ["gh", "docs"] } as never;
    expect(command.completeArgs!("", completion)).toEqual(["disable", "enable"]);
    expect(command.completeArgs!("disable ", completion)).toEqual(["disable gh", "disable docs"]);
    expect(command.completeArgs!("enable d", completion)).toEqual(["enable docs"]);
    expect(command.completeArgs!("disable gh extra", completion)).toEqual([]);
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
  it("opens the live-preview picker when no arg is given", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("theme")!.run(ctx, "");
    expect(ctx.openThemePicker).toHaveBeenCalled();
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
    await buildRegistry().get("theme")!.run(ctx, "nonexistent");
    expect(ctx.setTheme).not.toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith(
      "Unknown theme: nonexistent. Themes: dark, light, mono, dracula, catppuccin, gruvbox, tokyonight, nord, one-dark, solarized, rosepine, github, monokai",
    );
  });

  it("completes theme names", () => {
    const cmd = buildRegistry().get("theme")!;
    expect(cmd.completeArgs!("l", {} as never)).toEqual(["light"]);
  });
});

describe("/effort", () => {
  const run = async (args: string, ctx = mockCtx()) => {
    const cmd = buildRegistry().get("effort")!;
    await cmd.run(ctx, args);
    return ctx;
  };

  it("lists levels with current marked when no args", async () => {
    const ctx = mockCtx();
    vi.mocked(ctx.currentEffort).mockReturnValue("medium");
    await run("", ctx);
    expect(ctx.notice).toHaveBeenCalledWith("  off\n  low\n● medium\n  high");
  });

  it("sets and persists a valid level", async () => {
    const ctx = await run("high");
    expect(saveSetting).toHaveBeenCalledWith("effort", "high");
    expect(ctx.setEffort).toHaveBeenCalledWith("high");
    expect(ctx.notice).toHaveBeenCalledWith("Effort: high");
  });

  it("rejects unknown levels", async () => {
    const ctx = await run("extreme");
    expect(ctx.setEffort).not.toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith("Unknown level: extreme. Levels: off, low, medium, high");
  });

  it("completes level names", () => {
    const cmd = buildRegistry().get("effort")!;
    expect(cmd.completeArgs!("m", {} as never)).toEqual(["medium"]);
  });
});


describe("/memory", () => {
  it("opens the memory picker", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("memory")!.run(ctx, "");
    expect(ctx.openMemoryPicker).toHaveBeenCalled();
  });
});

describe("/statusline", () => {
  it("opens the picker", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("statusline")!.run(ctx, "");
    expect(ctx.openStatusLinePicker).toHaveBeenCalled();
  });

  it("rejects arguments with a usage hint", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("statusline")!.run(ctx, "cost");
    expect(ctx.openStatusLinePicker).not.toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith(expect.stringContaining("Usage: /statusline"));
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

describe("/context", () => {
  it("prints a scaled category breakdown with real usage", async () => {
    const ctx = mockCtx();
    await buildRegistry().get("context")!.run(ctx, "");
    const out = vi.mocked(ctx.notice).mock.calls[0][0];
    // header: real total 20k of 200k = 10%
    expect(out).toContain("claude-sonnet-5");
    expect(out).toContain("20.0k / 200.0k tokens (10%)");
    // estimates 1k/3k/6k scale by 20000/10000 = 2x -> 2k/6k/12k
    expect(out).toMatch(/System prompt\s+2\.0k\s+1\.0%/);
    expect(out).toMatch(/Tools\s+6\.0k\s+3\.0%/);
    expect(out).toMatch(/Messages\s+12\.0k\s+6\.0%/);
    expect(out).toMatch(/Free space\s+180\.0k\s+90\.0%/);
  });

  it("labels output as estimated when no real usage exists", async () => {
    const ctx = mockCtx();
    vi.mocked(ctx.contextInfo).mockReturnValue({
      snapshot: { systemTokens: 1000, toolsTokens: 3000, messagesTokens: 6000 },
      model: "claude-sonnet-5",
      contextWindow: 200_000
    });
    await buildRegistry().get("context")!.run(ctx, "");
    const out = vi.mocked(ctx.notice).mock.calls[0][0];
    expect(out).toContain("(estimated)");
    expect(out).toMatch(/System prompt\s+1\.0k/);
  });

  it("handles a missing snapshot", async () => {
    const ctx = mockCtx();
    vi.mocked(ctx.contextInfo).mockReturnValue({ snapshot: undefined, model: "m", contextWindow: 200_000 });
    await buildRegistry().get("context")!.run(ctx, "");
    expect(vi.mocked(ctx.notice).mock.calls[0][0]).toContain("No context yet");
  });
});

describe("listLinkedSkillNames", () => {
  // Regression test: linkRepoSkills creates junctions/symlinks under
  // skillsDir/<repo>/, and Dirent.isDirectory() is false for those — only
  // isSymbolicLink() is true. A plain isDirectory() filter (as /skill list
  // used before this fix) silently reports "(no skills)" for every repo.
  let root: string;
  let repoDir: string;
  let skillsDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "list-linked-skills-test-"));
    repoDir = join(root, "repo");
    skillsDir = join(root, "skills");
    mkdirSync(join(repoDir, "skills", "demo"), { recursive: true });
    writeFileSync(join(repoDir, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\nBody");
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("finds skills linked as junctions/symlinks, not just plain directories", () => {
    const linked = linkRepoSkills(repoDir, "obra--superpowers", skillsDir);
    expect(linked).toBe(1); // sanity: linking actually happened

    const names = listLinkedSkillNames(skillsDir, "obra--superpowers");
    expect(names).toEqual(["/demo"]);
  });

  it("returns an empty list for a repo with no linked skills dir", () => {
    expect(listLinkedSkillNames(skillsDir, "nonexistent")).toEqual([]);
  });
});

