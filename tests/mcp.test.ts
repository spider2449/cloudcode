import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpServers, formatMcpStatus } from "../src/agent/mcp.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "cc-mcp-"));
}

describe("loadMcpServers", () => {
  it("loads project .mcp.json", () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { github: { command: "npx" } } }));
    const servers = loadMcpServers(cwd, join(tempDir(), "mcp.json"));
    expect(servers).toEqual({ github: { command: "npx" } });
  });

  it("loads user config and lets project entries win on conflict", () => {
    const cwd = tempDir();
    const userFile = join(tempDir(), "mcp.json");
    writeFileSync(userFile, JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://u" }, github: { command: "user" } } }));
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { github: { command: "project" } } }));
    const servers = loadMcpServers(cwd, userFile);
    expect(servers).toEqual({ docs: { type: "http", url: "https://u" }, github: { command: "project" } });
  });

  it("returns {} for missing files", () => {
    expect(loadMcpServers(tempDir(), join(tempDir(), "mcp.json"))).toEqual({});
  });

  it("tolerates malformed JSON and wrong-shape mcpServers", () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, ".mcp.json"), "{not json");
    const userFile = join(tempDir(), "mcp.json");
    writeFileSync(userFile, JSON.stringify({ mcpServers: "nope" }));
    expect(loadMcpServers(cwd, userFile)).toEqual({});
  });
});

describe("formatMcpStatus", () => {
  it("reports no servers configured", () => {
    expect(formatMcpStatus([], [], [])).toBe(
      "No MCP servers configured. Add them to .mcp.json or ~/.cloudcode/mcp.json."
    );
  });

  it("lists each server with status and its tools", () => {
    const out = formatMcpStatus(
      ["github", "docs"],
      [{ name: "github", status: "connected" }, { name: "docs", status: "failed" }],
      ["mcp__github__create_issue", "mcp__github__get_repo", "Bash"]
    );
    expect(out).toBe("github  connected  tools: create_issue, get_repo\ndocs  failed");
  });

  it("shows pending for configured servers missing from the status list", () => {
    expect(formatMcpStatus(["github"], [], [])).toBe("github  pending");
  });
});
