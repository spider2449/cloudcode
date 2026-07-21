import { describe, it, expect } from "vitest";
import { definitionTool, hoverTool, diagnosticsTool } from "../../src/engine/tools/lsp.js";
import { LspManager, fileUri } from "../../src/engine/lsp/manager.js";
import { LspServer } from "../../src/engine/lsp/server.js";
import { DEFAULT_SERVERS } from "../../src/engine/lsp/defaults.js";
import { makeFakeServer } from "./fakeServer.js";

function mgr() {
  return new LspManager(DEFAULT_SERVERS, {
    commandExists: () => true,
    makeServer: (cfg, root, onDiag) =>
      new LspServer(cfg.command, cfg.args, root, onDiag, { spawnFn: () => makeFakeServer() as any })
  });
}

describe("Definition tool", () => {
  it("returns a formatted location", async () => {
    const out = await definitionTool.execute(
      { file: "a.ts", line: 3, column: 1 },
      { cwd: "/x", lsp: mgr() }
    );
    expect(out.isError).toBeFalsy();
    expect(out.content).toMatch(/def\.ts:5:3/);
  });

  it("no-ops gracefully without a manager", async () => {
    const out = await definitionTool.execute({ file: "a.ts", line: 1, column: 1 }, { cwd: "/x" });
    expect(out.content).toMatch(/no LSP/i);
    expect(out.isError).toBeFalsy();
  });

  it("no-ops for an unknown extension", async () => {
    const out = await definitionTool.execute({ file: "a.txt", line: 1, column: 1 }, { cwd: "/x", lsp: mgr() });
    expect(out.content).toMatch(/no LSP/i);
  });
});

describe("Hover tool", () => {
  it("returns hover text", async () => {
    const out = await hoverTool.execute({ file: "a.ts", line: 1, column: 1 }, { cwd: "/x", lsp: mgr() });
    expect(out.content).toContain("const");
  });
});

describe("Diagnostics tool", () => {
  it("reports diagnostics for a file after a change", async () => {
    const m = mgr();
    const server = await m.serverFor("/x/a.ts", "/x");
    server!.didChange(fileUri("/x/a.ts"), "BAD");
    await new Promise(r => setTimeout(r, 10));
    const out = await diagnosticsTool.execute({ file: "a.ts" }, { cwd: "/x", lsp: m });
    expect(out.content).toContain("bad token");
  });
});
