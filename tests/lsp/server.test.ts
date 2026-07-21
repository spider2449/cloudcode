// tests/lsp/server.test.ts
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { LspServer, languageIdForUri, normalizeUri } from "../../src/engine/lsp/server.js";
import { makeFakeServer } from "./fakeServer.js";

function newServer(onDiag = (_u: string, _d: unknown[]) => {}) {
  const fake = makeFakeServer();
  const server = new LspServer("fake", [], "/root", onDiag as any, { spawnFn: () => fake as any });
  return { server, fake };
}

describe("LspServer", () => {
  it("initializes and resolves start() once", async () => {
    const { server } = newServer();
    const first = server.start();
    const second = server.start();
    expect(first).toBe(second); // same memoized promise, no second initialize
    await first;
    expect(server.alive).toBe(true);
  });

  it("returns a definition result", async () => {
    const { server } = newServer();
    await server.start();
    const result = await server.request("textDocument/definition", {});
    expect(result).toEqual([{ uri: "file:///def.ts", range: { start: { line: 4, character: 2 } } }]);
  });

  it("captures publishDiagnostics via the callback on didChange", async () => {
    const seen: Array<{ uri: string; diags: any[] }> = [];
    const { server } = newServer((uri, diags) => seen.push({ uri, diags: diags as any[] }));
    await server.start();
    server.didOpen("file:///a.ts", "ok");
    server.didChange("file:///a.ts", "BAD code");
    await new Promise(r => setTimeout(r, 10));
    expect(seen).toHaveLength(1);
    expect(seen[0].uri).toBe("file:///a.ts");
    expect(seen[0].diags[0].message).toBe("bad token");
    expect(seen[0].diags[0].line).toBe(0);
    expect(seen[0].diags[0].column).toBe(4);
  });

  it("rejects a pending request when aborted", async () => {
    const { server } = newServer();
    await server.start();
    const ctrl = new AbortController();
    const p = server.request("textDocument/references", {}, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toThrow();
  });

  it("times out if initialize never responds", async () => {
    const fakeProc = {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: { write() { return true; } },
      on() {},
      kill() {}
    };
    const server = new LspServer("fake", [], "/root", () => {}, {
      spawnFn: () => fakeProc as any,
      startTimeoutMs: 20
    });
    await expect(server.start()).rejects.toThrow(/timed out/);
  });
});

describe("languageIdForUri", () => {
  it("maps known extensions", () => {
    expect(languageIdForUri("file:///a/b.ts")).toBe("typescript");
    expect(languageIdForUri("file:///a/b.tsx")).toBe("typescriptreact");
    expect(languageIdForUri("file:///a/b.py")).toBe("python");
  });
  it("falls back to plaintext for unknown extensions", () => {
    expect(languageIdForUri("file:///a/b.unknownext")).toBe("plaintext");
  });
});

describe("normalizeUri", () => {
  it("lowercases a Windows drive letter", () => {
    expect(normalizeUri("file:///F:/a/b.ts")).toBe("file:///f:/a/b.ts");
  });
  it("leaves a POSIX path unchanged", () => {
    expect(normalizeUri("file:///home/x.ts")).toBe("file:///home/x.ts");
  });
});
