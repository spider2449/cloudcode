import { describe, it, expect } from "vitest";
import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { useGitStatus, type GitExec } from "../src/ui/useGitStatus.js";

function Probe({ exec, refreshKey = 0 }: { exec: GitExec; refreshKey?: number }) {
  const git = useGitStatus("/repo", refreshKey, exec);
  return <Text>{`branch=${git.branch ?? "none"} dirty=${git.dirty}`}</Text>;
}

const tick = () => new Promise(r => setTimeout(r, 0));

describe("useGitStatus", () => {
  it("reports branch and dirty state", async () => {
    const exec: GitExec = async (args) =>
      args[0] === "rev-parse" ? "master\n" : " M src/file.ts\n";
    const { lastFrame } = render(<Probe exec={exec} />);
    await tick();
    expect(lastFrame()).toContain("branch=master dirty=true");
  });

  it("reports clean tree", async () => {
    const exec: GitExec = async (args) =>
      args[0] === "rev-parse" ? "dev\n" : "";
    const { lastFrame } = render(<Probe exec={exec} />);
    await tick();
    expect(lastFrame()).toContain("branch=dev dirty=false");
  });

  it("hides branch on git failure", async () => {
    const exec: GitExec = async () => { throw new Error("not a repo"); };
    const { lastFrame } = render(<Probe exec={exec} />);
    await tick();
    expect(lastFrame()).toContain("branch=none dirty=false");
  });

  it("refreshes when refreshKey changes", async () => {
    let branch = "one";
    const exec: GitExec = async (args) =>
      args[0] === "rev-parse" ? `${branch}\n` : "";
    const { lastFrame, rerender } = render(<Probe exec={exec} refreshKey={0} />);
    await tick();
    branch = "two";
    rerender(<Probe exec={exec} refreshKey={1} />);
    await tick();
    expect(lastFrame()).toContain("branch=two");
  });
});
