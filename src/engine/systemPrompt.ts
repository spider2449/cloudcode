import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSkills } from "../agent/skills.js";

const BASE = `You are cloudcode, an interactive terminal coding agent.
Use the provided tools to read, search, edit, and run code. Prefer tools over
guessing. Keep answers concise; report file paths precisely. Working directory: `;

export function buildSystemPrompt(cwd: string): string {
  let prompt = BASE + cwd;
  try {
    const claudeMd = readFileSync(join(cwd, "CLAUDE.md"), "utf8").trim();
    if (claudeMd !== "") prompt += `\n\n# Project instructions (CLAUDE.md)\n${claudeMd}`;
  } catch {
    // no CLAUDE.md: skip section
  }
  const skills = loadSkills(cwd);
  if (skills.length > 0) {
    const list = skills.map(s => `- ${s.name}: ${s.description}`).join("\n");
    prompt += `\n\n# Available skills\nWhen a task matches a skill, follow that skill's instructions.\n${list}`;
  }
  return prompt;
}
