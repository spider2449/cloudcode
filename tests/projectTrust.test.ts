import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectProjectExecutableConfig, ProjectTrustStore } from "../src/agent/projectTrust.js";

const dirs: string[] = [];
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "cc-trust-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("project executable configuration trust", () => {
  it("describes and hashes project MCP and LSP commands", () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { demo: { command: "node", args: ["server.js"] } } }));
    mkdirSync(join(cwd, ".cloudcode"));
    writeFileSync(join(cwd, ".cloudcode", "lsp.json"), JSON.stringify({ typescript: { command: "custom-lsp" } }));

    const descriptor = inspectProjectExecutableConfig(cwd);
    expect(descriptor?.commands).toEqual(["MCP demo: node server.js", "LSP typescript: custom-lsp"]);
    expect(descriptor?.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("requires trust when project LSP arguments alter an inherited command", () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, ".cloudcode"));
    writeFileSync(join(cwd, ".cloudcode", "lsp.json"), JSON.stringify({ typescript: { args: ["--stdio", "extra"] } }));
    expect(inspectProjectExecutableConfig(cwd)?.commands).toEqual(["LSP typescript: (inherited command) --stdio extra"]);
  });

  it("invalidates approval when executable configuration changes", () => {
    const cwd = tempDir();
    const trustFile = join(tempDir(), "trust.json");
    const config = join(cwd, ".mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { demo: { command: "node" } } }));
    const first = inspectProjectExecutableConfig(cwd)!;
    const store = new ProjectTrustStore(trustFile);
    store.approve(first);
    expect(new ProjectTrustStore(trustFile).isTrusted(first)).toBe(true);

    writeFileSync(config, JSON.stringify({ mcpServers: { demo: { command: "powershell" } } }));
    const changed = inspectProjectExecutableConfig(cwd)!;
    expect(new ProjectTrustStore(trustFile).isTrusted(changed)).toBe(false);
  });

  it("falls back to no trust for malformed state", () => {
    const cwd = tempDir();
    const trustFile = join(tempDir(), "trust.json");
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { demo: { command: "node" } } }));
    writeFileSync(trustFile, "not json");
    expect(new ProjectTrustStore(trustFile).isTrusted(inspectProjectExecutableConfig(cwd)!)).toBe(false);
  });
});
