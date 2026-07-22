import type { ToolDef } from "./tools/types.js";
import { readTool } from "./tools/read.js";
import { writeTool } from "./tools/write.js";
import { editTool } from "./tools/edit.js";
import { bashTool } from "./tools/bash.js";
import { globTool } from "./tools/glob.js";
import { grepTool } from "./tools/grep.js";
import { definitionTool, referencesTool, hoverTool, symbolsTool, diagnosticsTool } from "./tools/lsp.js";

export function builtinTools(): ToolDef[] {
  return [
    readTool, writeTool, editTool, bashTool, globTool, grepTool,
    definitionTool, referencesTool, hoverTool, symbolsTool, diagnosticsTool
  ];
}
