import { describe, it, expect, vi } from "vitest";
import { GitStatusPoller, type GitExec } from "../src/ui/useGitStatus.js";

function fakeExec(branch: string, dirty: boolean): GitExec {
  return async (args: string[]) => {
    if (args[0] === "rev-parse") return branch;
    return dirty ? " M file.ts\n" : "";
  };
}

describe("GitStatusPoller", () => {
  it("starts with dirty:false and no branch before the first refresh", () => {
    const poller = new GitStatusPoller("/repo", fakeExec("main", false));
    expect(poller.status).toEqual({ dirty: false });
  });

  it("refresh() populates branch and dirty from the exec results", async () => {
    const poller = new GitStatusPoller("/repo", fakeExec("main", true));
    await poller.refresh();
    expect(poller.status).toEqual({ branch: "main", dirty: true });
  });

  it("refresh() on exec failure resets to dirty:false, branch undefined", async () => {
    const failing: GitExec = async () => { throw new Error("not a git repo"); };
    const poller = new GitStatusPoller("/repo", failing);
    await poller.refresh();
    expect(poller.status).toEqual({ dirty: false });
  });

  it("stop() clears the interval so no further polling occurs after the initial refresh", () => {
    vi.useFakeTimers();
    const exec = vi.fn(fakeExec("main", false));
    const poller = new GitStatusPoller("/repo", exec);
    poller.start();
    const callsAfterStart = exec.mock.calls.length;
    poller.stop();
    vi.advanceTimersByTime(20_000);
    expect(exec.mock.calls.length).toBe(callsAfterStart);
    vi.useRealTimers();
  });
});
