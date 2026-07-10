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
