import { parseSlash } from "../commands/registry.js";
import type { Command, CommandContext } from "../commands/types.js";
import {
  requireChatId, requireChatText, requireChatCwd, requireChatSessionId,
  type ChatEvent
} from "./chatProtocol.js";

export interface GuiTurnRequest {
  id: string;
  cwd: string;
  sessionId: string | undefined;
  text: string;
}

export interface GuiServerDeps {
  commands(cwd: string): ReadonlyMap<string, Command>;
  buildContext(req: GuiTurnRequest): CommandContext;
  runTurn(req: GuiTurnRequest, emit: (event: ChatEvent) => void): Promise<void>;
  emit(event: ChatEvent): void;
}

export class GuiServer {
  constructor(private readonly deps: GuiServerDeps) {}

  async handle(raw: { id: unknown; text: unknown; cwd?: unknown; sessionId?: unknown }): Promise<void> {
    const id = requireChatId(raw.id);
    const text = requireChatText(raw.text);
    const emit = this.deps.emit;
    try {
      const cwd = requireChatCwd(raw.cwd) ?? process.cwd();
      const sessionId = requireChatSessionId(raw.sessionId);
      const req: GuiTurnRequest = { id, cwd, sessionId, text };
      const slash = parseSlash(text);
      if (slash) {
        const command = this.deps.commands(cwd).get(slash.name);
        if (!command) {
          emit({ id, type: "error", text: `Unknown command: /${slash.name}` });
          return;
        }
        await command.run(this.deps.buildContext(req), slash.args);
        return;
      }
      await this.deps.runTurn(req, emit);
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
