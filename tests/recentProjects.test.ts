import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRecentProjects, removeRecentProject, saveRecentProject } from "../src/agent/recentProjects.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tempFile(): string {
  const root = mkdtempSync(join(tmpdir(), "cc-recent-"));
  roots.push(root);
  return join(root, "recent.json");
}

describe("recent projects", () => {
  it("removes entries and ignores unknown paths", () => {
    const file = tempFile();
    saveRecentProject("D:/work/api", file);
    saveRecentProject("D:/work/web", file);
    expect(() => removeRecentProject("D:/missing", file)).not.toThrow();
    removeRecentProject("D:/work/web", file);
    expect(loadRecentProjects(file)).toEqual(["D:/work/api"]);
  });
});
