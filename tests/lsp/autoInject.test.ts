// tests/lsp/autoInject.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { appendDiagnostics } from "../../src/engine/lsp/autoInject.js";
import { LspManager, fileUri } from "../../src/engine/lsp/manager.js";
import { LspServer } from "../../src/engine/lsp/server.js";
import { DEFAULT_SERVERS } from "../../src/engine/lsp/defaults.js";
import { makeFakeServer } from "./fakeServer.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function mgr() {
  return new LspManager(DEFAULT_SERVERS, {
    commandExists: () => true,
    makeServer: (cfg, root, onDiag) =>
      new LspServer(cfg.command, cfg.args, root, onDiag, { spawnFn: () => makeFakeServer() as any })
  });
}

describe("appendDiagnostics", () => {
  it("appends a diagnostics block for an edited file with issues", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-"));
    const file = join(dir, "a.ts");
    writeFileSync(file, "BAD code", "utf8");
    const out = await appendDiagnostics("Edit", { file_path: file }, "edited a.ts", mgr(), dir);
    expect(out).toContain("edited a.ts");
    expect(out).toContain("bad token");
  });

  it("returns the original content unchanged for a clean file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-"));
    const file = join(dir, "a.ts");
    writeFileSync(file, "clean", "utf8");
    const out = await appendDiagnostics("Write", { file_path: file }, "wrote a.ts", mgr(), dir);
    expect(out).toBe("wrote a.ts");
  });

  it("passes through non-edit tools untouched", async () => {
    const out = await appendDiagnostics("Grep", {}, "matches", mgr(), "/x");
    expect(out).toBe("matches");
  });
});
