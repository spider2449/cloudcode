import type { PermissionMode } from "../agent/session.js";
import type { CompletionContext } from "./completion.js";

export interface CommandContext {
  notice(text: string): void;
  clearSession(): Promise<void>;
  setModel(model: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  switchProvider(name: string): Promise<void>;
  openResumePicker(): void;
  costSummary(): string;
  providerNames(): string[];
  exit(): void;
  listPermissionRules(): string;
  clearPermissionRules(): void;
}

export interface Command {
  name: string;
  description: string;
  run(ctx: CommandContext, args: string): Promise<void>;
  completeArgs?(prefix: string, ctx: CompletionContext): string[];
}
