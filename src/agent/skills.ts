import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { configDir } from "./providers.js";

export interface Skill {
  name: string;
  description: string;
  content: string;
  source: "user" | "claude" | "project" | `repo:${string}`;
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

function isDirLike(entry: Dirent): boolean {
  // junctions and symlinks report isSymbolicLink(), not isDirectory()
  return entry.isDirectory() || entry.isSymbolicLink();
}

function readSkillAt(dir: string, fallbackName: string, source: Skill["source"]): Skill | undefined {
  let raw;
  try {
    raw = readFileSync(join(dir, "SKILL.md"), "utf8");
  } catch {
    return undefined; // missing or unreadable SKILL.md
  }
  const parsed = parseSkillFile(raw);
  if (!parsed) return undefined;
  return { name: parsed.name || fallbackName, description: parsed.description, content: parsed.content, source };
}

function scanSkillDir(dir: string, source: Skill["source"], repoNames: ReadonlySet<string> = new Set()): Skill[] {
  const skills: Skill[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return skills;
  }
  for (const entry of entries) {
    if (!isDirLike(entry)) continue;
    const sub = join(dir, entry.name);
    const skill = readSkillAt(sub, entry.name, source);
    if (skill) {
      skills.push(skill);
      continue;
    }
    // no SKILL.md: treat as a namespace dir and scan one level deeper
    const nestedSource = repoNames.has(entry.name) ? (`repo:${entry.name}` as const) : source;
    let children;
    try {
      children = readdirSync(sub, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!isDirLike(child)) continue;
      const nested = readSkillAt(join(sub, child.name), child.name, nestedSource);
      if (nested) skills.push(nested);
    }
  }
  return skills;
}

const SCAN_SKIP = new Set(["node_modules"]);
const MAX_REPO_DEPTH = 5;

interface RepoSkillDir { name: string; dir: string; parsed: ParsedSkillFile; }

function walkRepoSkills(repoDir: string): RepoSkillDir[] {
  const found: RepoSkillDir[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_REPO_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || SCAN_SKIP.has(entry.name)) continue;
      const sub = join(dir, entry.name);
      try {
        const parsed = parseSkillFile(readFileSync(join(sub, "SKILL.md"), "utf8"));
        if (parsed) {
          found.push({ name: parsed.name || entry.name, dir: sub, parsed });
          continue; // a skill dir is a leaf
        }
      } catch {
        // no SKILL.md here: recurse
      }
      walk(sub, depth + 1);
    }
  };
  walk(repoDir, 0);
  return found;
}

export function linkRepoSkills(repoDir: string, repoName: string, skillsDir: string): number {
  const found = walkRepoSkills(repoDir);
  if (found.length === 0) return 0;
  const nsDir = join(skillsDir, repoName);
  mkdirSync(nsDir, { recursive: true });
  let linked = 0;
  for (const { name, dir } of found) {
    const linkPath = join(nsDir, name);
    if (existsSync(linkPath)) continue; // duplicate skill name within the repo: first wins
    try {
      // "junction" on Windows (no admin rights needed); ignored on POSIX (plain symlink)
      symlinkSync(dir, linkPath, "junction");
      linked++;
    } catch {
      // link creation failed (exotic filesystem): skip; /skill update can retry
    }
  }
  return linked;
}

export function relinkRepoSkills(repoDir: string, repoName: string, skillsDir: string): number {
  rmSync(join(skillsDir, repoName), { recursive: true, force: true });
  return linkRepoSkills(repoDir, repoName, skillsDir);
}

export function loadSkills(
  cwd: string,
  userDir: string = join(configDir(), "skills"),
  reposDir: string = join(configDir(), "skill-repos")
): Skill[] {
  let repoEntries: Dirent[];
  try {
    repoEntries = readdirSync(reposDir, { withFileTypes: true }).filter(e => e.isDirectory());
  } catch {
    repoEntries = [];
  }
  const repoNames = new Set(repoEntries.map(e => e.name));
  // backfill: repos installed before link-based discovery have no namespace dir yet
  for (const name of repoNames) {
    if (!existsSync(join(userDir, name))) linkRepoSkills(join(reposDir, name), name, userDir);
  }
  const scans: Skill[] = [
    ...scanSkillDir(userDir, "user", repoNames),
    ...scanSkillDir(join(cwd, ".claude", "skills"), "claude"),
    ...scanSkillDir(join(cwd, ".cloudcode", "skills"), "project")
  ];
  const byName = new Map<string, Skill>();
  for (const skill of scans) {
    if (!skill.source.startsWith("repo:")) byName.set(skill.name, skill);
  }
  // repo skills have lowest precedence: only fill names no local skill claimed
  for (const skill of scans) {
    if (skill.source.startsWith("repo:") && !byName.has(skill.name)) byName.set(skill.name, skill);
  }
  return [...byName.values()];
}

export function formatSkillList(skills: Skill[]): string {
  if (skills.length === 0) {
    return "No skills found. Add them to .cloudcode/skills/<name>/SKILL.md or ~/.cloudcode/skills/.";
  }
  return skills.map(s => `/${s.name}  ${s.description}  (${s.source})`).join("\n");
}
