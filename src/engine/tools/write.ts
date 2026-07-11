import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ToolDef } from "./types.js";

export const writeTool: ToolDef = {
  name: "Write",
  description: "Write content to a file, creating parent directories and overwriting if it exists.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file" },
      content: { type: "string", description: "Full file content" }
    },
    required: ["file_path", "content"]
  },
  async execute(input, ctx) {
    const p = String(input.file_path ?? "");
    const abs = isAbsolute(p) ? p : resolve(ctx.cwd, p);
    try {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, String(input.content ?? ""));
      return { content: `Wrote ${abs}` };
    } catch (err) {
      return { content: `Cannot write ${abs}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }
};
