import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, existsSync, readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSkills, formatSkillList, scanRepoSkills, linkRepoSkills, relinkRepoSkills } from "../src/agent/skills.js";

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
    const skills = loadSkills(cwd, join(root, "nouser"), join(root, "no-repos"));
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
    const skills = loadSkills(cwd, join(root, "nouser"), join(root, "no-repos"));
    expect(skills[0].name).toBe("my-skill");
    expect(skills[0].description).toBe("");
    expect(skills[0].content).toBe("Instructions.");
  });

  it("skips files without a frontmatter block", () => {
    const cwd = join(root, "proj");
    writeSkill(join(cwd, ".cloudcode", "skills"), "plain", "Just markdown, no frontmatter.");
    expect(loadSkills(cwd, join(root, "nouser"), join(root, "no-repos"))).toEqual([]);
  });

  it("returns empty for missing directories", () => {
    expect(loadSkills(join(root, "nope"), join(root, "nouser"), join(root, "no-repos"))).toEqual([]);
  });

  it("project overrides claude overrides user on name conflict", () => {
    const cwd = join(root, "proj");
    const userDir = join(root, "user-skills");
    writeSkill(userDir, "dup", "---\nname: dup\n---\nuser version");
    writeSkill(join(cwd, ".claude", "skills"), "dup", "---\nname: dup\n---\nclaude version");
    writeSkill(join(cwd, ".cloudcode", "skills"), "dup", "---\nname: dup\n---\nproject version");
    const skills = loadSkills(cwd, userDir, join(root, "no-repos"));
    expect(skills).toHaveLength(1);
    expect(skills[0].content).toBe("project version");
    expect(skills[0].source).toBe("project");
  });

  it("claude skills load when no project skill shadows them", () => {
    const cwd = join(root, "proj");
    writeSkill(join(cwd, ".claude", "skills"), "cc-skill", "---\ndescription: from claude\n---\nBody");
    const skills = loadSkills(cwd, join(root, "nouser"), join(root, "no-repos"));
    expect(skills).toEqual([{ name: "cc-skill", description: "from claude", content: "Body", source: "claude" }]);
  });

  it("parses frontmatter-only file without trailing newline", () => {
    const cwd = join(root, "proj");
    writeSkill(join(cwd, ".cloudcode", "skills"), "bare", "---\nname: bare\ndescription: no body\n---");
    const skills = loadSkills(cwd, join(root, "nouser"), join(root, "no-repos"));
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
    const skills = loadSkills(cwd, join(root, "nouser"), join(root, "no-repos"));
    expect(skills).toEqual([{
      name: "tricky",
      description: "dashes---",
      content: "Body text",
      source: "project"
    }]);
  });
});

describe("repo skills", () => {
  it("scanRepoSkills finds nested SKILL.md dirs and tags the source", () => {
    const repo = join(root, "repos", "obra--superpowers");
    writeSkill(join(repo, "skills"), "brainstorm", "---\nname: brainstorm\ndescription: Ideate\n---\nBody");
    writeSkill(join(repo, "plugins", "extra", "skills"), "deep", "---\nname: deep\n---\nDeep body");
    writeSkill(join(repo, ".git"), "ignored", "---\nname: ignored\n---\nno");
    writeSkill(join(repo, "node_modules", "x"), "ignored2", "---\nname: ignored2\n---\nno");
    const skills = scanRepoSkills(repo, "obra--superpowers");
    const names = skills.map(s => s.name).sort();
    expect(names).toEqual(["brainstorm", "deep"]);
    expect(skills[0].source).toBe("repo:obra--superpowers");
  });

  it("loadSkills includes repo skills with lowest precedence", () => {
    const cwd = join(root, "proj");
    const reposDir = join(root, "skill-repos");
    writeSkill(join(reposDir, "obra--superpowers", "skills"), "dup", "---\nname: dup\n---\nrepo version");
    writeSkill(join(reposDir, "obra--superpowers", "skills"), "solo", "---\nname: solo\n---\nrepo only");
    writeSkill(join(cwd, ".cloudcode", "skills"), "dup", "---\nname: dup\n---\nproject version");
    const skills = loadSkills(cwd, join(root, "nouser"), reposDir);
    const dup = skills.find(s => s.name === "dup")!;
    const solo = skills.find(s => s.name === "solo")!;
    expect(dup.content).toBe("project version");
    expect(solo.source).toBe("repo:obra--superpowers");
  });

  it("loadSkills tolerates a missing repos dir", () => {
    expect(loadSkills(join(root, "proj2"), join(root, "nouser"), join(root, "no-repos"))).toEqual([]);
  });
});

describe("linkRepoSkills", () => {
  it("links each nested skill under skillsDir/<repo>/<skill>", () => {
    const repo = join(root, "skill-repos", "obra--superpowers");
    const skillsDir = join(root, "skills");
    writeSkill(join(repo, "skills"), "brainstorm", "---\nname: brainstorm\ndescription: Ideate\n---\nBody");
    writeSkill(join(repo, "plugins", "extra", "skills"), "deep", "---\nname: deep\n---\nDeep body");
    writeSkill(join(repo, ".git"), "ignored", "---\nname: ignored\n---\nno");
    const count = linkRepoSkills(repo, "obra--superpowers", skillsDir);
    expect(count).toBe(2);
    const link = join(skillsDir, "obra--superpowers", "brainstorm");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(link, "SKILL.md"), "utf8")).toContain("Ideate");
    expect(existsSync(join(skillsDir, "obra--superpowers", "deep"))).toBe(true);
    expect(existsSync(join(skillsDir, "obra--superpowers", "ignored"))).toBe(false);
  });

  it("creates no namespace dir for a repo without skills", () => {
    const repo = join(root, "skill-repos", "obra--empty");
    mkdirSync(repo, { recursive: true });
    expect(linkRepoSkills(repo, "obra--empty", join(root, "skills"))).toBe(0);
    expect(existsSync(join(root, "skills", "obra--empty"))).toBe(false);
  });

  it("relinkRepoSkills drops links for skills that no longer exist", () => {
    const repo = join(root, "skill-repos", "r");
    const skillsDir = join(root, "skills");
    writeSkill(join(repo, "skills"), "old", "---\nname: old\n---\nBody");
    linkRepoSkills(repo, "r", skillsDir);
    rmSync(join(repo, "skills", "old"), { recursive: true, force: true });
    writeSkill(join(repo, "skills"), "new", "---\nname: new\n---\nBody");
    relinkRepoSkills(repo, "r", skillsDir);
    expect(existsSync(join(skillsDir, "r", "old"))).toBe(false);
    expect(existsSync(join(skillsDir, "r", "new"))).toBe(true);
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
