import { describe, expect, it } from "vitest";
import { GuiServer, splitInputLines } from "../src/desktop/guiServer.js";
import type { ChatEvent } from "../src/desktop/chatProtocol.js";

describe("GuiServer", () => {
  it("dispatches slash input through runSlashCommand, not the turn runner", async () => {
    const events: ChatEvent[] = [];
    const server = new GuiServer({
      commands: new Map([["model", { description: "m", run: async (ctx: { notice(text: string): void }) => { ctx.notice("models"); } } as never]]),
      runTurn: async (_id: string) => { throw new Error("turn runner must not run for slash input"); },
      emit: (event: ChatEvent) => { events.push(event); },
    });
    await server.handle({ id: "1", text: "/model" });
    expect(events.map(e => e.type)).toEqual(["notice", "done"]);
    expect(events[0]?.text).toBe("models");
  });
  it("sends ordinary prompts to the turn runner", async () => {
    const events: ChatEvent[] = [];
    const server = new GuiServer({
      commands: new Map(),
      runTurn: async (id: string, text: string, emit: (e: ChatEvent) => void) => { emit({ id, type: "text_delta", text: `echo:${text}` }); },
      emit: (event: ChatEvent) => { events.push(event); },
    });
    await server.handle({ id: "2", text: "hello" });
    expect(events.map(e => e.type)).toEqual(["text_delta", "done"]);
  });
  it("reports unknown slash commands without throwing", async () => {
    const events: ChatEvent[] = [];
    const server = new GuiServer({
      commands: new Map(),
      runTurn: async (_id: string) => { throw new Error("must not run"); },
      emit: (event: ChatEvent) => { events.push(event); },
    });
    await server.handle({ id: "3", text: "/nope" });
    expect(events[0]?.type).toBe("error");
    expect(events.at(-1)?.type).toBe("done");
  });
});

describe("gui server framing", () => {
  it("splits complete lines and keeps the partial tail", () => {
    expect(splitInputLines('{"id":"1"}\n{"id":"2"}\n{"id":"3"')).toEqual({ lines: ['{"id":"1"}', '{"id":"2"}'], rest: '{"id":"3"' });
  });
});
