import type { Command } from "./types.js";
import type { Skill } from "../agent/skills.js";

export function buildSkillPrompt(skill: Skill, args: string): string {
  return args ? `${skill.content}\n\nARGUMENTS: ${args}` : skill.content;
}

export function mergeSkillCommands(
  registry: Map<string, Command>,
  skills: Skill[]
): Map<string, Command> {
  const merged = new Map(registry);
  for (const skill of skills) {
    if (merged.has(skill.name)) continue;
    merged.set(skill.name, {
      name: skill.name,
      description: skill.description,
      source: skill.source,
      async run(ctx, args) {
        ctx.sendPrompt(buildSkillPrompt(skill, args));
      }
    });
  }
  return merged;
}
