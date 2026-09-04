import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMcpCommand } from "../src/commands/cli/mcp.js";

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), "cc-mcpcmd-"));
  const userPath = join(mkdtempSync(join(tmpdir(), "cc-mcpcfg-")), "mcp.json");
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { gh: { command: "npx" } } }));
  writeFileSync(userPath, JSON.stringify({ mcpServers: { docs: { command: "u" } } }));
  return { cwd, userPath };
}

const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe("runMcpCommand", () => {
  it("lists servers with scope tags", () => {
    const { cwd, userPath } = setup();
    const result = runMcpCommand([], cwd, userPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("gh  [project]");
    expect(result.stdout).toContain("docs  [user]");
  });

  it("disables a project server and reports the scope", () => {
    const { cwd, userPath } = setup();
    const result = runMcpCommand(["disable", "gh"], cwd, userPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Disabled gh (project). Restart or /clear to take effect.");
    expect(read(join(cwd, ".mcp.json")).mcpServers.gh.disabled).toBe(true);
  });

  it("resolves user scope when the name is user-only", () => {
    const { cwd, userPath } = setup();
    const result = runMcpCommand(["disable", "docs"], cwd, userPath);
    expect(result.stdout).toBe("Disabled docs (user). Restart or /clear to take effect.");
    expect(read(userPath).mcpServers.docs.disabled).toBe(true);
  });

  it("honors --scope and reports unknown names", () => {
    const { cwd, userPath } = setup();
    writeFileSync(userPath, JSON.stringify({ mcpServers: { gh: { command: "u" } } }));
    const scoped = runMcpCommand(["disable", "gh", "--scope", "user"], cwd, userPath);
    expect(scoped.stdout).toContain("Disabled gh (user).");
    const missing = runMcpCommand(["disable", "ghost"], cwd, userPath);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toContain('No MCP server named "ghost".');
  });

  it("is idempotent and rejects bad usage", () => {
    const { cwd, userPath } = setup();
    runMcpCommand(["disable", "gh"], cwd, userPath);
    const again = runMcpCommand(["disable", "gh"], cwd, userPath);
    expect(again.stdout).toContain("already disabled");
    const bad = runMcpCommand(["disable"], cwd, userPath);
    expect(bad.exitCode).toBe(1);
    expect(bad.stdout).toContain("Usage: cloudcode mcp [disable|enable <name>]");
  });
});
