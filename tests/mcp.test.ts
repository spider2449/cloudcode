import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpServers, loadMcpServersByScope, saveMcpServer, removeMcpServer, formatMcpStatus, isMcpServerDisabled, resolveMcpServerScope, setMcpServerDisabled } from "../src/agent/mcp.js";
import { linkPack } from "../src/agent/packLinks.js";
import { enablePack } from "../src/agent/packs.js";

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

  it("can exclude project servers before trust is granted", () => {
    const cwd = tempDir();
    const userFile = join(tempDir(), "mcp.json");
    writeFileSync(userFile, JSON.stringify({ mcpServers: { user: { command: "user" } } }));
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { project: { command: "project" } } }));
    expect(loadMcpServers(cwd, userFile, false)).toEqual({ user: { command: "user" } });
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

  it("merges enabled pack servers by namespace and rejects project collisions", () => {
    const base = tempDir();
    const cwd = tempDir();
    const pack = join(base, "pack");
    mkdirSync(pack);
    writeFileSync(join(pack, "mcp.json"), JSON.stringify({ mcpServers: { helper: { command: "node" } } }));
    writeFileSync(join(pack, "cloudcode-pack.json"), JSON.stringify({
      schemaVersion: 1, name: "workflow", version: "1.0.0", description: "Workflow",
      capabilities: ["localMcp"], resources: { mcp: "mcp.json" }
    }));
    linkPack(pack, base);
    enablePack("workflow", cwd, "providerOnly", base);
    const userFile = join(base, "mcp.json");
    expect(loadMcpServers(cwd, userFile)).toMatchObject({ pack__workflow__helper: { command: "node" } });
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { pack__workflow__helper: { command: "other" } } }));
    expect(() => loadMcpServers(cwd, userFile)).toThrow(/collision/);
  });
});

describe("saveMcpServer/removeMcpServer", () => {
  it("saves an stdio server to project scope and preserves unknown top-level keys", () => {
    const cwd = tempDir();
    const userFile = join(tempDir(), "mcp.json");
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ futureField: { kept: true }, mcpServers: {} }));
    saveMcpServer("gh", { command: "npx", args: ["gh-mcp"] }, "project", cwd, userFile);
    const raw = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
    expect(raw.futureField).toEqual({ kept: true });
    expect(raw.mcpServers.gh).toEqual({ command: "npx", args: ["gh-mcp"] });
  });

  it("saves an http server to user scope and overwrites same-named entries", () => {
    const cwd = tempDir();
    const userFile = join(tempDir(), "mcp.json");
    writeFileSync(userFile, JSON.stringify({ mcpServers: { docs: { command: "old" } } }));
    saveMcpServer("docs", { type: "http", url: "https://u" }, "user", cwd, userFile);
    expect(loadMcpServers(cwd, userFile)).toEqual({ docs: { type: "http", url: "https://u" } });
  });

  it("removes only the named server from the requested scope", () => {
    const cwd = tempDir();
    const userFile = join(tempDir(), "mcp.json");
    writeFileSync(userFile, JSON.stringify({ mcpServers: { keep: { command: "k" }, drop: { command: "d" } } }));
    removeMcpServer("drop", "user", cwd, userFile);
    expect(loadMcpServersByScope(cwd, userFile).user).toEqual({ keep: { command: "k" } });
  });

  it("creates the file when missing", () => {
    const cwd = tempDir();
    const userFile = join(tempDir(), "nested", "mcp.json");
    saveMcpServer("x", { command: "x" }, "user", cwd, userFile);
    expect(loadMcpServers(cwd, userFile)).toEqual({ x: { command: "x" } });
  });
});

describe("mcp disable/enable flag", () => {
  it("treats only disabled === true as disabled", () => {
    expect(isMcpServerDisabled({ command: "n" })).toBe(false);
    expect(isMcpServerDisabled({ command: "n", disabled: true })).toBe(true);
    expect(isMcpServerDisabled({ command: "n", disabled: false })).toBe(false);
  });

  it("resolves project-first scope and undefined when absent", () => {
    const cwd = tempDir();
    const userFile = join(tempDir(), "mcp.json");
    writeFileSync(userFile, JSON.stringify({ mcpServers: { onlyUser: { command: "u" }, both: { command: "u" } } }));
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { both: { command: "p" } } }));
    expect(resolveMcpServerScope("both", cwd, userFile)).toBe("project");
    expect(resolveMcpServerScope("onlyUser", cwd, userFile)).toBe("user");
    expect(resolveMcpServerScope("missing", cwd, userFile)).toBeUndefined();
  });

  it("sets and clears the flag preserving sibling keys", () => {
    const cwd = tempDir();
    const userFile = join(tempDir(), "mcp.json");
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { gh: { command: "npx", args: ["a"] } } }));
    setMcpServerDisabled("gh", true, "project", cwd, userFile);
    expect(loadMcpServersByScope(cwd, userFile).project.gh).toEqual({ command: "npx", args: ["a"], disabled: true });
    setMcpServerDisabled("gh", false, "project", cwd, userFile);
    expect(loadMcpServersByScope(cwd, userFile).project.gh).toEqual({ command: "npx", args: ["a"] });
  });

  it("throws for unknown names", () => {
    const cwd = tempDir();
    const userFile = join(tempDir(), "mcp.json");
    expect(() => setMcpServerDisabled("ghost", true, "project", cwd, userFile)).toThrow(/No MCP server named/);
  });

  it("excludes disabled servers from loadMcpServers and strips the flag", () => {
    const cwd = tempDir();
    const userFile = join(tempDir(), "mcp.json");
    writeFileSync(userFile, JSON.stringify({ mcpServers: { docs: { command: "u" } } }));
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: {
      gh: { command: "p", disabled: true },
      docs: { command: "p-override" }
    } }));
    expect(loadMcpServers(cwd, userFile)).toEqual({ docs: { command: "p-override" } });
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
