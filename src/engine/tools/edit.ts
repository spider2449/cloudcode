import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ToolDef } from "./types.js";

export const editTool: ToolDef = {
  name: "Edit",
  description: "Replace old_string with new_string in a file. old_string must match exactly and be unique unless replace_all is true.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean" }
    },
    required: ["file_path", "old_string", "new_string"]
  },
  async execute(input, ctx) {
    const p = String(input.file_path ?? "");
    const abs = isAbsolute(p) ? p : resolve(ctx.cwd, p);
    const oldStr = String(input.old_string ?? "");
    const newStr = String(input.new_string ?? "");
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch (err) {
      return { content: `Cannot read ${abs}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
    const count = text.split(oldStr).length - 1;
    if (count === 0) return { content: `old_string not found in ${abs}`, isError: true };
    if (count > 1 && input.replace_all !== true) {
      return { content: `old_string occurs ${count} times in ${abs}; pass replace_all: true or make it unique`, isError: true };
    }
    const next = input.replace_all === true ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr);
    writeFileSync(abs, next);
    return { content: `Edited ${abs}` };
  }
};
