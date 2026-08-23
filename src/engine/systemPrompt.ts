import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSkills } from "../agent/skills.js";
import { loadSettings } from "../agent/settings.js";
import { configDir } from "../agent/providers.js";
import { memoryDir, memoryEntrypoint } from "./memoryPaths.js";
import { buildMemoryPrompt } from "./memoryPrompt.js";
import { resolvePackContributions } from "../agent/packs.js";

const BASE = `You are cloudcode, an interactive terminal coding agent.
Use the provided tools to read, search, edit, and run code. Prefer tools over
guessing. Keep answers concise; report file paths precisely. User messages may
contain @path tokens referencing project-relative files. Read them with the
Read tool before acting on claims about their contents. Working directory: `;

function readIfPresent(path: string): string {
  try { return readFileSync(path, "utf8").trim(); } catch { return ""; }
}

export interface SystemPromptOptions {
  configBase?: string;
  autoMemory?: boolean;
}

export function buildSystemPrompt(cwd: string, opts: SystemPromptOptions = {}): string {
  const base = opts.configBase ?? configDir();
  const autoMemory = opts.autoMemory ?? loadSettings().autoMemoryEnabled ?? true;
  let prompt = BASE + cwd;

  const userMd = readIfPresent(join(base, "CLOUDCODE.md"));
  if (userMd !== "") prompt += `\n\n# User instructions (CLOUDCODE.md)\n${userMd}`;

  const projectMd = readIfPresent(join(cwd, "CLAUDE.md"));
  if (projectMd !== "") prompt += `\n\n# Project instructions (CLAUDE.md)\n${projectMd}`;

  for (const instruction of resolvePackContributions(cwd, base).instructions) {
    if (instruction.text) prompt += `\n\n# Workflow pack instructions (${instruction.pack})\n${instruction.text}`;
  }

  // Skills follow `configBase` like every other config read here; without it a
  // caller-supplied base (and every test) would still pick up whatever lives
  // in the real ~/.cloudcode.
  const skills = loadSkills(cwd, join(base, "skills"), join(base, "skill-repos"));
  if (skills.length > 0) {
    // Repo skills come from a third-party clone (`/skill install`), so their
    // descriptions are untrusted text sitting in the system prompt. Labelling
    // the source keeps that visible instead of presenting every skill as if
    // the user had written it.
    const list = skills.map(s => {
      const origin = s.source.startsWith("repo:") ? ` (third-party skill from ${s.source.slice(5)})` : "";
      return `- ${s.name}: ${s.description}${origin}`;
    }).join("\n");
    prompt += `\n\n# Available skills\nWhen a task matches a skill, follow that skill's instructions.\n${list}`;
  }

  if (autoMemory) {
    // Don't create the memory directory here — that would leave an empty
    // folder behind for every project ever opened. The Write tool creates
    // parent directories lazily, so the dir only appears once a memory is
    // actually saved.
    const dir = memoryDir(cwd, base);
    prompt += `\n\n${buildMemoryPrompt(dir, readIfPresent(memoryEntrypoint(cwd, base)))}`;
  }
  return prompt;
}

const SUBAGENT_BASE = `You are a code-exploration subagent inside cloudcode.
Investigate the request using only your read and search tools (Read, Glob,
Grep, and LSP lookups). Do not attempt to change anything. Report findings
concisely with precise file paths and line numbers. Working directory: `;

export function buildSubagentSystemPrompt(cwd: string): string {
  return SUBAGENT_BASE + cwd;
}
