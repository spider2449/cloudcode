import { useEffect, useState } from "react";
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

// Kept for the legacy Ink UI (src/ui/App.tsx), which still consumes this
// hook. The hand-rolled UI uses GitStatusPoller below instead, since App.ts
// has no hook lifecycle to hang a useEffect off of.
export function useGitStatus(cwd: string, refreshKey: number, exec: GitExec = defaultExec): GitStatus {
  const [status, setStatus] = useState<GitStatus>({ dirty: false });

  useEffect(() => {
    let cancelled = false;
    async function refresh(): Promise<void> {
      try {
        const branch = (await exec(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
        const porcelain = await exec(["status", "--porcelain", "-uno"], cwd);
        if (!cancelled) setStatus({ branch: branch || undefined, dirty: porcelain.trim().length > 0 });
      } catch {
        if (!cancelled) setStatus({ dirty: false });
      }
    }
    void refresh();
    const timer = setInterval(() => { void refresh(); }, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, refreshKey]);

  return status;
}

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
