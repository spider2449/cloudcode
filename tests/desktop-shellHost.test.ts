import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionIndex } from "../src/agent/sessionIndex.js";
import { DesktopShellHost, parseDesktopGitStatus } from "../src/desktop/shellHost.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("DesktopShellHost", () => {
  it("parses branch and file states", () => {
    expect(parseDesktopGitStatus("## main...origin/main\nM  src/a.ts\n M src/b.ts\n?? src/c.ts\n")).toEqual({
      isGitRepo: true,
      branch: "main",
      files: [
        { index: "M", workingTree: " ", path: "src/a.ts" },
        { index: " ", workingTree: "M", path: "src/b.ts" },
        { index: "?", workingTree: "?", path: "src/c.ts" }
      ]
    });
  });

  it("lists sessions by their first message without starting an agent session", () => {
    const root = mkdtempSync(join(tmpdir(), "cloudcode-shell-"));
    roots.push(root);
    const project = join(root, "project");
    mkdirSync(project);
    const index = new SessionIndex(join(root, "sessions.json"));
    index.record({ id: "s1", cwd: project, firstMessage: "Fix the sidebar", timestamp: "2026-09-01T00:00:00Z", provider: "local" });
    const host = new DesktopShellHost({ sessionIndex: index, recentProjects: { load: () => [], save: () => {} } });

    expect(host.openProject(project).sessions).toEqual([
      expect.objectContaining({ id: "s1", firstMessage: "Fix the sidebar" })
    ]);
  });

  it("keeps Git status scoped to the selected workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "cloudcode-shell-"));
    roots.push(root);
    const project = join(root, "project");
    mkdirSync(project);
    let observedCwd = "";
    const host = new DesktopShellHost({
      recentProjects: { load: () => [], save: () => {} },
      gitRunner: async (_args, cwd) => {
        observedCwd = cwd;
        return { code: 0, stdout: "## main\n M src/a.ts\n", stderr: "", truncated: false };
      }
    });
    const workspace = host.openProject(project);

    expect((await host.gitState(workspace.id)).files[0]?.path).toBe("src/a.ts");
    expect(observedCwd.toLowerCase()).toBe(project.toLowerCase());
  });

  it("rejects a session from another workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "cloudcode-shell-"));
    roots.push(root);
    const left = join(root, "left");
    const right = join(root, "right");
    mkdirSync(left);
    mkdirSync(right);
    const index = new SessionIndex(join(root, "sessions.json"));
    index.record({ id: "right-session", cwd: right, firstMessage: "Right", timestamp: "2026-09-01T00:00:00Z", provider: "local" });
    const host = new DesktopShellHost({ sessionIndex: index, recentProjects: { load: () => [], save: () => {} } });
    const workspace = host.openProject(left);

    expect(() => host.assertSession(workspace.id, "right-session")).toThrow("does not belong");
  });
});
