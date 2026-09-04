import { parseSlash } from "./registry.js";
import type { Command, CommandContext } from "./types.js";

export interface CommandRuntimeCallbacks {
  onUnknown(name: string): void;
  onError(error: unknown): void;
  onSettled?(): void;
}

/**
 * Parses and executes one slash command through the shared command registry.
 * Returns undefined for ordinary prompts so the caller can send them to the
 * agent without duplicating command detection.
 */
export function runSlashCommand(
  input: string,
  registry: ReadonlyMap<string, Command>,
  context: CommandContext,
  callbacks: CommandRuntimeCallbacks
): Promise<void> | undefined {
  const slash = parseSlash(input);
  if (!slash) return undefined;
  const command = registry.get(slash.name);
  if (!command) {
    callbacks.onUnknown(slash.name);
    callbacks.onSettled?.();
    return Promise.resolve();
  }
  return command.run(context, slash.args)
    .catch(callbacks.onError)
    .finally(() => callbacks.onSettled?.());
}
