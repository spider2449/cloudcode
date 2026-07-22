import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./providers.js";
import { linkRepoSkills, relinkRepoSkills } from "./skills.js";

export type NormalizedRepo =
  | { ok: true; url: string; dirName: string }
  | { ok: false; error: string };

const GITHUB_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;
const SHORTHAND = /^([\w.-]+)\/([\w.-]+)$/;

export function normalizeRepoUrl(input: string): NormalizedRepo {
  const trimmed = input.trim();
  const match = GITHUB_URL.exec(trimmed) ?? SHORTHAND.exec(trimmed);
  if (!match) {
    return { ok: false, error: `Unsupported repo: "${input}". Use https://github.com/owner/repo or owner/repo.` };
  }
  const [, owner, repo] = match;
  return {
    ok: true,
    url: `https://github.com/${owner}/${repo}.git`,
    dirName: `${owner}--${repo}`
  };
}

export interface GitResult { ok: boolean; output: string; }
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

export const defaultGitRunner: GitRunner = (args, cwd) =>
  new Promise(resolve => {
    execFile("git", args, { cwd }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({ ok: false, output: "git executable not found on PATH. Install git to use /skill." });
        return;
      }
      resolve({ ok: !err, output: (stderr || stdout || "").trim() });
    });
  });

export function skillReposDir(): string {
  return join(configDir(), "skill-repos");
}

export function userSkillsDir(): string {
  return join(configDir(), "skills");
}

export function listRepoNames(reposDir: string): string[] {
  try {
    return readdirSync(reposDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return [];
  }
}

function unknownRepoMessage(name: string, reposDir: string): string {
  const names = listRepoNames(reposDir);
  return names.length
    ? `Unknown skill repo: ${name}. Installed: ${names.join(", ")}`
    : `Unknown skill repo: ${name}. No skill repos installed.`;
}

export async function installRepo(input: string, reposDir: string, skillsDir: string, git: GitRunner): Promise<string> {
  const normalized = normalizeRepoUrl(input);
  if (!normalized.ok) return normalized.error;
  const target = join(reposDir, normalized.dirName);
  if (listRepoNames(reposDir).includes(normalized.dirName)) {
    return `${normalized.dirName} is already installed. Use /skill update ${normalized.dirName}.`;
  }
  mkdirSync(reposDir, { recursive: true });
  const result = await git(["clone", "--depth", "1", normalized.url, target], reposDir);
  if (!result.ok) return `Clone failed: ${result.output}`;
  const count = linkRepoSkills(target, normalized.dirName, skillsDir);
  return count > 0
    ? `Installed ${normalized.dirName} (${count} skill${count === 1 ? "" : "s"}).`
    : `Installed ${normalized.dirName}, but it contains no skills (no SKILL.md files found).`;
}

export async function updateRepos(
  name: string | undefined,
  reposDir: string,
  skillsDir: string,
  git: GitRunner
): Promise<string> {
  const installed = listRepoNames(reposDir);
  if (installed.length === 0) return "No skill repos installed. Use /skill install <github-url>.";
  if (name && !installed.includes(name)) return unknownRepoMessage(name, reposDir);
  const targets = name ? [name] : installed;
  const lines: string[] = [];
  for (const repo of targets) {
    const result = await git(["pull", "--ff-only"], join(reposDir, repo));
    if (result.ok) relinkRepoSkills(join(reposDir, repo), repo, skillsDir);
    lines.push(`${repo}: ${result.ok ? result.output || "updated" : `update failed: ${result.output}`}`);
  }
  return lines.join("\n");
}

export function removeRepo(name: string, reposDir: string, skillsDir: string): string {
  if (!listRepoNames(reposDir).includes(name)) return unknownRepoMessage(name, reposDir);
  rmSync(join(reposDir, name), { recursive: true, force: true });
  rmSync(join(skillsDir, name), { recursive: true, force: true });
  return `Removed ${name}.`;
}
