import { readdirSync } from "node:fs";
import { join, relative, isAbsolute, resolve } from "node:path";
import type { ToolDef } from "./types.js";

const SKIP = new Set(["node_modules", "dist", ".git"]);
const MAX_RESULTS = 500;

export function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) stack.push(join(dir, e.name));
      } else {
        out.push(join(dir, e.name));
      }
    }
  }
  return out;
}

// Translate a glob pattern to a RegExp: ** = any path, * = any name segment chars.
export function globToRegExp(pattern: string): RegExp {
  const norm = pattern.replace(/\\/g, "/");
  let re = "";
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i];
    if (c === "*") {
      if (norm[i + 1] === "*") {
        re += ".*";
        i++;
        if (norm[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (".+^${}()|[]".includes(c)) {
      re += "\\" + c;
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c;
    }
  }
  return new RegExp(`(^|/)${re}$`);
}

export const globTool: ToolDef = {
  name: "Glob",
  description: "Find files matching a glob pattern like **/*.ts. Skips node_modules, dist, .git.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern" },
      path: { type: "string", description: "Directory to search (default cwd)" }
    },
    required: ["pattern"]
  },
  async execute(input, ctx) {
    const base = typeof input.path === "string" && input.path !== ""
      ? (isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path))
      : ctx.cwd;
    const re = globToRegExp(String(input.pattern ?? ""));
    const hits = walk(base)
      .filter(f => re.test(relative(base, f).replace(/\\/g, "/")))
      .slice(0, MAX_RESULTS);
    return { content: hits.length > 0 ? hits.join("\n") : "No files matched." };
  }
};
