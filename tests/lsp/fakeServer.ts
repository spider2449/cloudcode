// tests/lsp/fakeServer.ts
import { EventEmitter } from "node:events";
import { encodeMessage, MessageBuffer } from "../../src/engine/lsp/rpc.js";

// Minimal ChildProcess-like object driven by the LSP messages it receives.
export function makeFakeServer() {
  const stdout = new EventEmitter() as EventEmitter & { on: any };
  const buffer = new MessageBuffer();
  const emitted: unknown[] = [];

  function send(msg: unknown) {
    emitted.push(msg);
    stdout.emit("data", encodeMessage(msg));
  }

  const stdin = {
    write(chunk: Buffer) {
      buffer.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      for (const raw of buffer.drain()) handle(raw as any);
      return true;
    }
  };

  function handle(msg: { id?: number; method?: string; params?: any }) {
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
      return;
    }
    if (msg.method === "textDocument/definition") {
      send({ jsonrpc: "2.0", id: msg.id, result: [{ uri: "file:///def.ts", range: { start: { line: 4, character: 2 } } }] });
      return;
    }
    if (msg.method === "textDocument/hover") {
      send({ jsonrpc: "2.0", id: msg.id, result: { contents: { kind: "markdown", value: "**const** x: number" } } });
      return;
    }
    if (msg.method === "textDocument/didOpen" || msg.method === "textDocument/didChange") {
      const uri = msg.params.textDocument.uri;
      const text = msg.method === "textDocument/didOpen"
        ? msg.params.textDocument.text
        : msg.params.contentChanges[0].text;
      if (String(text).includes("BAD")) {
        send({
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: {
            uri,
            diagnostics: [{ range: { start: { line: 0, character: 4 } }, severity: 1, message: "bad token", code: "E1" }]
          }
        });
      }
      return;
    }
    // initialized / shutdown / exit: ignore.
  }

  const proc = new EventEmitter() as any;
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = new EventEmitter();
  proc.kill = () => proc.emit("exit", 0, null);
  proc.emitted = emitted;
  return proc;
}
