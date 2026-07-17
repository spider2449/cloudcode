import { execFile } from "node:child_process";

export type GitExec = (args: string[], cwd: string) => Promise<string>;

export interface GitStatus {
  branch?: string;
  dirty: boolean;
}

const defaultExec: GitExec = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

const POLL_MS = 5000;

export class GitStatusPoller {
  private current: GitStatus = { dirty: false };
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private cwd: string, private exec: GitExec = defaultExec) {}

  get status(): GitStatus {
    return this.current;
  }

  async refresh(): Promise<void> {
    try {
      const branch = (await this.exec(["rev-parse", "--abbrev-ref", "HEAD"], this.cwd)).trim();
      const porcelain = await this.exec(["status", "--porcelain", "-uno"], this.cwd);
      this.current = { branch: branch || undefined, dirty: porcelain.trim().length > 0 };
    } catch {
      this.current = { dirty: false };
    }
  }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, POLL_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }
}
