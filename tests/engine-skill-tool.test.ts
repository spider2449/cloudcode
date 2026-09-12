import { describe, it, expect, vi } from "vitest";
import { createSkillTool } from "../src/engine/tools/skill.js";
import { builtinTools } from "../src/engine/registry.js";
import type { Skill } from "../src/agent/skills.js";
import type { ToolContext } from "../src/engine/tools/types.js";

const baseCtx: ToolContext = { cwd: "/project" };

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: "commit",
    description: "Write a commit",
    content: "Follow these steps to commit.",
    source: "project",
    ...overrides
  };
}

describe("Skill tool", () => {
  it("returns the full content of a named skill", async () => {
    const loader = vi.fn().mockReturnValue([skill()]);
    const tool = createSkillTool(loader);
    const out = await tool.execute({ skill: "commit" }, baseCtx);
    expect(loader).toHaveBeenCalledWith("/project");
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain("Follow these steps to commit.");
    expect(out.content).toContain("commit");
  });

  it("accepts a leading slash in the name", async () => {
    const tool = createSkillTool(() => [skill()]);
    const out = await tool.execute({ skill: "/commit" }, baseCtx);
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain("Follow these steps");
  });

  it("reports unknown names with the available list", async () => {
    const tool = createSkillTool(() => [skill()]);
    const out = await tool.execute({ skill: "nope" }, baseCtx);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("Unknown skill: nope");
    expect(out.content).toContain("commit");
  });

  it("says so when no skills are installed", async () => {
    const tool = createSkillTool(() => []);
    const out = await tool.execute({ skill: "commit" }, baseCtx);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("No skills are installed");
  });

  it("rejects empty names", async () => {
    const loader = vi.fn().mockReturnValue([]);
    const tool = createSkillTool(loader);
    const out = await tool.execute({ skill: "  " }, baseCtx);
    expect(out.isError).toBe(true);
    expect(loader).not.toHaveBeenCalled();
  });

  it("truncates oversized skill content with a marker", async () => {
    const tool = createSkillTool(() => [skill({ content: "x".repeat(40_000) })]);
    const out = await tool.execute({ skill: "commit" }, baseCtx);
    expect(out.content.length).toBeLessThan(40_000);
    expect(out.content).toContain("[truncated");
  });
});

describe("Skill tool registration", () => {
  it("is always in builtinTools and honors an injected loader", async () => {
    const names = builtinTools().map(t => t.name);
    expect(names).toContain("Skill");
    const custom = builtinTools({
      skillLoader: () => [skill({ name: "custom", content: "custom body" })]
    }).find(t => t.name === "Skill");
    const out = await custom!.execute({ skill: "custom" }, baseCtx);
    expect(out.content).toContain("custom body");
  });
});
