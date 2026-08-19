import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPackCommand } from "../src/commands/cli/pack.js";

const roots: string[] = [];
const temp = () => { const path = mkdtempSync(join(tmpdir(), "cc-cli-pack-")); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture(root: string, capabilities: string[] = ["readProject"]): string {
  const path = join(root, "pack");
  mkdirSync(path);
  writeFileSync(join(path, "instructions.md"), "Local instructions.");
  writeFileSync(join(path, "cloudcode-pack.json"), JSON.stringify({
    schemaVersion: 1, name: "fixture", version: "1.0.0", description: "Fixture",
    capabilities, resources: { instructions: "instructions.md" }
  }));
  return path;
}

describe("pack CLI", () => {
  it("validates, links, inspects, enables, disables, and unlinks a local pack", () => {
    const base = temp();
    const cwd = temp();
    const path = fixture(base);
    expect(runPackCommand(["validate", path], { cwd, base, networkMode: "providerOnly" }).exitCode).toBe(0);
    expect(runPackCommand(["link", path], { cwd, base, networkMode: "providerOnly" }).stdout).toContain("Linked fixture@1.0.0");
    expect(runPackCommand(["list"], { cwd, base, networkMode: "providerOnly" }).stdout).toContain("ready");
    expect(runPackCommand(["inspect", "fixture"], { cwd, base, networkMode: "providerOnly" }).stdout).toContain('"stale": false');
    expect(runPackCommand(["enable", "fixture", "--project"], { cwd, base, networkMode: "providerOnly" }).exitCode).toBe(0);
    expect(runPackCommand(["disable", "fixture", "--project"], { cwd, base, networkMode: "providerOnly" }).exitCode).toBe(0);
    expect(runPackCommand(["unlink", "fixture"], { cwd, base, networkMode: "providerOnly" }).exitCode).toBe(2);
    expect(runPackCommand(["unlink", "fixture", "--yes"], { cwd, base, networkMode: "providerOnly" }).exitCode).toBe(0);
  });

  it("rejects URLs and returns privacy denial for network-capable enablement", () => {
    const base = temp();
    const cwd = temp();
    expect(runPackCommand(["link", "https://example.com/pack"], { cwd, base, networkMode: "providerOnly" }).exitCode).toBe(2);
    const path = fixture(base, ["network"]);
    runPackCommand(["link", path], { cwd, base, networkMode: "providerOnly" });
    expect(runPackCommand(["enable", "fixture", "--project"], { cwd, base, networkMode: "providerOnly" }).exitCode).toBe(7);
  });

  it("reports content drift as a state conflict", () => {
    const base = temp();
    const cwd = temp();
    const path = fixture(base);
    runPackCommand(["link", path], { cwd, base, networkMode: "providerOnly" });
    writeFileSync(join(path, "instructions.md"), "Changed.");
    expect(runPackCommand(["enable", "fixture", "--project"], { cwd, base, networkMode: "providerOnly" }).exitCode).toBe(6);
  });
});
