import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspaceIds, removeWorkspaceId, saveWorkspaceId } from "../src/desktop/workspaceIds.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tempFile(): string {
  const root = mkdtempSync(join(tmpdir(), "cc-wsid-"));
  roots.push(root);
  return join(root, "ids.json");
}

describe("workspace ids", () => {
  it("round-trips cwd to id mappings", () => {
    const file = tempFile();
    expect(loadWorkspaceIds(file)).toEqual({});
    saveWorkspaceId("D:/work/proj", "id-1", file);
    expect(loadWorkspaceIds(file)).toEqual({ "D:/work/proj": "id-1" });
  });

  it("returns empty for missing or malformed files", () => {
    const file = tempFile();
    expect(loadWorkspaceIds(join(file, "missing.json"))).toEqual({});
    writeFileSync(file, "not json");
    expect(loadWorkspaceIds(file)).toEqual({});
  });

  it("removes mappings and ignores unknown keys", () => {
    const file = tempFile();
    saveWorkspaceId("D:/work/proj", "id-1", file);
    expect(() => removeWorkspaceId("D:/missing", file)).not.toThrow();
    removeWorkspaceId("D:/work/proj", file);
    expect(loadWorkspaceIds(file)).toEqual({});
  });
});
