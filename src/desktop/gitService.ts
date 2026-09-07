import { defaultGitRunner, type GitRunner } from "../agent/gitReview.js";

export interface DesktopGitFile { path: string; originalPath?: string; index: string; workingTree: string }
export interface DesktopGitCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}
export interface DesktopGitState {
  isGitRepo: boolean;
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  files: DesktopGitFile[];
  truncated: boolean;
  recent: DesktopGitCommit[];
  lastCommit?: DesktopGitCommit;
  lastFetchedAt?: number;
  error?: string;
}

export function parseDesktopGitLog(output: string): DesktopGitCommit[] {
  const commits: DesktopGitCommit[] = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const parts = line.split("\0");
    if (parts.length < 5) continue;
    const [hash, shortHash, author, date, subject] = parts as [string, string, string, string, string];
    if (!hash || !shortHash) continue;
    commits.push({ hash, shortHash, author, date, subject });
  }
  return commits;
}

function splitZero(output: string): string[] {
  const values = output.split("\0");
  if (values.at(-1) === "") values.pop();
  return values;
}

export function parseDesktopGitStatus(output: string, truncated = false): DesktopGitState {
  const records = splitZero(output);
  let branch: string | undefined;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  if (records[0]?.startsWith("## ")) {
    const header = records.shift()?.slice(3) ?? "";
    const normalized = header.startsWith("No commits yet on ") ? header.slice(18) : header;
    const match = /^(.*?)(?:\.\.\.([^ ]+))?(?: \[ahead (\d+)(?:, behind (\d+))?\]| \[behind (\d+)\])?$/.exec(normalized);
    branch = match?.[1]?.trim() || undefined;
    upstream = match?.[2];
    ahead = Number(match?.[3] ?? 0);
    behind = Number(match?.[4] ?? match?.[5] ?? 0);
  }
  const files: DesktopGitFile[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.length < 4) continue;
    const file: DesktopGitFile = { index: record[0] ?? " ", workingTree: record[1] ?? " ", path: record.slice(3) };
    if (file.index === "R" || file.index === "C" || file.workingTree === "R" || file.workingTree === "C") {
      file.originalPath = records[index + 1];
      index += 1;
    }
    files.push(file);
  }
  return { isGitRepo: true, branch, upstream, ahead, behind, files, truncated, recent: [] };
}

export class DesktopGitService {
  private readonly lastFetchedAtByCwd = new Map<string, number>();

  constructor(private readonly runner: GitRunner = defaultGitRunner) {}

  async log(cwd: string, limit = 5): Promise<DesktopGitCommit[]> {
    const count = Number.isInteger(limit) && limit > 0 && limit <= 20 ? limit : 5;
    const result = await this.runner(
      ["log", `-${count}`, "--format=%H%x00%h%x00%an%x00%ad%x00%s", "--date=short"],
      cwd
    );
    if (result.code !== 0) return [];
    return parseDesktopGitLog(result.stdout);
  }

  async status(cwd: string): Promise<DesktopGitState> {
    const result = await this.runner(["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"], cwd);
    if (result.code !== 0) return { isGitRepo: false, ahead: 0, behind: 0, files: [], truncated: result.truncated, recent: [], error: result.stderr.trim() || "Not a Git worktree." };
    const state = parseDesktopGitStatus(result.stdout, result.truncated);
    const recent = await this.log(cwd);
    state.recent = recent;
    state.lastCommit = recent[0];
    const fetchedAt = this.lastFetchedAtByCwd.get(cwd);
    if (fetchedAt !== undefined) state.lastFetchedAt = fetchedAt;
    return state;
  }

  async diff(cwd: string, path: string, staged: boolean): Promise<{ text: string; truncated: boolean; error?: string }> {
    const args = ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-color"];
    if (staged) args.push("--cached");
    args.push("--", path);
    const result = await this.runner(args, cwd);
    return { text: result.stdout, truncated: result.truncated, error: result.code === 0 ? undefined : result.stderr.trim() || "Unable to read diff." };
  }

  async stage(cwd: string, paths: string[]): Promise<void> { await this.requireOk(["--literal-pathspecs", "add", "--", ...paths], cwd); }
  async stageAll(cwd: string): Promise<void> { await this.requireOk(["add", "--all"], cwd); }
  async unstage(cwd: string, paths: string[]): Promise<void> {
    const probe = await this.runner(["rev-parse", "--verify", "HEAD"], cwd);
    await this.requireOk(probe.code === 0 ? ["--literal-pathspecs", "restore", "--staged", "--", ...paths] : ["--literal-pathspecs", "rm", "--cached", "--", ...paths], cwd);
  }
  async unstageAll(cwd: string): Promise<void> {
    const probe = await this.runner(["rev-parse", "--verify", "HEAD"], cwd);
    await this.requireOk(probe.code === 0 ? ["reset", "--mixed", "HEAD"] : ["rm", "-r", "--cached", "."], cwd);
  }
  async commit(cwd: string, message: string): Promise<void> { await this.requireOk(["commit", "-m", message], cwd); }
  async push(cwd: string, setUpstreamBranch?: string): Promise<void> {
    if (setUpstreamBranch) {
      await this.requireOk(["push", "-u", "origin", setUpstreamBranch], cwd);
    } else {
      await this.requireOk(["push"], cwd);
    }
    this.lastFetchedAtByCwd.set(cwd, Date.now());
  }
  async pull(cwd: string): Promise<void> {
    await this.requireOk(["pull", "--ff-only"], cwd);
    this.lastFetchedAtByCwd.set(cwd, Date.now());
  }
  async fetch(cwd: string): Promise<void> {
    await this.requireOk(["fetch", "--prune"], cwd);
    this.lastFetchedAtByCwd.set(cwd, Date.now());
  }
  async branches(cwd: string): Promise<string[]> {
    const result = await this.requireOk(["for-each-ref", "--format=%(refname:short)", "refs/heads"], cwd);
    return result.stdout.split(/\r?\n/).filter(Boolean);
  }
  async checkout(cwd: string, branch: string): Promise<void> { await this.requireOk(["switch", branch], cwd); }
  async createBranch(cwd: string, branch: string): Promise<void> { await this.requireOk(["switch", "-c", branch], cwd); }

  private async requireOk(args: string[], cwd: string) {
    const result = await this.runner(args, cwd);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `Git ${args.find(arg => !arg.startsWith("--")) ?? "operation"} failed.`);
    return result;
  }
}
