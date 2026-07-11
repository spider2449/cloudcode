import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ToolDef } from "./types.js";

const MAX_LINES = 2000;

export const readTool: ToolDef = {
  name: "Read",
  description: "Read a file from the filesystem. Returns cat -n style numbered lines.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file" },
      offset: { type: "number", description: "1-based line to start from" },
      limit: { type: "number", description: "Max lines to read" }
    },
    required: ["file_path"]
  },
  async execute(input, ctx) {
    const p = String(input.file_path ?? "");
    const abs = isAbsolute(p) ? p : resolve(ctx.cwd, p);
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch (err) {
      return { content: `Cannot read ${abs}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
    const offset = typeof input.offset === "number" && input.offset > 0 ? input.offset : 1;
    const limit = typeof input.limit === "number" && input.limit > 0 ? input.limit : MAX_LINES;
    const lines = text.split("\n").slice(offset - 1, offset - 1 + limit);
    const numbered = lines.map((l, i) => `${offset + i}\t${l}`).join("\n");
    return { content: numbered || "(empty file)" };
  }
};
