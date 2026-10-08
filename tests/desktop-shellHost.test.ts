import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as providers from "../src/agent/providers.js";
import { SessionIndex } from "../src/agent/sessionIndex.js";
import { SessionFile } from "../src/engine/sessions.js";
import { DesktopShellHost, parseDesktopGitStatus } from "../src/desktop/shellHost.js";
import { loadUntitledWorkspaces } from "../src/desktop/untitledWorkspaces.js";

const roots: string[] = [];
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "cloudcode-shell-config-"));
  roots.push(root);
  vi.spyOn(providers, "configDir").mockReturnValue(root);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("DesktopShellHost", () => {
  it("forgets a missing project across restarts without deleting session records", () => {
    const root = mkdtempSync(join(tmpdir(), "cloudcode-forget-"));
    roots.push(root);
    const project = join(root, "missing");
    let recent = [project];
    const index = new SessionIndex(join(root, "sessions.json"));
    index.record({ id: "retained", cwd: project, firstMessage: "Keep", timestamp: "2026-10-08", provider: "local" });
    const options = { sessionIndex: index, workspaceIdsFile: join(root, "ids.json"),
      untitledWorkspacesFile: join(root, "untitled.json"),
      recentProjects: { load: () => recent, save: () => {}, remove: (path: string) => { recent = recent.filter(entry => entry.toLowerCase() !== path.toLowerCase()); } } };
    const host = new DesktopShellHost(options);
    const workspace = host.restoreProjects()[0];
    host.removeWorkspace(workspace.id);
    expect(() => host.refresh(workspace.id)).toThrow("Unknown workspace");
    expect(new DesktopShellHost(options).restoreProjects()).toEqual([]);
    expect(index.list().map(session => session.id)).toEqual(["retained"]);
  });
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

describe("DesktopShellHost attach/save workspace", () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), "cloudcode-attach-"));
    roots.push(root);
    const dirA = join(root, "api");
    const dirB = join(root, "web");
    mkdirSync(dirA);
    mkdirSync(dirB);
    const removedRecent: string[] = [];
    const options = {
      sessionIndex: new SessionIndex(join(root, "sessions.json")),
      recentProjects: { load: () => [] as string[], save: () => {}, remove: (path: string) => { removedRecent.push(path); } },
      workspaceIdsFile: join(root, "ids.json"),
      untitledWorkspacesFile: join(root, "untitled.json") as string | undefined,
      written: {} as Record<string, string>,
    };
    const host = new DesktopShellHost({ ...options, writeWorkspaceFile: (path, text) => { options.written[path] = text; } });
    return { root, dirA, dirB, removedRecent, options, host };
  }

  function canonical(dir: string): string {
    return process.platform === "win32" ? dir.toLowerCase() : dir;
  }

  it("removes an untitled workspace without deleting its member directories", () => {
    const { dirA, dirB, host, options } = setup();
    const single = host.openProject(dirA);
    host.attachRepo(single.id, dirB);
    host.removeWorkspace(single.id);
    expect(loadUntitledWorkspaces(options.untitledWorkspacesFile as string)).toEqual({});
    expect(new DesktopShellHost(options).restoreProjects()).toEqual([]);
    expect(host.openProject(dirA).repos).toHaveLength(1);
    expect(host.openProject(dirB).repos).toHaveLength(1);
  });

  it("converts a single workspace to an unsaved multi in place, keeping its id", () => {
    const { dirA, dirB, removedRecent, host } = setup();
    const single = host.openProject(dirA);
    expect(single.kind).toBe("single");

    const multi = host.attachRepo(single.id, dirB);
    expect(multi.id).toBe(single.id);
    expect(multi.kind).toBe("multi");
    expect(multi.saved).toBe(false);
    expect(multi.repos.map(repo => repo.cwd)).toEqual([canonical(dirA), canonical(dirB)]);
    // The absorbed single must not resurrect as a duplicate on restore.
    expect(removedRecent).toEqual([canonical(dirA)]);
  });

  it("dedupes already-attached directories", () => {
    const { dirA, dirB, host } = setup();
    const single = host.openProject(dirA);
    const multi = host.attachRepo(single.id, dirB);
    expect(host.attachRepo(single.id, dirA).repos).toHaveLength(2);
    expect(multi.repos).toHaveLength(2);
  });

  it("rejects unknown workspace ids", () => {
    const { dirB, host } = setup();
    expect(() => host.attachRepo("missing", dirB)).toThrow("Unknown workspace.");
    expect(() => host.saveWorkspaceAs("missing", join("somewhere", "shop.code-workspace"))).toThrow("Unknown workspace.");
  });

  it("saveWorkspaceAs writes relative folders and marks the workspace saved", () => {
    const { root, dirA, dirB, options, host } = setup();
    const single = host.openProject(dirA);
    const multi = host.attachRepo(single.id, dirB);
    const file = join(root, "shop.code-workspace");

    const saved = host.saveWorkspaceAs(multi.id, file);
    expect(saved.saved).toBe(true);
    expect(JSON.parse(options.written[canonical(file)] as string)).toEqual({
      folders: [{ path: "api" }, { path: "web" }],
      settings: {},
    });
    // The untitled entry is gone: restores now replay the file instead.
    expect(loadUntitledWorkspaces(options.untitledWorkspacesFile as string)).toEqual({});
  });

  it("restoreProjects rebuilds unsaved multis with stable ids", () => {
    const { root, dirA, dirB, host, options } = setup();
    const single = host.openProject(dirA);
    const multi = host.attachRepo(single.id, dirB);

    const revived = new DesktopShellHost({
      sessionIndex: new SessionIndex(join(root, "sessions.json")),
      recentProjects: { load: () => [] as string[], save: () => {} },
      workspaceIdsFile: join(root, "ids.json"),
      untitledWorkspacesFile: options.untitledWorkspacesFile,
    });
    const restored = revived.restoreProjects().find(workspace => workspace.id === multi.id);
    expect(restored?.kind).toBe("multi");
    expect(restored?.saved).toBe(false);
    expect(restored?.repos.map(repo => repo.cwd)).toEqual([canonical(dirA), canonical(dirB)]);
  });

  it("persists untitled members on attach", () => {
    const { dirA, dirB, host, options } = setup();
    const single = host.openProject(dirA);
    host.attachRepo(single.id, dirB);
    expect(loadUntitledWorkspaces(options.untitledWorkspacesFile as string)[single.id]).toEqual([canonical(dirA), canonical(dirB)]);
  });

  it("restores every repo after multiple attachments and a restart", () => {
    const { root, dirA, dirB, host, options } = setup();
    const dirC = join(root, "worker");
    mkdirSync(dirC);
    const single = host.openProject(dirA);
    host.attachRepo(single.id, dirB);
    host.attachRepo(single.id, dirC);
    const revived = new DesktopShellHost(options);
    const restored = revived.restoreProjects().find(workspace => workspace.id === single.id);
    expect(restored?.repos.map(repo => repo.cwd)).toEqual([canonical(dirA), canonical(dirB), canonical(dirC)]);
    expect(restored?.repos.map(repo => repo.id)).toEqual(["repo-0", "repo-1", "repo-2"]);
  });

  it("keeps missing single projects and their sessions on restart", () => {
    const { root, dirA, host, options } = setup();
    const single = host.openProject(dirA);
    options.sessionIndex.record({ id: "old-session", cwd: dirA, firstMessage: "Review", timestamp: "2026-10-08", provider: "local" });
    rmSync(dirA, { recursive: true });
    const revived = new DesktopShellHost({ ...options, recentProjects: { load: () => [dirA], save: () => {} } });
    const restored = revived.restoreProjects()[0];
    expect(restored).toMatchObject({ id: single.id, kind: "single", repos: [{ id: "repo-0", missing: true }] });
    expect(restored.sessions.map(session => session.id)).toEqual(["old-session"]);
    expect(() => revived.cwd(single.id)).toThrow("Project directory unavailable");
    expect(() => host.openProject(join(root, "never-opened"))).toThrow("unavailable");
    mkdirSync(dirA);
    expect(revived.refresh(single.id).repos[0].missing).toBeUndefined();
    expect(revived.cwd(single.id)).toBe(canonical(dirA));
  });

  it("retains missing multi members without shifting repo ids or running Git", async () => {
    const { dirA, dirB, host, options } = setup();
    const single = host.openProject(dirA);
    host.attachRepo(single.id, dirB);
    rmSync(dirA, { recursive: true });
    const gitRunner = vi.fn(async (_args: string[], _cwd: string) => ({ code: 0, stdout: "", stderr: "", truncated: false }));
    const revived = new DesktopShellHost({ ...options, gitRunner });
    const restored = revived.restoreProjects()[0];
    expect(restored.repos).toMatchObject([
      { id: "repo-0", cwd: canonical(dirA), missing: true },
      { id: "repo-1", cwd: canonical(dirB) }
    ]);
    expect(() => revived.repoCwd(single.id, "repo-0")).toThrow("Project directory unavailable");
    expect(revived.repoCwd(single.id, "repo-1")).toBe(canonical(dirB));
    const states = await revived.gitStates(single.id);
    expect(states["repo-0"].error).toContain("Project directory unavailable");
    expect(gitRunner.mock.calls.every(call => call[1] !== canonical(dirA))).toBe(true);
    rmSync(dirB, { recursive: true });
    const allMissing = new DesktopShellHost(options).restoreProjects()[0];
    expect(allMissing.repos).toHaveLength(2);
    expect(allMissing.repos.every(repo => repo.missing)).toBe(true);
  });
});
