import { describe, it, expect } from "vitest";
import { LspManager } from "../../src/engine/lsp/manager.js";
import { LspServer, fileUri } from "../../src/engine/lsp/server.js";
import { makeFakeServer } from "./fakeServer.js";
import { DEFAULT_SERVERS } from "../../src/engine/lsp/defaults.js";

function makeManager() {
  const created: LspServer[] = [];
  const mgr = new LspManager(DEFAULT_SERVERS, {
    commandExists: () => true,
    makeServer: (cfg, root, onDiag) => {
      const s = new LspServer(cfg.command, cfg.args, root, onDiag, { spawnFn: () => makeFakeServer() as any });
      created.push(s);
      return s;
    }
  });
  return { mgr, created };
}

describe("LspManager", () => {
  it("returns undefined for an unknown extension", async () => {
    const { mgr } = makeManager();
    expect(await mgr.serverFor("/x/file.txt", "/x")).toBeUndefined();
  });

  it("returns undefined when the command is not installed", async () => {
    const mgr = new LspManager(DEFAULT_SERVERS, { commandExists: () => false });
    expect(await mgr.serverFor("/x/file.ts", "/x")).toBeUndefined();
  });

  it("pools one server per language+root", async () => {
    const { mgr, created } = makeManager();
    const a = await mgr.serverFor("/x/a.ts", "/x");
    const b = await mgr.serverFor("/x/b.ts", "/x");
    expect(a).toBe(b);
    expect(created).toHaveLength(1);
  });

  it("caches diagnostics and waits for a publish", async () => {
    const { mgr } = makeManager();
    const server = await mgr.serverFor("/x/a.ts", "/x");
    const uri = fileUri("/x/a.ts");
    server!.didChange(uri, "BAD stuff");
    const diags = await mgr.waitForDiagnostics(uri, 1000);
    expect(diags[0].message).toBe("bad token");
    expect(mgr.openFiles()).toContain(uri);
  });

  it("waitForDiagnostics resolves on timeout with an empty cache", async () => {
    const { mgr } = makeManager();
    await mgr.serverFor("/x/a.ts", "/x");
    const diags = await mgr.waitForDiagnostics(fileUri("/x/clean.ts"), 30);
    expect(diags).toEqual([]);
  });
});
