import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangeJournal } from "../src/agent/changeJournal.js";

const roots: string[] = [];
function fixture(options: { fileLimit?: number; checkpointLimit?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cc-journal-"));
  roots.push(root);
  const project = join(root, "project");
  const storage = join(root, "storage");
  mkdirSync(project, { recursive: true });
  mkdirSync(storage, { recursive: true });
  return { root, project, storage, journal: new ChangeJournal(project, "session", { rootDir: storage, ...options }) };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ChangeJournal", () => {
  it("coalesces repeated edits and restores the first before-image", async () => {
    const { project, storage, journal } = fixture();
    const path = join(project, "a.txt");
    writeFileSync(path, "user state", { flag: "w" });
    journal.beginCheckpoint();
    const one = await journal.before(path);
    writeFileSync(path, "agent one");
    await journal.after(one);
    const two = await journal.before(path);
    writeFileSync(path, "agent two");
    await journal.after(two);
    journal.finishCheckpoint();

    expect(journal.listChanges()).toHaveLength(1);
    expect(journal.diff().content).toContain("-user state");
    expect(journal.diff().content).toContain("+agent two");
    expect(journal.undoLatest().applied).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("user state");

    const resumed = new ChangeJournal(project, "session", { rootDir: storage });
    expect(resumed.listChanges()[0].status).toBe("undone");
  });

  it("removes a newly created file on undo", async () => {
    const { project, journal } = fixture();
    const path = join(project, "new.txt");
    journal.beginCheckpoint();
    const token = await journal.before(path);
    writeFileSync(path, "new");
    await journal.after(token);
    journal.finishCheckpoint();
    expect(journal.previewUndo().operations).toEqual([{ path, action: "remove" }]);
    expect(journal.undoLatest().applied).toBe(true);
    expect(() => readFileSync(path)).toThrow();
  });

  it("refuses the entire undo when current content changed", async () => {
    const { project, journal } = fixture();
    const one = join(project, "one.txt");
    const two = join(project, "two.txt");
    writeFileSync(one, "one");
    writeFileSync(two, "two");
    journal.beginCheckpoint();
    for (const [path, content] of [[one, "agent one"], [two, "agent two"]]) {
      const token = await journal.before(path);
      writeFileSync(path, content);
      await journal.after(token);
    }
    journal.finishCheckpoint();
    writeFileSync(two, "external");
    const result = journal.undoLatest();
    expect(result.applied).toBe(false);
    expect(result.conflicts[0]).toContain("content changed");
    expect(readFileSync(one, "utf8")).toBe("agent one");
    expect(readFileSync(two, "utf8")).toBe("external");
  });

  it("records oversized files as visible but not undoable", async () => {
    const { project, journal } = fixture({ fileLimit: 3 });
    const path = join(project, "large.txt");
    writeFileSync(path, "1234");
    journal.beginCheckpoint();
    const token = await journal.before(path);
    writeFileSync(path, "changed");
    await journal.after(token);
    journal.finishCheckpoint();
    expect(journal.listChanges()[0].changes[0].undoAvailable).toBe(false);
    expect(journal.previewUndo().conflicts[0]).toContain("exceeds");
  });

  it("drops no-op checkpoints and prunes old completed checkpoints", async () => {
    const { project, journal } = fixture({ checkpointLimit: 2 });
    journal.beginCheckpoint();
    expect(journal.finishCheckpoint()).toBeUndefined();
    for (let index = 0; index < 3; index++) {
      const path = join(project, `${index}.txt`);
      journal.beginCheckpoint();
      const token = await journal.before(path);
      writeFileSync(path, String(index));
      await journal.after(token);
      journal.finishCheckpoint();
    }
    expect(journal.listChanges()).toHaveLength(2);
  });

  it("falls back safely on a malformed manifest", () => {
    const { project, storage } = fixture();
    writeFileSync(join(storage, "manifest.json"), "not json");
    const journal = new ChangeJournal(project, "session", { rootDir: storage });
    expect(journal.listChanges()).toEqual([]);
    expect(journal.warnings()[0]).toContain("ignored");
  });
});
