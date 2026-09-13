export interface SessionRef { id: string; firstMessage: string; timestamp: string; provider: string; repoId: string }
export interface RepoSessionGroup { repoId: string; repoName: string; repoPath: string | undefined; sessions: SessionRef[] }

// Group sessions under their repo, preserving repo order. Repos with no
// sessions still produce an (empty) group so the sidebar shows every repo.
export function groupSessionsByRepo(repos: { id: string; name: string; cwd?: string }[], sessions: SessionRef[]): RepoSessionGroup[] {
  const byRepo = new Map<string, SessionRef[]>();
  for (const session of sessions) {
    const list = byRepo.get(session.repoId) ?? [];
    list.push(session);
    byRepo.set(session.repoId, list);
  }
  return repos.map(repo => ({ repoId: repo.id, repoName: repo.name, repoPath: repo.cwd, sessions: byRepo.get(repo.id) ?? [] }));
}

export function dirtyRepoCount(states: Record<string, { files: { length: number } } | undefined>): number {
  return Object.values(states).filter(state => (state?.files.length ?? 0) > 0).length;
}

export function statusGitLabel(branch: string | undefined, dirtyCount: number, repoCount: number): string {
  if (repoCount > 1 && dirtyCount > 0) return `${dirtyCount} repos dirty`;
  return `${branch ?? "Repository"} · ${dirtyCount > 0 ? "dirty" : "clean"}`;
}
