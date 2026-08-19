import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, type Dirent } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "./providers.js";
import { resolvePackContributions } from "./packs.js";

export interface Skill {
  name: string;
  description: string;
  content: string;
  source: "user" | "claude" | "project" | `repo:${string}` | `pack:${string}`;
}

interface ParsedSkillFile {
  name?: string;
  description: string;
  content: string;
}

// Slash commands are parsed with /^\/([\w-]+)/ (commands/registry.ts), so a
// skill whose name contains anything else registers a command nobody can
// invoke. The name is also used as a link path segment by linkRepoSkills, and
// frontmatter from a cloned third-party repo is untrusted input there — an
// unsanitized "../../evil" would place a junction outside the skills dir.
export function sanitizeSkillName(raw: string): string | undefined {
  const name = raw.trim().replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "");
  return name === "" ? undefined : name;
}

// Descriptions are concatenated into the system prompt (engine/systemPrompt.ts)
// and `/skill install` lets any GitHub repo supply one, so collapse whitespace
// and control characters and cap the length rather than passing it through.
const MAX_DESCRIPTION_LENGTH = 200;

function sanitizeDescription(raw: string): string {
  const flat = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > MAX_DESCRIPTION_LENGTH
    ? flat.slice(0, MAX_DESCRIPTION_LENGTH).trimEnd() + "…"
    : flat;
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
    description: sanitizeDescription(frontmatter.description ?? ""),
    content: lines.slice(end + 1).join("\n").trim()
  };
}

export function isDirLike(entry: Dirent): boolean {
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
  // Frontmatter name wins, but only if it survives sanitizing; otherwise fall
  // back to the directory name. A skill that can produce neither is skipped.
  const name = sanitizeSkillName(parsed.name ?? "") ?? sanitizeSkillName(fallbackName);
  if (name === undefined) return undefined;
  return { name, description: parsed.description, content: parsed.content, source };
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
          // Sanitized before it becomes a link path segment: the name comes
          // from a cloned third-party repo (see sanitizeSkillName).
          const name = sanitizeSkillName(parsed.name ?? "") ?? sanitizeSkillName(entry.name);
          if (name !== undefined) found.push({ name, dir: sub, parsed });
          continue; // a skill dir is a leaf either way
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
  // The namespace dir is created even for a repo with no skills: loadSkills
  // treats its absence as "not linked yet" and re-walks the whole repo tree on
  // every call, so an empty dir is what stops that walk from repeating.
  const nsDir = join(skillsDir, repoName);
  mkdirSync(nsDir, { recursive: true });
  if (found.length === 0) return 0;
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
  const localScans: Skill[] = [
    ...scanSkillDir(userDir, "user", repoNames),
    ...scanSkillDir(join(cwd, ".claude", "skills"), "claude"),
    ...scanSkillDir(join(cwd, ".cloudcode", "skills"), "project")
  ];
  const packs = resolvePackContributions(cwd, dirname(userDir));
  const packScans = packs.skillRoots.flatMap(root => scanSkillDir(root.path, `pack:${root.pack}`));
  const byName = new Map<string, Skill>();
  for (const skill of localScans) {
    if (!skill.source.startsWith("repo:")) byName.set(skill.name, skill);
  }
  for (const skill of packScans) if (!byName.has(skill.name)) byName.set(skill.name, skill);
  // repo skills have lowest precedence: only fill names no local skill claimed
  for (const skill of localScans) {
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
