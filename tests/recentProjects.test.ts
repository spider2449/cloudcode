import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRecentProjects, saveRecentProject } from "../src/agent/recentProjects.js";

const dirs: string[] = [];

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("recentProjects", () => {
  it("moves a reopened project to the front without duplicates", () => {
    const dir = mkdtempSync(join(tmpdir(), "cloudcode-recent-"));
    dirs.push(dir);
    const file = join(dir, "recent.json");

    saveRecentProject("C:/one", file);
    saveRecentProject("C:/two", file);
    saveRecentProject("C:/one", file);

    expect(loadRecentProjects(file)).toEqual(["C:/one", "C:/two"]);
  });
});
