import { describe, expect, it } from "vitest";
import { parseCodeWorkspaceFile } from "../src/desktop/codeWorkspace.js";

const FILE = "/ws/project.code-workspace";

// The implementation returns native paths (drive letter + backslashes on
// win32); compare by suffix so assertions stay platform-independent.
const slash = (p: string): string => p.replaceAll("\\", "/");

describe("parseCodeWorkspaceFile", () => {
  it("resolves relative folders against the workspace file directory", () => {
    const repos = parseCodeWorkspaceFile(
      FILE,
      JSON.stringify({ folders: [{ path: "api" }, { path: "web", name: "Frontend" }] }),
      () => true
    );
    expect(repos).toHaveLength(2);
    expect(repos[0].id).toEqual(expect.any(String));
    expect(repos[0].name).toBe("api");
    expect(slash(repos[0].cwd).endsWith("/ws/api")).toBe(true);
    expect(repos[0].missing).toBe(false);
    expect(repos[1].name).toBe("Frontend");
    expect(slash(repos[1].cwd).endsWith("/ws/web")).toBe(true);
    expect(repos[1].missing).toBe(false);
  });

  it("flags missing paths and dedupes identical cwds", () => {
    const repos = parseCodeWorkspaceFile(
      FILE,
      JSON.stringify({ folders: [{ path: "api" }, { path: "./api" }, { path: "gone" }] }),
      p => !slash(p).endsWith("/ws/gone")
    );
    expect(repos).toHaveLength(2);
    expect(repos.find(r => slash(r.cwd).endsWith("/ws/gone"))).toMatchObject({ name: "gone", missing: true });
  });

  it("throws on malformed JSON or missing folders", () => {
    expect(() => parseCodeWorkspaceFile(FILE, "not json", () => true)).toThrow("Invalid workspace file.");
    expect(() => parseCodeWorkspaceFile(FILE, JSON.stringify({}), () => true)).toThrow("Invalid workspace file.");
  });
});
