import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionIndex } from "../agent/sessionIndex.js";
import { SessionFile } from "../engine/sessions.js";
import { loadWorkspaceIds, removeWorkspaceId, saveWorkspaceId } from "./workspaceIds.js";
import { loadUntitledWorkspaces, removeUntitledWorkspace, saveUntitledWorkspace } from "./untitledWorkspaces.js";
import { loadRecentProjects, removeRecentProject, saveRecentProject } from "../agent/recentProjects.js";
import type { GitRunner } from "../agent/gitReview.js";
import { DesktopGitService, type DesktopGitState } from "./gitService.js";
import { parseCodeWorkspaceFile } from "./codeWorkspace.js";
export { parseDesktopGitStatus } from "./gitService.js";

export interface DesktopSessionEntry {
  id: string;
  firstMessage: string;
  timestamp: string;
  provider: string;
}

export interface DesktopRepoEntry {
  id: string;
  name: string;
  cwd: string;
  missing?: boolean;
}

export interface DesktopShellWorkspace {
  id: string;
  name: string;
  kind: "single" | "multi";
  root: string;
  repos: DesktopRepoEntry[];
  sessions: (DesktopSessionEntry & { repoId: string })[];
  // False for multi-repo workspaces with no backing .code-workspace file
  // (built via attachRepo): the renderer shows a save prompt for those.
  saved: boolean;
}

interface WorkspaceRecord {
  name: string;
  kind: "single" | "multi";
  root: string;
  repos: DesktopRepoEntry[];
  // Canonical .code-workspace file path for multi workspaces, so two files in
  // the same directory stay separate workspaces.
  filePath?: string;
  // False while the record has no backing file (see DesktopShellWorkspace).
  saved: boolean;
}

export interface DesktopShellHostOptions {
  sessionIndex?: SessionIndex;
  recentProjects?: { load(): string[]; save(path: string): void; remove?(path: string): void };
  gitRunner?: GitRunner;
  // Overrides the transcript directory for SessionFile.delete (tests only).
  sessionDir?: string;
  // Overrides the workspace-id map file (tests only).
  workspaceIdsFile?: string;
  // Overrides .code-workspace file reads (tests only).
  readWorkspaceFile?: (path: string) => string;
  // Overrides .code-workspace file writes (tests only).
  writeWorkspaceFile?: (path: string, text: string) => void;
  // Overrides the untitled-workspace store file (tests only).
  untitledWorkspacesFile?: string;
}

/** Read-only desktop navigation authority used around the embedded TUI. */
export class DesktopShellHost {
  private readonly sessionIndex: SessionIndex;
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly git: DesktopGitService;

  constructor(private readonly options: DesktopShellHostOptions = {}) {
    this.sessionIndex = options.sessionIndex ?? new SessionIndex();
    this.git = new DesktopGitService(options.gitRunner);
  }

  openProject(selectedPath: string): DesktopShellWorkspace {
    if (selectedPath.toLowerCase().endsWith(".code-workspace")) return this.openWorkspaceFile(selectedPath);
    const cwd = canonicalProjectRoot(selectedPath);
    const existing = [...this.workspaces.entries()].find(([, record]) => record.kind === "single" && record.root === cwd);
    // Workspace ids must survive app restarts: the renderer remembers its
    // selection by id, so reuse the persisted id for a known directory and
    // only mint (and persist) a new one for a directory seen the first time.
    const persisted = existing ? undefined : loadWorkspaceIds(this.options.workspaceIdsFile)[cwd];
    // A stale mapping may point at a workspace id that now belongs to a
    // multi (its single directory was absorbed via attachRepo): reopening the
    // directory must mint a fresh single instead of colliding with that id.
    const persistedRecord = persisted ? this.workspaces.get(persisted) : undefined;
    const id = existing?.[0] ?? (persistedRecord && persistedRecord.kind !== "single" ? randomUUID() : (persisted ?? randomUUID()));
    if (!existing) {
      const name = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
      this.workspaces.set(id, { name, kind: "single", root: cwd, repos: [{ id: "repo-0", name, cwd }], saved: true });
      if (!persisted) saveWorkspaceId(cwd, id, this.options.workspaceIdsFile);
    }
    this.recentStore().save(cwd);
    return this.describe(id);
  }

  private openWorkspaceFile(selectedPath: string): DesktopShellWorkspace {
    let file: string;
    try { file = realpathSync.native(resolve(selectedPath)); }
    catch { throw new Error("The selected workspace file is unavailable."); }
    if (process.platform === "win32") file = file.toLowerCase();
    const existing = [...this.workspaces.entries()].find(([, record]) => record.filePath === file);
    const persisted = existing ? undefined : loadWorkspaceIds(this.options.workspaceIdsFile)[file];
    const id = existing?.[0] ?? persisted ?? randomUUID();
    if (!existing) {
      let text: string;
      try { text = this.options.readWorkspaceFile ? this.options.readWorkspaceFile(file) : readFileSync(file, "utf8"); }
      catch { throw new Error("Invalid workspace file."); }
      const repos = parseCodeWorkspaceFile(file, text).map(repo => ({
        id: repo.id,
        name: repo.name,
        cwd: repo.cwd,
        ...(repo.missing ? { missing: true as const } : {})
      }));
      const name = basename(file, ".code-workspace") || file;
      this.workspaces.set(id, { name, kind: "multi", root: dirname(file), repos, filePath: file, saved: true });
      if (!persisted) saveWorkspaceId(file, id, this.options.workspaceIdsFile);
    }
    this.recentStore().save(file);
    return this.describe(id);
  }

  // Attach a directory to an existing workspace (VS Code "Add Folder to
  // Workspace"). A single workspace converts to an unsaved multi in place,
  // keeping its id so the renderer's selection never churns. Already-attached
  // directories are a no-op returning the refreshed workspace.
  attachRepo(workspaceId: string, dirPath: string): DesktopShellWorkspace {
    const record = this.workspaces.get(workspaceId);
    if (!record) throw new Error("Unknown workspace.");
    const cwd = canonicalProjectRoot(dirPath);
    if (record.repos.some(repo => sameProjectPath(repo.cwd, cwd))) return this.describe(workspaceId);
    const name = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
    record.repos.push({ id: `repo-${record.repos.length}`, name, cwd });
    if (record.kind === "single") {
      record.kind = "multi";
      // The absorbed single must not resurrect as a duplicate on restore.
      removeWorkspaceId(record.root, this.options.workspaceIdsFile);
      this.recentStore().remove?.(record.root);
    }
    record.saved = false;
    saveUntitledWorkspace(workspaceId, record.repos.map(repo => repo.cwd), this.options.untitledWorkspacesFile);
    return this.describe(workspaceId);
  }

  // Persist a workspace as a .code-workspace file (VS Code "Save Workspace
  // As"). Folder paths are stored relative to the file when possible so the
  // file stays portable; the workspace keeps its id and becomes saved.
  saveWorkspaceAs(workspaceId: string, filePath: string): DesktopShellWorkspace {
    const record = this.workspaces.get(workspaceId);
    if (!record) throw new Error("Unknown workspace.");
    let file = resolve(filePath);
    if (process.platform === "win32") file = file.toLowerCase();
    const dir = dirname(file);
    const folders = record.repos.map(repo => {
      const rel = relative(dir, repo.cwd);
      const folder: { path: string; name?: string } = {
        path: rel === "" ? "." : (rel.startsWith("..") || isAbsolute(rel) ? repo.cwd : rel)
      };
      if (repo.name !== basename(repo.cwd)) folder.name = repo.name;
      return folder;
    });
    const text = JSON.stringify({ folders, settings: {} }, null, 2);
    if (this.options.writeWorkspaceFile) this.options.writeWorkspaceFile(file, text);
    else {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, text);
    }
    record.filePath = file;
    record.saved = true;
    removeUntitledWorkspace(workspaceId, this.options.untitledWorkspacesFile);
    saveWorkspaceId(file, workspaceId, this.options.workspaceIdsFile);
    this.recentStore().save(file);
    return this.describe(workspaceId);
  }

  private recentStore(): { load(): string[]; save(path: string): void; remove?(path: string): void } {
    return this.options.recentProjects ?? { load: loadRecentProjects, save: saveRecentProject, remove: removeRecentProject };
  }

  restoreProjects(): DesktopShellWorkspace[] {
    const restored: DesktopShellWorkspace[] = [];
    // Unsaved multis first: their ids are stable, and replaying them before
    // recent paths keeps stale single-directory mappings from colliding.
    for (const [id, dirs] of Object.entries(loadUntitledWorkspaces(this.options.untitledWorkspacesFile))) {
      if (this.workspaces.has(id)) continue;
      try { restored.push(this.restoreUntitled(id, dirs)); } catch { /* stale entries are ignored */ }
    }
    for (const path of this.recentStore().load()) {
      try { restored.push(this.openProject(path)); } catch { /* stale entries are ignored */ }
    }
    return restored;
  }

  // Rebuild an unsaved multi-repo workspace from its persisted member
  // directories, reusing its id so the renderer's selection survives restarts.
  // Missing directories are skipped; with none left it throws (ignored above).
  private restoreUntitled(id: string, dirs: string[]): DesktopShellWorkspace {
    const repos: DesktopRepoEntry[] = [];
    for (const dir of dirs) {
      let cwd: string;
      try { cwd = canonicalProjectRoot(dir); }
      catch { continue; }
      if (repos.some(repo => sameProjectPath(repo.cwd, cwd))) continue;
      const name = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
      repos.push({ id: `repo-${repos.length}`, name, cwd });
    }
    if (repos.length === 0) throw new Error("The saved workspace has no available directories.");
    const name = repos[0].name;
    this.workspaces.set(id, { name, kind: "multi", root: repos[0].cwd, repos, saved: false });
    return this.describe(id);
  }

  refresh(workspaceId: string): DesktopShellWorkspace {
    return this.describe(workspaceId);
  }

  cwd(workspaceId: string): string {
    // Single workspaces hold their directory as the sole repo. Multi
    // workspaces resolve to the first repo so legacy single-cwd callers keep
    // working; per-repo callers must use repoCwd instead.
    const record = this.workspaces.get(workspaceId);
    const cwd = record?.repos[0]?.cwd;
    if (!cwd) throw new Error("Unknown workspace.");
    return cwd;
  }

  reposOf(workspaceId: string): DesktopRepoEntry[] {
    const record = this.workspaces.get(workspaceId);
    if (!record) throw new Error("Unknown workspace.");
    return record.repos;
  }

  repoCwd(workspaceId: string, repoId: string): string {
    const repo = this.reposOf(workspaceId).find(entry => entry.id === repoId);
    if (!repo) throw new Error("Unknown repo.");
    return repo.cwd;
  }

  assertSession(workspaceId: string, sessionId: string): void {
    const sessions = this.describe(workspaceId).sessions;
    if (!sessions.some(session => session.id === sessionId)) {
      throw new Error("Session does not belong to this workspace.");
    }
  }

  renameSession(workspaceId: string, sessionId: string, title: string): DesktopShellWorkspace {
    this.assertSession(workspaceId, sessionId);
    this.sessionIndex.rename(sessionId, title);
    return this.describe(workspaceId);
  }

  removeSession(workspaceId: string, sessionId: string): DesktopShellWorkspace {
    this.assertSession(workspaceId, sessionId);
    this.sessionIndex.remove(sessionId);
    SessionFile.delete(sessionId, this.options.sessionDir);
    return this.describe(workspaceId);
  }

  async gitState(workspaceId: string): Promise<DesktopGitState> {
    return this.git.status(this.cwd(workspaceId));
  }

  async gitStates(workspaceId: string): Promise<Record<string, DesktopGitState>> {
    const states: Record<string, DesktopGitState> = {};
    for (const repo of this.reposOf(workspaceId)) {
      try {
        states[repo.id] = await this.git.status(repo.cwd);
      } catch (error) {
        states[repo.id] = { isGitRepo: false, ahead: 0, behind: 0, files: [], truncated: false, recent: [], error: error instanceof Error ? error.message : String(error) };
      }
    }
    return states;
  }

  async gitPush(workspaceId: string, setUpstreamBranch?: string): Promise<void> {
    await this.git.push(this.cwd(workspaceId), setUpstreamBranch);
  }

  async gitPull(workspaceId: string): Promise<void> {
    await this.git.pull(this.cwd(workspaceId));
  }

  async gitFetch(workspaceId: string): Promise<void> {
    await this.git.fetch(this.cwd(workspaceId));
  }

  gitService(): DesktopGitService { return this.git; }

  private describe(id: string): DesktopShellWorkspace {
    const record = this.workspaces.get(id);
    if (!record) throw new Error("Unknown workspace.");
    const sessions: (DesktopSessionEntry & { repoId: string })[] = [];
    for (const entry of this.sessionIndex.list()) {
      const repo = record.repos.find(candidate => sameProjectPath(entry.cwd, candidate.cwd));
      if (!repo) continue;
      sessions.push({ id: entry.id, firstMessage: entry.firstMessage, timestamp: entry.timestamp, provider: entry.provider, repoId: repo.id });
    }
    return { id, name: record.name, kind: record.kind, root: record.root, repos: record.repos, sessions, saved: record.saved };
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
