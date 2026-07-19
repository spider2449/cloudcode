import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpServersByScope, loadMcpServers } from "../src/agent/mcp.js";
import { formatMcpList } from "../src/commands/cli/mcpList.js";

const dir = () => mkdtempSync(join(tmpdir(), "mcplist-"));

describe("loadMcpServersByScope", () => {
  it("separates user and project servers", () => {
    const cwd = dir();
    const userPath = join(dir(), "mcp.json");
    writeFileSync(userPath, JSON.stringify({ mcpServers: { alpha: { command: "a" } } }));
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { beta: { command: "b" } } }));
    const scopes = loadMcpServersByScope(cwd, userPath);
    expect(Object.keys(scopes.user)).toEqual(["alpha"]);
    expect(Object.keys(scopes.project)).toEqual(["beta"]);
  });

  it("keeps loadMcpServers merge semantics (project wins)", () => {
    const cwd = dir();
    const userPath = join(dir(), "mcp.json");
    writeFileSync(userPath, JSON.stringify({ mcpServers: { s: { command: "user" } } }));
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { s: { command: "project" } } }));
    expect(loadMcpServers(cwd, userPath)).toEqual({ s: { command: "project" } });
  });
});

describe("formatMcpList", () => {
  it("reports empty configuration", () => {
    expect(formatMcpList({ user: {}, project: {} }))
      .toContain("No MCP servers configured");
  });

  it("annotates scopes and overrides", () => {
    const out = formatMcpList({
      user: { alpha: {}, shared: {} },
      project: { beta: {}, shared: {} }
    });
    expect(out).toContain("alpha  [user]");
    expect(out).toContain("beta  [project]");
    expect(out).toContain("shared  [project (overrides user)]");
  });
});
