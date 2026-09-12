import { loadSkills, type Skill } from "../../agent/skills.js";
import type { ToolDef } from "./types.js";

const MAX_OUTPUT_CHARS = 30_000;

export type SkillLoader = (cwd: string) => Skill[];

const defaultLoader: SkillLoader = cwd => loadSkills(cwd);

/** Load a skill's full SKILL.md instructions on demand (progressive
 * disclosure: the system prompt carries only names + descriptions). */
export function createSkillTool(loader: SkillLoader = defaultLoader): ToolDef {
  return {
    name: "Skill",
    description:
      "Load the full instructions of an available skill by name. " +
      "The system prompt lists skill names and descriptions; call this to read a skill's content before following it.",
    input_schema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Skill name, as listed under Available skills (without the leading /)" }
      },
      required: ["skill"]
    },
    async execute(input, ctx) {
      const raw = typeof input.skill === "string" ? input.skill.trim().replace(/^\//, "") : "";
      if (!raw) return { content: "Skill name is empty", isError: true };
      const skills = loader(ctx.cwd);
      const found = skills.find(s => s.name === raw);
      if (!found) {
        const names = skills.map(s => s.name).join(", ");
        return {
          content: names !== ""
            ? `Unknown skill: ${raw}. Available skills: ${names}`
            : `Unknown skill: ${raw}. No skills are installed.`,
          isError: true
        };
      }
      let text = `# ${found.name} (${found.source})\n${found.description}\n\n${found.content}`;
      if (text.length > MAX_OUTPUT_CHARS) {
        text = text.slice(0, MAX_OUTPUT_CHARS) +
          `\n\n[truncated ${text.length - MAX_OUTPUT_CHARS} characters]`;
      }
      return { content: text.trim() === "" ? "(empty skill)" : text };
    }
  };
}
