import type { LspManager } from "../lsp/manager.js";

export interface FileMutationToken {
  readonly id: string;
}

/** Persistence-neutral observer implemented by the agent layer. */
export interface FileMutationObserver {
  before(path: string): Promise<FileMutationToken>;
  after(token: FileMutationToken): Promise<void>;
}

export interface ToolContext {
  cwd: string;
  // Aborts when the user interrupts the turn; long-running tools should
  // honor it and stop early.
  signal?: AbortSignal;
  lsp?: LspManager;
  fileMutations?: FileMutationObserver;
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
