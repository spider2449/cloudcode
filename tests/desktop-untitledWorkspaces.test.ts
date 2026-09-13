import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadUntitledWorkspaces, removeUntitledWorkspace, saveUntitledWorkspace } from "../src/desktop/untitledWorkspaces.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tempFile(): string {
  const root = mkdtempSync(join(tmpdir(), "cc-uws-"));
  roots.push(root);
  return join(root, "untitled.json");
}

describe("untitled workspaces", () => {
  it("round-trips workspace id to member dirs", () => {
    const file = tempFile();
    expect(loadUntitledWorkspaces(file)).toEqual({});
    saveUntitledWorkspace("id-1", ["D:/work/api", "D:/work/web"], file);
    expect(loadUntitledWorkspaces(file)).toEqual({ "id-1": ["D:/work/api", "D:/work/web"] });
  });

  it("removes entries and ignores unknown ids", () => {
    const file = tempFile();
    saveUntitledWorkspace("id-1", ["D:/work/api"], file);
    expect(() => removeUntitledWorkspace("missing", file)).not.toThrow();
    removeUntitledWorkspace("id-1", file);
    expect(loadUntitledWorkspaces(file)).toEqual({});
  });

  it("returns empty for missing or malformed files", () => {
    const file = tempFile();
    expect(loadUntitledWorkspaces(join(file, "missing.json"))).toEqual({});
    writeFileSync(file, "not json");
    expect(loadUntitledWorkspaces(file)).toEqual({});
  });
});
