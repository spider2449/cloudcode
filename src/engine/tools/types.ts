import type { LspManager } from "../lsp/manager.js";

export interface ToolContext {
  cwd: string;
  // Aborts when the user interrupts the turn; long-running tools should
  // honor it and stop early.
  signal?: AbortSignal;
  lsp?: LspManager;
}

export interface ToolOutput {
  content: string;
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  // JSON Schema for the tool's input, sent verbatim to the API.
  input_schema: Record<string, unknown>;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}
