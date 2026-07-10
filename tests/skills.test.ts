import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSkills, formatSkillList } from "../src/agent/skills.js";

let root: string;

function writeSkill(base: string, dir: string, body: string): void {
  const skillDir = join(base, dir);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), body);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skills-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadSkills", () => {
  it("parses frontmatter name, description, and content", () => {
    const cwd = join(root, "proj");
    writeSkill(join(cwd, ".cloudcode", "skills"), "commit-helper",
      "---\nname: commit-helper\ndescription: Write a commit\n---\n\nDo the thing.\n");
    const skills = loadSkills(cwd, join(root, "nouser"));
    expect(skills).toEqual([{
      name: "commit-helper",
      description: "Write a commit",
      content: "Do the thing.",
      source: "project"
    }]);
  });

  it("falls back to directory name and empty description", () => {
    const cwd = join(root, "proj");
    writeSkill(join(cwd, ".cloudcode", "skills"), "my-skill", "---\n---\nInstructions.");
    const skills = loadSkills(cwd, join(root, "nouser"));
    expect(skills[0].name).toBe("my-skill");
    expect(skills[0].description).toBe("");
    expect(skills[0].content).toBe("Instructions.");
  });

  it("skips files without a frontmatter block", () => {
    const cwd = join(root, "proj");
    writeSkill(join(cwd, ".cloudcode", "skills"), "plain", "Just markdown, no frontmatter.");
    expect(loadSkills(cwd, join(root, "nouser"))).toEqual([]);
  });

  it("returns empty for missing directories", () => {
    expect(loadSkills(join(root, "nope"), join(root, "nouser"))).toEqual([]);
  });

  it("project overrides claude overrides user on name conflict", () => {
    const cwd = join(root, "proj");
    const userDir = join(root, "user-skills");
    writeSkill(userDir, "dup", "---\nname: dup\n---\nuser version");
    writeSkill(join(cwd, ".claude", "skills"), "dup", "---\nname: dup\n---\nclaude version");
    writeSkill(join(cwd, ".cloudcode", "skills"), "dup", "---\nname: dup\n---\nproject version");
    const skills = loadSkills(cwd, userDir);
    expect(skills).toHaveLength(1);
    expect(skills[0].content).toBe("project version");
    expect(skills[0].source).toBe("project");
  });

  it("claude skills load when no project skill shadows them", () => {
    const cwd = join(root, "proj");
    writeSkill(join(cwd, ".claude", "skills"), "cc-skill", "---\ndescription: from claude\n---\nBody");
    const skills = loadSkills(cwd, join(root, "nouser"));
    expect(skills).toEqual([{ name: "cc-skill", description: "from claude", content: "Body", source: "claude" }]);
  });

  it("parses frontmatter-only file without trailing newline", () => {
    const cwd = join(root, "proj");
    writeSkill(join(cwd, ".cloudcode", "skills"), "bare", "---\nname: bare\ndescription: no body\n---");
    const skills = loadSkills(cwd, join(root, "nouser"));
    expect(skills).toEqual([{
      name: "bare",
      description: "no body",
      content: "",
      source: "project"
    }]);
  });

  it("does not treat a value ending in --- as the closing delimiter", () => {
    const cwd = join(root, "proj");
    writeSkill(join(cwd, ".cloudcode", "skills"), "tricky",
      "---\ndescription: dashes---\nname: tricky\n---\nBody text");
    const skills = loadSkills(cwd, join(root, "nouser"));
    expect(skills).toEqual([{
      name: "tricky",
      description: "dashes---",
      content: "Body text",
      source: "project"
    }]);
  });
});

describe("formatSkillList", () => {
  it("formats one line per skill", () => {
    const out = formatSkillList([
      { name: "a", description: "does a", content: "", source: "project" },
      { name: "b", description: "does b", content: "", source: "user" }
    ]);
    expect(out).toBe("/a  does a  (project)\n/b  does b  (user)");
  });

  it("reports when no skills exist", () => {
    expect(formatSkillList([])).toBe(
      "No skills found. Add them to .cloudcode/skills/<name>/SKILL.md or ~/.cloudcode/skills/."
    );
  });
});
