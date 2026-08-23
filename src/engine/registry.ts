import type { ToolDef } from "./tools/types.js";
import { readTool } from "./tools/read.js";
import { writeTool } from "./tools/write.js";
import { editTool } from "./tools/edit.js";
import { bashTool } from "./tools/bash.js";
import { globTool } from "./tools/glob.js";
import { grepTool } from "./tools/grep.js";
import { webfetchTool } from "./tools/webfetch.js";
import { createTaskTool, type TaskToolDeps } from "./tools/task.js";
import { createTodoTool, type TodoStore } from "./tools/todo.js";
import { createBashOutputTool, createKillShellTool } from "./tools/bashOut.js";
import type { BackgroundShellManager } from "./tools/backgroundShells.js";
import { definitionTool, referencesTool, hoverTool, symbolsTool, diagnosticsTool } from "./tools/lsp.js";

export function builtinTools(options: {
  allowArbitraryChildNetwork?: boolean;
  task?: TaskToolDeps;
  todoStore?: TodoStore;
  bgShells?: BackgroundShellManager;
} = {}): ToolDef[] {
  const tools = [
    readTool, writeTool, editTool, bashTool, globTool, grepTool, webfetchTool,
    definitionTool, referencesTool, hoverTool, symbolsTool, diagnosticsTool,
    ...(options.task ? [createTaskTool(options.task)] : []),
    createTodoTool(options.todoStore),
    ...(options.bgShells ? [createBashOutputTool(options.bgShells), createKillShellTool(options.bgShells)] : [])
  ];
  return options.allowArbitraryChildNetwork === false
    ? tools.filter(tool => tool.capabilities?.arbitraryChildNetwork !== true)
    : tools;
}
