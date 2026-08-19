import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePackManifest, validatePackDirectory } from "../src/agent/packManifest.js";

const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), "cc-pack-")); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture(): string {
  const path = root();
  mkdirSync(join(path, "skills", "diagnose"), { recursive: true });
  writeFileSync(join(path, "skills", "diagnose", "SKILL.md"), "---\nname: diagnose\ndescription: Diagnose\n---\nDo it");
  writeFileSync(join(path, "mcp.json"), JSON.stringify({ mcpServers: { helper: { command: "node", args: ["helper.js"] } } }));
  writeFileSync(join(path, "cloudcode-pack.json"), JSON.stringify({
    schemaVersion: 1, name: "houdini-tools", version: "1.0.0", description: "Houdini workflows",
    platforms: ["win32"], requiredExecutables: ["hython"], capabilities: ["readProject", "localMcp"],
    resources: { skills: "skills", mcp: "mcp.json" }, futureField: { retained: true }
  }));
  return path;
}

describe("pack manifests", () => {
  it("strictly parses known fields while preserving unknown keys", () => {
    const result = validatePackDirectory(fixture());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pack.manifest.unknown).toEqual({ futureField: { retained: true } });
    expect(result.pack.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("digest changes when executable contributed content changes", () => {
    const path = fixture();
    const first = validatePackDirectory(path);
    writeFileSync(join(path, "mcp.json"), JSON.stringify({ mcpServers: { helper: { command: "python" } } }));
    const second = validatePackDirectory(path);
    expect(first.ok && second.ok && first.pack.digest).not.toBe(second.ok ? second.pack.digest : "");
  });

  it("rejects invalid capabilities, paths, and missing resources", () => {
    expect(parsePackManifest({ schemaVersion: 1, name: "Bad Name", version: "x", description: "", capabilities: ["magic"] }).errors.length)
      .toBeGreaterThan(2);
    const path = root();
    writeFileSync(join(path, "cloudcode-pack.json"), JSON.stringify({
      schemaVersion: 1, name: "valid-name", version: "1.0.0", description: "x", resources: { skills: "missing" }
    }));
    const result = validatePackDirectory(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain("does not exist");
  });
});
