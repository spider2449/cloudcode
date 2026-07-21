import { describe, it, expect } from "vitest";
import { decidePermission } from "../src/engine/permissions.js";
import { PermissionStore } from "../src/agent/permissionStore.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CWD = process.cwd();

function freshStore(): PermissionStore {
  // Point the store at an empty temp project so no real rules leak in.
  return new PermissionStore(mkdtempSync(join(tmpdir(), "cc-perm-")));
}

describe("decidePermission", () => {
  it("bypassPermissions allows everything", () => {
    expect(decidePermission("Bash", { command: "rm -rf /" }, "bypassPermissions", freshStore(), CWD)).toBe("allow");
  });
  it("acceptEdits auto-allows file edit tools but asks for Bash", () => {
    const store = freshStore();
    expect(decidePermission("Edit", { file_path: "x" }, "acceptEdits", store, CWD)).toBe("allow");
    expect(decidePermission("Write", { file_path: "x" }, "acceptEdits", store, CWD)).toBe("allow");
    expect(decidePermission("Bash", { command: "ls" }, "acceptEdits", store, CWD)).toBe("ask");
  });
  it("default mode allows read-only tools and asks for the rest", () => {
    const store = freshStore();
    expect(decidePermission("Read", { file_path: "x" }, "default", store, CWD)).toBe("allow");
    expect(decidePermission("Glob", { pattern: "*" }, "default", store, CWD)).toBe("allow");
    expect(decidePermission("Grep", { pattern: "x" }, "default", store, CWD)).toBe("allow");
    expect(decidePermission("Write", { file_path: "x" }, "default", store, CWD)).toBe("ask");
  });
});

describe("out-of-cwd edits", () => {
  const OUTSIDE = join(tmpdir(), "cc-perm-outside", "file.txt");

  it("acceptEdits still asks for a path outside cwd", () => {
    const store = freshStore();
    expect(decidePermission("Write", { file_path: OUTSIDE }, "acceptEdits", store, CWD)).toBe("ask");
  });

  it("bypassPermissions still asks for a path outside cwd", () => {
    const store = freshStore();
    expect(decidePermission("Write", { file_path: OUTSIDE }, "bypassPermissions", store, CWD)).toBe("ask");
  });

  it("bypassPermissions still allows Bash (only file edits are scoped to cwd)", () => {
    const store = freshStore();
    expect(decidePermission("Bash", { command: "ls" }, "bypassPermissions", store, CWD)).toBe("allow");
  });

  it("an explicit remembered allow rule for an outside path still wins", () => {
    const store = freshStore();
    store.remember("Write", OUTSIDE, "allow");
    expect(decidePermission("Write", { file_path: OUTSIDE }, "acceptEdits", store, CWD)).toBe("allow");
  });

  it("acceptEdits still auto-allows a path inside cwd", () => {
    const store = freshStore();
    expect(decidePermission("Write", { file_path: join(CWD, "x") }, "acceptEdits", store, CWD)).toBe("allow");
  });
});

describe("Bash command rules", () => {
  it("allows a Bash command matching a remembered allow prefix", () => {
    const store = freshStore();
    store.rememberCommand("git", "allow");
    expect(decidePermission("Bash", { command: "git status" }, "default", store, CWD)).toBe("allow");
  });

  it("denies a Bash command matching a deny prefix even in acceptEdits", () => {
    const store = freshStore();
    store.rememberCommand("rm", "deny");
    expect(decidePermission("Bash", { command: "rm -rf /" }, "acceptEdits", store, CWD)).toBe("deny");
  });

  it("still asks for Bash commands with no matching rule", () => {
    expect(decidePermission("Bash", { command: "git status" }, "default", freshStore(), CWD)).toBe("ask");
  });

  it("bypassPermissions still allows everything", () => {
    const store = freshStore();
    store.rememberCommand("rm", "deny");
    expect(decidePermission("Bash", { command: "rm -rf /" }, "bypassPermissions", store, CWD)).toBe("allow");
  });

  it("does not auto-allow a compound command even with a matching allow prefix rule", () => {
    const store = freshStore();
    store.rememberCommand("git", "allow");
    expect(decidePermission("Bash", { command: "git status; rm -rf ~" }, "default", store, CWD)).toBe("ask");
  });

  it("still denies a compound command with a matching deny prefix rule", () => {
    const store = freshStore();
    store.rememberCommand("git", "deny");
    expect(decidePermission("Bash", { command: "git status; rm -rf ~" }, "default", store, CWD)).toBe("deny");
  });

  it("does not auto-allow a newline-injected command even with a matching allow prefix", () => {
    const store = freshStore();
    store.rememberCommand("git", "allow");
    expect(decidePermission("Bash", { command: "git status\nrm -rf ~" }, "default", store, CWD)).toBe("ask");
  });
});

describe("out-of-cwd reads", () => {
  const OUTSIDE = join(tmpdir(), "cc-perm-outside", "secret.txt");

  it("asks before reading a file outside cwd in default mode", () => {
    expect(decidePermission("Read", { file_path: OUTSIDE }, "default", freshStore(), CWD)).toBe("ask");
  });

  it("still asks for an outside-cwd read even in bypassPermissions", () => {
    expect(decidePermission("Read", { file_path: OUTSIDE }, "bypassPermissions", freshStore(), CWD)).toBe("ask");
  });

  it("auto-allows a read inside cwd", () => {
    expect(decidePermission("Read", { file_path: join(CWD, "src", "x.ts") }, "default", freshStore(), CWD)).toBe("allow");
  });

  it("an explicit remembered allow rule for an outside path still wins", () => {
    const store = freshStore();
    store.remember("Read", OUTSIDE, "allow");
    expect(decidePermission("Read", { file_path: OUTSIDE }, "default", store, CWD)).toBe("allow");
  });

  it("still auto-allows Glob/Grep (pattern tools are not path-confined here)", () => {
    const store = freshStore();
    expect(decidePermission("Glob", { pattern: "*", path: OUTSIDE }, "default", store, CWD)).toBe("allow");
    expect(decidePermission("Grep", { pattern: "x", path: OUTSIDE }, "default", store, CWD)).toBe("allow");
  });
});
