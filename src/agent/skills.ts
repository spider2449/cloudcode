import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./providers.js";

export interface Skill {
  name: string;
  description: string;
  content: string;
  source: "user" | "claude" | "project";
}

interface ParsedSkillFile {
  name?: string;
  description: string;
  content: string;
}

function parseSkillFile(raw: string): ParsedSkillFile | undefined {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end === -1) return undefined;
  const frontmatter: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) frontmatter[kv[1]] = kv[2].trim();
  }
  return {
    name: frontmatter.name,
    description: frontmatter.description ?? "",
    content: lines.slice(end + 1).join("\n").trim()
  };
}

function scanSkillDir(dir: string, source: Skill["source"]): Skill[] {
  const skills: Skill[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return skills;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = readFileSync(join(dir, entry.name, "SKILL.md"), "utf8");
      const parsed = parseSkillFile(raw);
      if (parsed) {
        skills.push({
          name: parsed.name || entry.name,
          description: parsed.description,
          content: parsed.content,
          source
        });
      }
    } catch {
      // missing or unreadable SKILL.md: skip this directory
    }
  }
  return skills;
}

export function loadSkills(
  cwd: string,
  userDir: string = join(configDir(), "skills")
): Skill[] {
  const byName = new Map<string, Skill>();
  const scans: Skill[] = [
    ...scanSkillDir(userDir, "user"),
    ...scanSkillDir(join(cwd, ".claude", "skills"), "claude"),
    ...scanSkillDir(join(cwd, ".cloudcode", "skills"), "project")
  ];
  for (const skill of scans) byName.set(skill.name, skill);
  return [...byName.values()];
}

export function formatSkillList(skills: Skill[]): string {
  if (skills.length === 0) {
    return "No skills found. Add them to .cloudcode/skills/<name>/SKILL.md or ~/.cloudcode/skills/.";
  }
  return skills.map(s => `/${s.name}  ${s.description}  (${s.source})`).join("\n");
}
