import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectProjectExecutableConfig, ProjectTrustStore } from "../src/agent/projectTrust.js";
import { linkPack } from "../src/agent/packLinks.js";
import { enablePack } from "../src/agent/packs.js";

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

  it("includes task verification commands in the content digest", () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, ".cloudcode"));
    const path = join(cwd, ".cloudcode", "task.json");
    writeFileSync(path, JSON.stringify({ profiles: { focused: { commands: [{ command: "npm", args: ["test"] }] } } }));
    const first = inspectProjectExecutableConfig(cwd);
    expect(first?.commands).toEqual(["Task focused: npm test"]);
    writeFileSync(path, JSON.stringify({ profiles: { focused: { commands: [{ command: "npm", args: ["run", "build"] }] } } }));
    expect(inspectProjectExecutableConfig(cwd)?.digest).not.toBe(first?.digest);
  });

  it("includes enabled pack commands and project enablement in trust", () => {
    const cwd = tempDir();
    const base = tempDir();
    const pack = join(tempDir(), "pack");
    mkdirSync(pack);
    writeFileSync(join(pack, "validations.json"), JSON.stringify({
      profiles: { smoke: { commands: [{ command: "hython", args: ["smoke.py"] }] } }
    }));
    writeFileSync(join(pack, "cloudcode-pack.json"), JSON.stringify({
      schemaVersion: 1, name: "houdini", version: "1.0.0", description: "Houdini",
      capabilities: ["runProcess"], resources: { validations: "validations.json" }
    }));
    linkPack(pack, base);
    enablePack("houdini", cwd, "providerOnly", base);
    const first = inspectProjectExecutableConfig(cwd, base);
    expect(first?.commands).toEqual(["Pack validation houdini:smoke: hython smoke.py"]);
    expect(first?.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("includes isolated maintenance validation selection in trust", () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, ".cloudcode"));
    writeFileSync(join(cwd, ".cloudcode", "maintenance.json"), JSON.stringify({ profiles: {
      verify: { prompt: "verify", execution: "isolatedVerification", validationProfile: "focused", networkMode: "offlineStrict", limits: {} }
    } }));
    expect(inspectProjectExecutableConfig(cwd)?.commands).toEqual(["Maintenance verify: validation profile focused"]);
  });

  it("falls back to no trust for malformed state", () => {
    const cwd = tempDir();
    const trustFile = join(tempDir(), "trust.json");
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { demo: { command: "node" } } }));
    writeFileSync(trustFile, "not json");
    expect(new ProjectTrustStore(trustFile).isTrusted(inspectProjectExecutableConfig(cwd)!)).toBe(false);
  });
});

describe("hooks.json in the trust descriptor", () => {
  it("lists hook commands and includes the file raw when present", () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, ".cloudcode"), { recursive: true });
    const hooksJson = JSON.stringify({
      hooks: { PreToolUse: [{ command: "node guard.js" }] }
    });
    writeFileSync(join(cwd, ".cloudcode", "hooks.json"), hooksJson);
    const descriptor = inspectProjectExecutableConfig(cwd);
    if (!descriptor) throw new Error("expected a descriptor");
    expect(descriptor.commands).toContain("Hook: node guard.js");
  });

  it("does not create a descriptor for an invalid or absent hooks file", () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, ".cloudcode"), { recursive: true });
    writeFileSync(join(cwd, ".cloudcode", "hooks.json"), "{nope");
    expect(inspectProjectExecutableConfig(cwd)).toBeUndefined();
  });
});
