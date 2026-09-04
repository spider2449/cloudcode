import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetupCommand, type SetupDeps } from "../src/commands/cli/setup.js";
import { PermissionStore } from "../src/agent/permissionStore.js";

function scriptDeps(answers: string[]): { deps: SetupDeps; configBase: string; cwd: string } {
  const queue = [...answers];
  const configBase = mkdtempSync(join(tmpdir(), "setup-cfg-"));
  const cwd = mkdtempSync(join(tmpdir(), "setup-cwd-"));
  const deps: SetupDeps = {
    configBase,
    cwd,
    promptText: async (label: string) => {
      const next = queue.shift();
      if (next === undefined) throw new Error(`prompt script exhausted at: ${label}`);
      return next;
    }
  };
  return { deps, configBase, cwd };
}

const settingsOf = (configBase: string) =>
  JSON.parse(readFileSync(join(configBase, "settings.json"), "utf8"));

describe("runSetupCommand settings sections", () => {
  it("saves provider, model, network mode, theme, effort, and memory answers", async () => {
    const { deps, configBase } = scriptDeps([
      "acme", "my-model",
      "offlineStrict",
      "",
      "done",
      "dracula", "high", "n"
    ]);
    writeFileSync(join(configBase, "providers.json"), JSON.stringify({ acme: { kind: "openai" } }));
    const result = await runSetupCommand([], deps);
    expect(result.exitCode).toBe(0);
    expect(settingsOf(configBase)).toEqual({
      provider: "acme",
      model: "my-model",
      networkMode: "offlineStrict",
      theme: "dracula",
      effort: "high",
      autoMemoryEnabled: false
    });
  });

  it("Enter keeps current values and writes nothing when nothing changes", async () => {
    const { deps, configBase } = scriptDeps(["", "", "", "", "done", "", "", ""]);
    await runSetupCommand([], deps);
    expect(existsSync(join(configBase, "settings.json"))).toBe(false);
  });

  it("re-prompts on invalid network mode and invalid effort before accepting", async () => {
    const { deps, configBase } = scriptDeps([
      "", "",
      "bogus", "providerOnly",
      "",
      "done",
      "", "nope", "low", ""
    ]);
    await runSetupCommand([], deps);
    const s = settingsOf(configBase);
    expect(s.networkMode).toBe("providerOnly");
    expect(s.effort).toBe("low");
  });

  it("rejects unknown provider names without saving them", async () => {
    const { deps, configBase } = scriptDeps(["ghost", "", "", "", "done", "", "", ""]);
    await runSetupCommand([], deps);
    expect(existsSync(join(configBase, "settings.json"))).toBe(false);
  });

  it("ends with a summary containing effective values", async () => {
    const { deps } = scriptDeps(["", "", "", "", "done", "", "", ""]);
    const result = await runSetupCommand([], deps);
    expect(result.stdout).toContain("Effective settings:");
  });
});

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe("runSetupCommand mcp section", () => {
  it("adds stdio server to project scope and http server to user scope, then done", async () => {
    const { deps, configBase, cwd } = scriptDeps([
      "", "",
      "",
      "add", "gh", "stdio", "npx", "gh-mcp --stdio", "project",
      "add", "docs", "http", "https://mcp.example/sse", "user",
      "done",
      "done",
      "", "", ""
    ]);
    await runSetupCommand([], deps);
    const projectRaw = readJson(join(cwd, ".mcp.json"));
    expect(projectRaw.mcpServers.gh).toEqual({ command: "npx", args: ["gh-mcp", "--stdio"] });
    const userRaw = readJson(join(configBase, "mcp.json"));
    expect(userRaw.mcpServers.docs).toEqual({ type: "http", url: "https://mcp.example/sse" });
  });

  it("preserves unknown top-level keys when writing .mcp.json", async () => {
    const { deps, cwd } = scriptDeps([
      "", "",
      "",
      "add", "x", "stdio", "node", "", "project", "done",
      "done",
      "", "", ""
    ]);
    const projectFile = join(cwd, ".mcp.json");
    writeFileSync(projectFile, JSON.stringify({ futureField: { kept: true }, mcpServers: {} }));
    await runSetupCommand([], deps);
    expect(readJson(projectFile).futureField).toEqual({ kept: true });
  });

  it("removes a listed server by number", async () => {
    const { deps, cwd } = scriptDeps([
      "", "",
      "",
      "remove", "1", "done",
      "done",
      "", "", ""
    ]);
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { old: { command: "o" } } }));
    await runSetupCommand([], deps);
    expect(readJson(join(cwd, ".mcp.json")).mcpServers).toEqual({});
  });

  it("disables a server by number", async () => {
    const { deps, cwd } = scriptDeps([
      "", "",
      "",
      "disable", "1", "done",
      "done",
      "", "", ""
    ]);
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { gh: { command: "npx" } } }));
    await runSetupCommand([], deps);
    expect(readJson(join(cwd, ".mcp.json")).mcpServers.gh).toEqual({ command: "npx", disabled: true });
  });

  it("re-enables a disabled server by number", async () => {
    const { deps, cwd } = scriptDeps([
      "", "",
      "",
      "enable", "1", "done",
      "done",
      "", "", ""
    ]);
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { gh: { command: "npx", disabled: true } } }));
    await runSetupCommand([], deps);
    expect(readJson(join(cwd, ".mcp.json")).mcpServers.gh).toEqual({ command: "npx" });
  });
});

describe("runSetupCommand permissions section", () => {
  it("adds bash allow, directory deny, removes by number", async () => {
    const { deps, cwd } = scriptDeps([
      "", "",
      "",
      "",
      "allow", "bash", "git",
      "deny", "dir", "Edit", "D:/secret",
      "remove", "1",
      "done",
      "", "", ""
    ]);
    await runSetupCommand([], deps);
    const store = new PermissionStore(cwd);
    expect(store.checkCommand("git status")).toBeUndefined();
    expect(store.check("Edit", "D:/secret/file.txt")).toBe("deny");
    expect(store.checkCommand("npm test")).toBeUndefined();
  });

  it("keeps an allowed prefix usable end to end", async () => {
    const { deps, cwd } = scriptDeps([
      "", "",
      "",
      "",
      "allow", "bash", "pytest",
      "done",
      "", "", ""
    ]);
    await runSetupCommand([], deps);
    const store = new PermissionStore(cwd);
    expect(store.checkCommand("pytest -q")).toBe("allow");
  });
});

