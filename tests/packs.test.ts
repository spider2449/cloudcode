import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkPack } from "../src/agent/packLinks.js";
import { disablePack, enablePack, packDoctor, resolvePackContributions } from "../src/agent/packs.js";

const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), "cc-packs-")); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

function pack(base: string, capabilities = ["readProject", "localMcp", "runProcess"]): string {
  const path = join(base, "pack");
  mkdirSync(join(path, "skills", "diagnose"), { recursive: true });
  writeFileSync(join(path, "skills", "diagnose", "SKILL.md"), "---\nname: diagnose\ndescription: d\n---\nbody");
  writeFileSync(join(path, "mcp.json"), JSON.stringify({ mcpServers: { helper: { command: "node", args: ["helper.js"] } } }));
  writeFileSync(join(path, "lsp.json"), JSON.stringify({ hscript: { command: "hserver", args: [], extensions: [".h"], rootMarkers: [] } }));
  writeFileSync(join(path, "validations.json"), JSON.stringify({ profiles: { smoke: { commands: [{ command: "hython", args: ["test.py"] }] } } }));
  writeFileSync(join(path, "instructions.md"), "Use Houdini safely.");
  writeFileSync(join(path, "cloudcode-pack.json"), JSON.stringify({
    schemaVersion: 1, name: "houdini", version: "1.0.0", description: "Houdini", capabilities,
    requiredExecutables: ["hython"],
    resources: { skills: "skills", mcp: "mcp.json", lsp: "lsp.json", validations: "validations.json", instructions: "instructions.md" }
  }));
  return path;
}

describe("enabled pack contributions", () => {
  it("namespaces every executable contribution and disabling removes all resources", () => {
    const base = root();
    const cwd = root();
    linkPack(pack(base), base);
    enablePack("houdini", cwd, "providerOnly", base);
    const contributions = resolvePackContributions(cwd, base);
    expect(Object.keys(contributions.mcp)).toEqual(["pack__houdini__helper"]);
    expect(Object.keys(contributions.lsp)).toEqual(["pack__houdini__hscript"]);
    expect(contributions.validations.map(profile => profile.name)).toEqual(["houdini:smoke"]);
    expect(contributions.skillRoots[0]).toMatchObject({ pack: "houdini" });
    expect(contributions.skillRoots[0].path.toLowerCase()).toBe(join(base, "pack", "skills").toLowerCase());
    expect(contributions.instructions[0].text).toBe("Use Houdini safely.");
    disablePack("houdini", cwd);
    expect(resolvePackContributions(cwd, base)).toMatchObject({ packs: [], skillRoots: [], mcp: {}, lsp: {}, validations: [] });
  });

  it("rejects network capability outside unrestricted and diagnoses prerequisites", () => {
    const base = root();
    const cwd = root();
    linkPack(pack(base, ["network"]), base);
    expect(() => enablePack("houdini", cwd, "providerOnly", base)).toThrow(/network capability/);
    const doctor = packDoctor(base, command => command !== "hython");
    expect(doctor[0]).toMatchObject({ ok: false, details: ["missing executable: hython"] });
  });

  it("refuses stale linked content before enablement", () => {
    const base = root();
    const cwd = root();
    const path = pack(base);
    linkPack(path, base);
    writeFileSync(join(path, "instructions.md"), "changed");
    expect(() => enablePack("houdini", cwd, "providerOnly", base)).toThrow(/changed since it was linked/);
  });
});
