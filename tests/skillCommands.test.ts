import { describe, it, expect, vi } from "vitest";
import { buildSkillPrompt, mergeSkillCommands } from "../src/commands/skillCommands.js";
import { buildRegistry } from "../src/commands/builtins.js";
import type { Skill } from "../src/agent/skills.js";
import type { CommandContext } from "../src/commands/types.js";

const skill: Skill = { name: "commit-helper", description: "Write a commit", content: "Do the thing.", source: "project" };

describe("buildSkillPrompt", () => {
  it("returns content alone when args are empty", () => {
    expect(buildSkillPrompt(skill, "")).toBe("Do the thing.");
  });

  it("appends an ARGUMENTS line when args are non-empty", () => {
    expect(buildSkillPrompt(skill, "fix typo")).toBe("Do the thing.\n\nARGUMENTS: fix typo");
  });
});

describe("mergeSkillCommands", () => {
  it("registers a skill as a command that sends the built prompt", async () => {
    const merged = mergeSkillCommands(buildRegistry(), [skill]);
    const cmd = merged.get("commit-helper")!;
    expect(cmd.description).toBe("Write a commit");
    const ctx = { sendPrompt: vi.fn() } as unknown as CommandContext;
    await cmd.run(ctx, "fix typo");
    expect(ctx.sendPrompt).toHaveBeenCalledWith("Do the thing.\n\nARGUMENTS: fix typo");
  });

  it("does not overwrite a builtin on name conflict", () => {
    const registry = buildRegistry();
    const helpBuiltin = registry.get("help")!;
    const merged = mergeSkillCommands(registry, [{ ...skill, name: "help" }]);
    expect(merged.get("help")).toBe(helpBuiltin);
  });

  it("does not mutate the input registry", () => {
    const registry = buildRegistry();
    const before = registry.size;
    mergeSkillCommands(registry, [skill]);
    expect(registry.size).toBe(before);
  });

  it("sets source on the merged skill command", () => {
    const merged = mergeSkillCommands(buildRegistry(), [skill]);
    expect(merged.get("commit-helper")!.source).toBe("project");
  });

  it("leaves builtin commands without a source", () => {
    const merged = mergeSkillCommands(buildRegistry(), [skill]);
    expect(merged.get("help")!.source).toBeUndefined();
  });
});
