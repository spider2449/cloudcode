import { readFileSync } from "node:fs";
import { relative, isAbsolute, resolve } from "node:path";
import type { ToolDef } from "./types.js";
import { walk, globToRegExp } from "./glob.js";

const MAX_MATCHES = 250;
const MAX_FILE_SIZE = 2 * 1024 * 1024;

export const grepTool: ToolDef = {
  name: "Grep",
  description: "Search file contents with a JavaScript regular expression. Returns file:line:text matches.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression" },
      path: { type: "string", description: "Directory to search (default cwd)" },
      glob: { type: "string", description: "Filter files by glob pattern, e.g. *.ts" }
    },
    required: ["pattern"]
  },
  async execute(input, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(String(input.pattern ?? ""));
    } catch (err) {
      return { content: `Invalid regex: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
    const base = typeof input.path === "string" && input.path !== ""
      ? (isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path))
      : ctx.cwd;
    const fileFilter = typeof input.glob === "string" && input.glob !== "" ? globToRegExp(input.glob) : undefined;
    const matches: string[] = [];
    for (const f of walk(base)) {
      const rel = relative(base, f).replace(/\\/g, "/");
      if (fileFilter && !fileFilter.test(rel)) continue;
      let text: string;
      try {
        text = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      if (text.length > MAX_FILE_SIZE || text.includes("\0")) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          matches.push(`${rel}:${i + 1}:${lines[i].trim()}`);
          if (matches.length >= MAX_MATCHES) {
            matches.push("… (results truncated)");
            return { content: matches.join("\n") };
          }
        }
      }
    }
    return { content: matches.length > 0 ? matches.join("\n") : "No matches found." };
  }
};
