import { describe, expect, it } from "vitest";
import { GuiServer, splitInputLines } from "../src/desktop/guiServer.js";
import type { Command } from "../src/commands/types.js";
import type { ChatEvent } from "../src/desktop/chatProtocol.js";

function contextFor(events: ChatEvent[]) {
  return (_req: { id: string; cwd: string }) => ({ notice: (text: string) => { events.push({ id: _req.id, type: "notice", text }); } }) as never;
}

function modelCommand(onRun: (ctx: unknown) => void): Command {
  return {
    name: "model",
    description: "m",
    run: async (ctx) => { onRun(ctx); ctx.notice("models"); }
  };
}

describe("GuiServer", () => {
  it("dispatches slash input with a full command context, not the turn runner", async () => {
    const events: ChatEvent[] = [];
    const seen: unknown[] = [];
    const server = new GuiServer({
      commands: () => new Map([["model", modelCommand(ctx => { seen.push(ctx); })]]),
      buildContext: contextFor(events),
      runTurn: async () => { throw new Error("turn runner must not run for slash input"); },
      emit: (event: ChatEvent) => { events.push(event); },
    });
    await server.handle({ id: "1", text: "/model" });
    expect(events.map(e => e.type)).toEqual(["notice", "done"]);
    expect(events[0]?.text).toBe("models");
    expect(seen).toHaveLength(1);
  });
  it("sends ordinary prompts to the turn runner with routing fields", async () => {
    const events: ChatEvent[] = [];
    const server = new GuiServer({
      commands: () => new Map(),
      buildContext: contextFor(events),
      runTurn: async (req, emit) => {
        expect(req).toEqual({ id: "2", cwd: "D:/work/proj", sessionId: "sess-9", text: "hello" });
        emit({ id: req.id, type: "text_delta", text: `echo:${req.text}` });
      },
      emit: (event: ChatEvent) => { events.push(event); },
    });
    await server.handle({ id: "2", text: "hello", cwd: "D:/work/proj", sessionId: "sess-9" });
    expect(events.map(e => e.type)).toEqual(["text_delta", "done"]);
  });
  it("reports unknown slash commands without throwing", async () => {
    const events: ChatEvent[] = [];
    const server = new GuiServer({
      commands: () => new Map(),
      buildContext: contextFor(events),
      runTurn: async () => { throw new Error("must not run"); },
      emit: (event: ChatEvent) => { events.push(event); },
    });
    await server.handle({ id: "3", text: "/nope" });
    expect(events[0]?.type).toBe("error");
    expect(events.at(-1)?.type).toBe("done");
  });
  it("resolves commands and context per workspace directory", async () => {
    const events: ChatEvent[] = [];
    const cwds: string[] = [];
    const server = new GuiServer({
      commands: (cwd: string) => {
        cwds.push(cwd);
        return new Map([["model", modelCommand(() => {})]]);
      },
      buildContext: (req: { id: string; cwd: string }) => {
        cwds.push(`${req.cwd}#${req.id}`);
        return contextFor(events)(req.cwd, req.id);
      },
      runTurn: async () => { throw new Error("must not run"); },
      emit: (event: ChatEvent) => { events.push(event); },
    });
    await server.handle({ id: "4", text: "/model", cwd: "D:/work/proj" });
    expect(cwds).toEqual(["D:/work/proj", "D:/work/proj#4"]);
    expect(events.map(e => e.type)).toEqual(["notice", "done"]);
  });
  it("defaults missing workspace to the backend working directory", async () => {
    const cwds: string[] = [];
    const server = new GuiServer({
      commands: (cwd: string) => {
        cwds.push(cwd);
        return new Map();
      },
      buildContext: contextFor([]),
      runTurn: async (req, emit) => {
        cwds.push(req.cwd);
        emit({ id: req.id, type: "text_delta", text: "x" });
      },
      emit: () => {},
    });
    await server.handle({ id: "5", text: "hello" });
    // commands() is only consulted for slash input; plain prompts go
    // straight to the turn runner with the default working directory.
    expect(cwds).toEqual([process.cwd()]);
  });
});

describe("gui server framing", () => {
  it("splits complete lines and keeps the partial tail", () => {
    expect(splitInputLines('{"id":"1"}\n{"id":"2"}\n{"id":"3"')).toEqual({ lines: ['{"id":"1"}', '{"id":"2"}'], rest: '{"id":"3"' });
  });
});

describe("gui server totality", () => {
  it("never rejects: malformed requests yield error and done", async () => {
    const events: ChatEvent[] = [];
    const server = new GuiServer({
      commands: () => new Map(),
      buildContext: (req: { id: string; cwd: string }) => contextFor(events)(req),
      runTurn: async () => { throw new Error("must not run"); },
      emit: (event: ChatEvent) => { events.push(event); },
    });
    await server.handle({ id: 123, text: "hi" });
    await server.handle({ id: "ok", text: undefined });
    await server.handle({ id: "ok2", text: "hi", cwd: "a\0b" });
    expect(events).toEqual([
      { id: "unknown", type: "error", text: expect.any(String) },
      { id: "unknown", type: "done" },
      { id: "ok", type: "error", text: expect.any(String) },
      { id: "ok", type: "done" },
      { id: "ok2", type: "error", text: expect.any(String) },
      { id: "ok2", type: "done" }
    ]);
  });
});
