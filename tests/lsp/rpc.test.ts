import { describe, it, expect } from "vitest";
import { encodeMessage, MessageBuffer } from "../../src/engine/lsp/rpc.js";

describe("encodeMessage", () => {
  it("prefixes a Content-Length header and JSON body", () => {
    const out = encodeMessage({ jsonrpc: "2.0", id: 1, method: "x" }).toString("utf8");
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x" });
    expect(out).toBe(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  });
});

describe("MessageBuffer", () => {
  it("parses a single complete message", () => {
    const buf = new MessageBuffer();
    buf.push(encodeMessage({ id: 1 }));
    expect(buf.drain()).toEqual([{ id: 1 }]);
  });

  it("parses two messages arriving in one chunk", () => {
    const buf = new MessageBuffer();
    buf.push(Buffer.concat([encodeMessage({ id: 1 }), encodeMessage({ id: 2 })]));
    expect(buf.drain()).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("reassembles a message split across chunks", () => {
    const whole = encodeMessage({ hello: "world" });
    const buf = new MessageBuffer();
    buf.push(whole.subarray(0, 10));
    expect(buf.drain()).toEqual([]);
    buf.push(whole.subarray(10));
    expect(buf.drain()).toEqual([{ hello: "world" }]);
  });

  it("handles a multi-byte UTF-8 body by byte length, not char length", () => {
    const buf = new MessageBuffer();
    buf.push(encodeMessage({ s: "café→" }));
    expect(buf.drain()).toEqual([{ s: "café→" }]);
  });
});
