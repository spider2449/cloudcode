import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock spawnSync before importing openInEditor
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({ error: undefined })),
}));

import { spawnSync } from "node:child_process";
import { ensureFile, openInEditor } from "../src/commands/editor.js";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "ccedit-")); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("ensureFile", () => {
  it("creates the file with empty content when missing", () => {
    const dir = tmp();
    const path = join(dir, "CLAUDE.md");
    ensureFile(path);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("");
  });

  it("does not touch existing content (wx flag preserves it, EEXIST caught)", () => {
    const dir = tmp();
    const path = join(dir, "CLAUDE.md");
    writeFileSync(path, "existing content");
    ensureFile(path);
    expect(readFileSync(path, "utf8")).toBe("existing content");
  });
});

describe("openInEditor", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("prefers $VISUAL when set", () => {
    process.env.VISUAL = "vim";
    process.env.EDITOR = "emacs";
    const dir = tmp();
    const path = join(dir, "test.md");

    const result = openInEditor(path);

    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith("vim", [path], { stdio: "inherit", shell: true });
    expect(result.hint).toContain("$VISUAL");
    expect(result.ok).toBe(true);
  });

  it("falls back to $EDITOR when $VISUAL is unset", () => {
    delete process.env.VISUAL;
    process.env.EDITOR = "emacs";
    const dir = tmp();
    const path = join(dir, "test.md");

    const result = openInEditor(path);

    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith("emacs", [path], { stdio: "inherit", shell: true });
    expect(result.hint).toContain("$EDITOR");
    expect(result.ok).toBe(true);
  });

  it("falls back to a platform default when neither is set", () => {
    delete process.env.VISUAL;
    delete process.env.EDITOR;
    const dir = tmp();
    const path = join(dir, "test.md");

    const result = openInEditor(path);

    const expectedEditor = process.platform === "win32" ? "notepad" : "nano";
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(expectedEditor, [path], { stdio: "inherit", shell: true });
    expect(result.hint).toContain("Set $EDITOR or $VISUAL");
    expect(result.ok).toBe(true);
  });

  it("reports failure when spawnSync errors", () => {
    delete process.env.VISUAL;
    delete process.env.EDITOR;
    const dir = tmp();
    const path = join(dir, "test.md");

    vi.mocked(spawnSync).mockReturnValueOnce({ error: new Error("not found") } as never);

    const result = openInEditor(path);

    expect(result.ok).toBe(false);
    expect(result.hint).toContain("Failed");
    expect(result.hint).toContain("not found");
  });
});
