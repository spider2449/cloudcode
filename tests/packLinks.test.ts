import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentLinkedPack, linkPack, loadPackLinks, loadProjectPackEnablement,
  saveProjectPackEnablement, unlinkPack
} from "../src/agent/packLinks.js";

const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), "cc-pack-links-")); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

function pack(rootPath: string, command = "node"): string {
  const path = join(rootPath, "pack");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "mcp.json"), JSON.stringify({ mcpServers: { helper: { command } } }));
  writeFileSync(join(path, "cloudcode-pack.json"), JSON.stringify({
    schemaVersion: 1, name: "local-pack", version: "1.0.0", description: "Local",
    capabilities: ["localMcp"], resources: { mcp: "mcp.json" }
  }));
  return path;
}

describe("pack links", () => {
  it("links only local paths and records a digest without copying", () => {
    const base = root();
    const path = pack(base);
    const link = linkPack(path, base, new Date("2026-08-19T00:00:00Z"));
    expect(link.path.toLowerCase()).toBe(path.toLowerCase());
    expect(loadPackLinks(base)).toEqual([link]);
    expect(() => linkPack("https://example.com/pack", base)).toThrow(/local filesystem/);
  });

  it("detects content drift until the local path is explicitly relinked", () => {
    const base = root();
    const path = pack(base);
    const first = linkPack(path, base);
    writeFileSync(join(path, "mcp.json"), JSON.stringify({ mcpServers: { helper: { command: "python" } } }));
    expect(currentLinkedPack("local-pack", base).stale).toBe(true);
    const refreshed = linkPack(path, base);
    expect(refreshed.digest).not.toBe(first.digest);
    expect(currentLinkedPack("local-pack", base).stale).toBe(false);
  });

  it("stores project enablement atomically and requires --yes to unlink", () => {
    const base = root();
    const cwd = root();
    const link = linkPack(pack(base), base);
    saveProjectPackEnablement(cwd, {
      schemaVersion: 1, enabled: [{ name: link.name, version: link.version, digest: link.digest }]
    });
    expect(loadProjectPackEnablement(cwd).enabled).toEqual([expect.objectContaining({ name: "local-pack" })]);
    expect(JSON.parse(readFileSync(join(cwd, ".cloudcode", "packs.json"), "utf8")).schemaVersion).toBe(1);
    expect(() => unlinkPack("local-pack", false, base)).toThrow(/--yes/);
    unlinkPack("local-pack", true, base);
    expect(loadPackLinks(base)).toEqual([]);
  });
});
