import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSkills } from "../agent/skills.js";
import { loadSettings } from "../agent/settings.js";
import { configDir } from "../agent/providers.js";
import { memoryDir, memoryEntrypoint, ensureMemoryDir } from "./memoryPaths.js";
import { buildMemoryPrompt } from "./memoryPrompt.js";

const BASE = `You are cloudcode, an interactive terminal coding agent.
Use the provided tools to read, search, edit, and run code. Prefer tools over
guessing. Keep answers concise; report file paths precisely. Working directory: `;

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

  const skills = loadSkills(cwd);
  if (skills.length > 0) {
    const list = skills.map(s => `- ${s.name}: ${s.description}`).join("\n");
    prompt += `\n\n# Available skills\nWhen a task matches a skill, follow that skill's instructions.\n${list}`;
  }

  if (autoMemory) {
    const dir = memoryDir(cwd, base);
    // Only advertise the memory system when the directory actually exists,
    // so the "already exists" promise in the prompt is truthful.
    if (ensureMemoryDir(dir)) {
      prompt += `\n\n${buildMemoryPrompt(dir, readIfPresent(memoryEntrypoint(cwd, base)))}`;
    }
  }
  return prompt;
}
