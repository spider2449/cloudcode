import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionIndex } from "../src/agent/sessionIndex.js";
import { SessionFile } from "../src/engine/sessions.js";
import { DesktopShellHost, parseDesktopGitStatus } from "../src/desktop/shellHost.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("DesktopShellHost", () => {
  it("parses branch and file states", () => {
    expect(parseDesktopGitStatus("## main...origin/main\0M  src/a.ts\0 M src/b.ts\0?? src/c.ts\0")).toEqual({
      isGitRepo: true,
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      truncated: false,
      recent: [],
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
        return { code: 0, stdout: "## main\0 M src/a.ts\0", stderr: "", truncated: false };
      }
    });
    const workspace = host.openProject(project);

    expect((await host.gitState(workspace.id)).files[0]?.path).toBe("src/a.ts");
    expect(observedCwd.toLowerCase()).toBe(project.toLowerCase());
  });

  it("delegates push pull fetch scoped to the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "cloudcode-shell-"));
    roots.push(root);
    const project = join(root, "project");
    mkdirSync(project);
    const seen: string[][] = [];
    const host = new DesktopShellHost({
      recentProjects: { load: () => [], save: () => {} },
      gitRunner: async (args) => {
        seen.push(args);
        if (args[0] === "log") return { code: 0, stdout: "", stderr: "", truncated: false };
        return { code: 0, stdout: "## main\0", stderr: "", truncated: false };
      }
    });
    const workspace = host.openProject(project);
    await host.gitPush(workspace.id);
    await host.gitFetch(workspace.id);
    expect(seen).toContainEqual(["push"]);
    expect(seen).toContainEqual(["fetch", "--prune"]);
  });

  it("sees sessions recorded by another process after construction", () => {
    const root = mkdtempSync(join(tmpdir(), "cloudcode-shell-"));
    roots.push(root);
    const project = join(root, "project");
    mkdirSync(project);
    const file = join(root, "sessions.json");
    const host = new DesktopShellHost({
      sessionIndex: new SessionIndex(file),
      recentProjects: { load: () => [], save: () => {} }
    });
    const before = host.openProject(project);
    expect(before.sessions).toHaveLength(0);

    new SessionIndex(file).record({
      id: "latest", cwd: project, firstMessage: "Latest work",
      timestamp: "2026-09-02T00:00:00Z", provider: "local"
    });

    expect(host.refresh(before.id).sessions.map(session => session.id)).toEqual(["latest"]);
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

  it("keeps the same workspace id for a project across host restarts", () => {
    const root = mkdtempSync(join(tmpdir(), "cloudcode-shell-"));
    roots.push(root);
    const project = join(root, "project");
    mkdirSync(project);
    const idsFile = join(root, "ids.json");
    const stubProjects = { load: () => [], save: () => {} };

    const first = new DesktopShellHost({ sessionIndex: new SessionIndex(join(root, "sessions.json")), recentProjects: stubProjects, workspaceIdsFile: idsFile });
    const before = first.openProject(project).id;
    // A fresh host (new app process) reopening the same directory must reuse the id.
    const second = new DesktopShellHost({ sessionIndex: new SessionIndex(join(root, "sessions.json")), recentProjects: stubProjects, workspaceIdsFile: idsFile });
    expect(second.openProject(project).id).toBe(before);
  });

  it("renames a session title within its workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "cloudcode-shell-"));
    roots.push(root);
    const project = join(root, "project");
    mkdirSync(project);
    const index = new SessionIndex(join(root, "sessions.json"));
    index.record({ id: "s1", cwd: project, firstMessage: "Old", timestamp: "2026-09-01T00:00:00Z", provider: "local" });
    const host = new DesktopShellHost({ sessionIndex: index, recentProjects: { load: () => [], save: () => {} } });
    const workspace = host.openProject(project);

    const updated = host.renameSession(workspace.id, "s1", "  New title  ");
    expect(updated.sessions).toEqual([expect.objectContaining({ id: "s1", firstMessage: "New title" })]);
  });

  it("rejects renaming a session from another workspace", () => {
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

    expect(() => host.renameSession(workspace.id, "right-session", "x")).toThrow("does not belong");
  });

  it("removes the index entry and the transcript file", () => {
    const root = mkdtempSync(join(tmpdir(), "cloudcode-shell-"));
    roots.push(root);
    const project = join(root, "project");
    mkdirSync(project);
    const sessionDir = join(root, "transcripts");
    mkdirSync(sessionDir);
    const index = new SessionIndex(join(root, "sessions.json"));
    index.record({ id: "s1", cwd: project, firstMessage: "Gone", timestamp: "2026-09-01T00:00:00Z", provider: "local" });
    new SessionFile("s1", sessionDir).append({ role: "user", content: "hi" });
    const host = new DesktopShellHost({ sessionIndex: index, sessionDir, recentProjects: { load: () => [], save: () => {} } });
    const workspace = host.openProject(project);

    const updated = host.removeSession(workspace.id, "s1");
    expect(updated.sessions).toEqual([]);
    expect(SessionFile.load("s1", sessionDir)).toEqual([]);
    expect(index.list()).toEqual([]);
  });
});

describe("DesktopShellHost multi-repo workspaces", () => {
  it("opens a .code-workspace file and attributes sessions per repo", () => {
    const root = mkdtempSync(join(tmpdir(), "cloudcode-ws-"));
    roots.push(root);
    mkdirSync(join(root, "api"));
    mkdirSync(join(root, "web"));
    writeFileSync(join(root, "shop.code-workspace"), JSON.stringify({ folders: [{ path: "api" }, { path: "web" }] }));
    // The host canonicalizes roots (lowercase on win32), so record the session
    // cwd with the same rule or attribution will miss on Windows.
    const apiCwd = process.platform === "win32" ? join(root, "api").toLowerCase() : join(root, "api");
    const index = new SessionIndex(join(root, "sessions.json"));
    index.record({ id: "s1", cwd: apiCwd, firstMessage: "api work", timestamp: "2026-09-01T00:00:00Z", provider: "local" });
    const host = new DesktopShellHost({ sessionIndex: index, recentProjects: { load: () => [], save: () => {} } });

    const workspace = host.openProject(join(root, "shop.code-workspace"));
    expect(workspace.kind).toBe("multi");
    expect(workspace.repos.map(r => r.name).sort()).toEqual(["api", "web"]);
    expect(workspace.sessions).toEqual([expect.objectContaining({ id: "s1", repoId: workspace.repos[0].id })]);
  });

  it("isolates per-repo git failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "cloudcode-ws-"));
    roots.push(root);
    mkdirSync(join(root, "api"));
    writeFileSync(join(root, "shop.code-workspace"), JSON.stringify({ folders: [{ path: "api" }, { path: "gone" }] }));
    const host = new DesktopShellHost({
      recentProjects: { load: () => [], save: () => {} },
      gitRunner: async (_args, cwd) => {
        if (cwd.endsWith("gone")) return { code: 128, stdout: "", stderr: "nope", truncated: false };
        if (_args[0] === "log") return { code: 0, stdout: "", stderr: "", truncated: false };
        return { code: 0, stdout: "## main\0", stderr: "", truncated: false };
      }
    });
    const workspace = host.openProject(join(root, "shop.code-workspace"));
    const states = await host.gitStates(workspace.id);
    expect(Object.keys(states)).toHaveLength(2);
    expect(states[workspace.repos[0].id].isGitRepo).toBe(true);
    expect(states[workspace.repos[1].id].isGitRepo).toBe(false);
  });
});
