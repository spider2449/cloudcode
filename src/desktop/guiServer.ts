import { parseSlash } from "../commands/registry.js";
import { requireChatId, requireChatText, type ChatEvent } from "./chatProtocol.js";

export interface GuiServerDeps {
  commands: Map<string, { run(ctx: { notice(text: string): void }, args: string): Promise<void> }>;
  runTurn(id: string, text: string, emit: (event: ChatEvent) => void): Promise<void>;
  emit(event: ChatEvent): void;
}

export class GuiServer {
  constructor(private readonly deps: GuiServerDeps) {}

  async handle(raw: { id: unknown; text: unknown; sessionId?: unknown }): Promise<void> {
    const id = requireChatId(raw.id);
    const text = requireChatText(raw.text);
    const emit = this.deps.emit;
    try {
      const slash = parseSlash(text);
      if (slash) {
        const command = this.deps.commands.get(slash.name);
        if (!command) {
          emit({ id, type: "error", text: `Unknown command: /${slash.name}` });
          return;
        }
        await command.run({ notice: (notice: string) => emit({ id, type: "notice", text: notice }) }, slash.args);
        return;
      }
      await this.deps.runTurn(id, text, emit);
    } catch (error) {
      emit({ id, type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      emit({ id, type: "done" });
    }
  }
}

export function splitInputLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.filter(line => line.length > 0), rest };
}
