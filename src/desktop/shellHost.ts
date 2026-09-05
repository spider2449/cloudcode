import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionIndex } from "../agent/sessionIndex.js";
import { loadRecentProjects, saveRecentProject } from "../agent/recentProjects.js";
import type { GitRunner } from "../agent/gitReview.js";
import { DesktopGitService, type DesktopGitState } from "./gitService.js";
export { parseDesktopGitStatus } from "./gitService.js";

export interface DesktopSessionEntry {
  id: string;
  firstMessage: string;
  timestamp: string;
  provider: string;
}

export interface DesktopShellWorkspace {
  id: string;
  name: string;
  sessions: DesktopSessionEntry[];
}

export interface DesktopShellHostOptions {
  sessionIndex?: SessionIndex;
  recentProjects?: { load(): string[]; save(path: string): void };
  gitRunner?: GitRunner;
}

/** Read-only desktop navigation authority used around the embedded TUI. */
export class DesktopShellHost {
  private readonly sessionIndex: SessionIndex;
  private readonly roots = new Map<string, string>();
  private readonly git: DesktopGitService;

  constructor(private readonly options: DesktopShellHostOptions = {}) {
    this.sessionIndex = options.sessionIndex ?? new SessionIndex();
    this.git = new DesktopGitService(options.gitRunner);
  }

  openProject(selectedPath: string): DesktopShellWorkspace {
    const cwd = canonicalProjectRoot(selectedPath);
    const existing = [...this.roots.entries()].find(([, root]) => root === cwd);
    const id = existing?.[0] ?? randomUUID();
    this.roots.set(id, cwd);
    (this.options.recentProjects ?? { load: loadRecentProjects, save: saveRecentProject }).save(cwd);
    return this.describe(id);
  }

  restoreProjects(): DesktopShellWorkspace[] {
    const recent = (this.options.recentProjects ?? { load: loadRecentProjects, save: saveRecentProject }).load();
    const restored: DesktopShellWorkspace[] = [];
    for (const path of recent) {
      try { restored.push(this.openProject(path)); } catch { /* stale entries are ignored */ }
    }
    return restored;
  }

  refresh(workspaceId: string): DesktopShellWorkspace {
    return this.describe(workspaceId);
  }

  cwd(workspaceId: string): string {
    const cwd = this.roots.get(workspaceId);
    if (!cwd) throw new Error("Unknown workspace.");
    return cwd;
  }

  assertSession(workspaceId: string, sessionId: string): void {
    const sessions = this.describe(workspaceId).sessions;
    if (!sessions.some(session => session.id === sessionId)) {
      throw new Error("Session does not belong to this workspace.");
    }
  }

  async gitState(workspaceId: string): Promise<DesktopGitState> {
    return this.git.status(this.cwd(workspaceId));
  }

  gitService(): DesktopGitService { return this.git; }

  private describe(id: string): DesktopShellWorkspace {
    const cwd = this.cwd(id);
    const sessions = this.sessionIndex.list().filter(entry => sameProjectPath(entry.cwd, cwd)).map(entry => ({
      id: entry.id,
      firstMessage: entry.firstMessage,
      timestamp: entry.timestamp,
      provider: entry.provider
    }));
    return { id, name: cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd, sessions };
  }
}

function sameProjectPath(left: string, right: string): boolean {
  const normalizedLeft = left.replaceAll("\\", "/");
  const normalizedRight = right.replaceAll("\\", "/");
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function canonicalProjectRoot(path: string): string {
  let root: string;
  try { root = realpathSync.native(resolve(path)); }
  catch { throw new Error("The selected project directory is unavailable."); }
  return process.platform === "win32" ? root.toLowerCase() : root;
}
