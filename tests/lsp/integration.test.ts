import { describe, it, expect } from "vitest";
import { commandExists } from "../../src/engine/lsp/detect.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspManager, fileUri } from "../../src/engine/lsp/manager.js";

const hasTs = commandExists("typescript-language-server");

describe.skipIf(!hasTs)("real typescript-language-server", () => {
  it("produces a diagnostic for a type error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lsp-int-"));
    writeFileSync(join(dir, "package.json"), "{}", "utf8");
    const file = join(dir, "a.ts");
    writeFileSync(file, "const x: number = 'nope';\n", "utf8");
    const mgr = new LspManager();
    const server = await mgr.serverFor(file, dir);
    expect(server).toBeDefined();
    server!.didOpen(fileUri(file), "const x: number = 'nope';\n");
    const diags = await mgr.waitForDiagnostics(fileUri(file), 8000);
    mgr.shutdown();
    expect(diags.length).toBeGreaterThan(0);
  }, 15000);
});
