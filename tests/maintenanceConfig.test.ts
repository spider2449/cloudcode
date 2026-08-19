import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMaintenanceProfiles } from "../src/agent/maintenanceConfig.js";
import { linkPack } from "../src/agent/packLinks.js";
import { enablePack } from "../src/agent/packs.js";

const roots: string[] = [];
const temp = () => { const path = mkdtempSync(join(tmpdir(), "cc-maint-config-")); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("maintenance profiles", () => {
  it("loads built-ins and applies project over user precedence", () => {
    const base = temp();
    const cwd = temp();
    mkdirSync(join(cwd, ".cloudcode"));
    writeFileSync(join(base, "maintenance.json"), JSON.stringify({ profiles: {
      health: { prompt: "user", execution: "analysis", networkMode: "providerOnly", limits: { maxTurns: 2 } }
    } }));
    writeFileSync(join(cwd, ".cloudcode", "maintenance.json"), JSON.stringify({ profiles: {
      health: { prompt: "project", execution: "analysis", networkMode: "offlineStrict", limits: { timeoutMs: 1000 } }
    } }));
    const result = loadMaintenanceProfiles(cwd, base);
    expect(result.profiles.find(profile => profile.name === "health")).toMatchObject({
      prompt: "project", source: "project", networkMode: "offlineStrict", limits: { timeoutMs: 1000 }
    });
    expect(result.profiles.find(profile => profile.name === "dependencies")?.prompt).toMatch(/not claim.*vulnerability audit/i);
  });

  it("ignores malformed entries with actionable warnings", () => {
    const base = temp();
    const cwd = temp();
    writeFileSync(join(base, "maintenance.json"), JSON.stringify({ profiles: {
      broken: { prompt: "x", execution: "write", networkMode: "unrestricted", limits: { maxTurns: 0 } }
    } }));
    const result = loadMaintenanceProfiles(cwd, base);
    expect(result.profiles.some(profile => profile.name === "broken")).toBe(false);
    expect(result.warnings.join("\n")).toContain("broken");
  });

  it("loads profiles contributed by an enabled local pack", () => {
    const base = temp(); const cwd = temp(); const pack = join(base, "pack");
    mkdirSync(pack);
    writeFileSync(join(pack, "maintenance.json"), JSON.stringify({ profiles: {
      studio: { prompt: "inspect studio files", execution: "analysis", networkMode: "offlineStrict", limits: { maxTurns: 3 } }
    } }));
    writeFileSync(join(pack, "cloudcode-pack.json"), JSON.stringify({
      schemaVersion: 1, name: "studio", version: "1.0.0", description: "Studio",
      capabilities: ["readProject"], resources: { maintenance: "maintenance.json" }
    }));
    linkPack(pack, base);
    enablePack("studio", cwd, "providerOnly", base);
    expect(loadMaintenanceProfiles(cwd, base).profiles.find(profile => profile.name === "studio")?.source).toBe("pack:studio");
  });
});
