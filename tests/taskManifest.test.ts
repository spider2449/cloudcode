import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listTaskManifests, loadTaskManifest, newTaskManifest, saveTaskManifest, transitionTask
} from "../src/agent/taskManifest.js";

const roots: string[] = [];
const root = () => { const value = mkdtempSync(join(tmpdir(), "cc-task-manifest-")); roots.push(value); return value; };
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

function manifest(taskId: string) {
  return newTaskManifest({
    taskId, repositoryId: "repo", sourcePath: "C:/source", commonDir: "C:/source/.git",
    worktreePath: `C:/worktrees/${taskId}`, baseCommit: "abc", branch: `cloudcode/task/${taskId}`,
    planPath: "docs/plans/2026-08-19-task.md", networkMode: "providerOnly"
  }, new Date("2026-08-19T00:00:00Z"));
}

describe("task manifests", () => {
  it("round-trips atomically without storing a task prompt", () => {
    const base = root();
    const value = manifest("task-1");
    saveTaskManifest(value, base);
    expect(loadTaskManifest("task-1", base)).toEqual(value);
    const raw = readFileSync(join(base, "tasks", "task-1", "manifest.json"), "utf8");
    expect(raw).not.toMatch(/prompt|fileContents/i);
  });

  it("enforces explicit state transitions", () => {
    const value = manifest("task-2");
    transitionTask(value, "planning", undefined, new Date("2026-08-19T00:01:00Z"));
    transitionTask(value, "awaitingApproval", "plan written", new Date("2026-08-19T00:02:00Z"));
    expect(value.state).toBe("awaitingApproval");
    expect(value.transitions.at(-1)).toMatchObject({ note: "plan written" });
    expect(() => transitionTask(value, "completed")).toThrow(/Invalid task transition/);
  });

  it("lists valid manifests and leaves corrupt entries untouched", () => {
    const base = root();
    const older = manifest("older");
    const newer = manifest("newer");
    transitionTask(newer, "planning", undefined, new Date("2026-08-19T01:00:00Z"));
    saveTaskManifest(older, base);
    saveTaskManifest(newer, base);
    expect(listTaskManifests(base).map(item => item.taskId)).toEqual(["newer", "older"]);
  });
});
