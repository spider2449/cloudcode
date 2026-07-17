import { describe, it, expect } from "vitest";
import { decidePermission } from "../src/engine/permissions.js";
import { PermissionStore } from "../src/agent/permissionStore.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function freshStore(): PermissionStore {
  // Point the store at an empty temp project so no real rules leak in.
  return new PermissionStore(mkdtempSync(join(tmpdir(), "cc-perm-")));
}

describe("decidePermission", () => {
  it("bypassPermissions allows everything", () => {
    expect(decidePermission("Bash", { command: "rm -rf /" }, "bypassPermissions", freshStore())).toBe("allow");
  });
  it("acceptEdits auto-allows file edit tools but asks for Bash", () => {
    const store = freshStore();
    expect(decidePermission("Edit", { file_path: "x" }, "acceptEdits", store)).toBe("allow");
    expect(decidePermission("Write", { file_path: "x" }, "acceptEdits", store)).toBe("allow");
    expect(decidePermission("Bash", { command: "ls" }, "acceptEdits", store)).toBe("ask");
  });
  it("default mode allows read-only tools and asks for the rest", () => {
    const store = freshStore();
    expect(decidePermission("Read", { file_path: "x" }, "default", store)).toBe("allow");
    expect(decidePermission("Glob", { pattern: "*" }, "default", store)).toBe("allow");
    expect(decidePermission("Grep", { pattern: "x" }, "default", store)).toBe("allow");
    expect(decidePermission("Write", { file_path: "x" }, "default", store)).toBe("ask");
  });
});

describe("Bash command rules", () => {
  it("allows a Bash command matching a remembered allow prefix", () => {
    const store = freshStore();
    store.rememberCommand("git", "allow");
    expect(decidePermission("Bash", { command: "git status" }, "default", store)).toBe("allow");
  });

  it("denies a Bash command matching a deny prefix even in acceptEdits", () => {
    const store = freshStore();
    store.rememberCommand("rm", "deny");
    expect(decidePermission("Bash", { command: "rm -rf /" }, "acceptEdits", store)).toBe("deny");
  });

  it("still asks for Bash commands with no matching rule", () => {
    expect(decidePermission("Bash", { command: "git status" }, "default", freshStore())).toBe("ask");
  });

  it("bypassPermissions still allows everything", () => {
    const store = freshStore();
    store.rememberCommand("rm", "deny");
    expect(decidePermission("Bash", { command: "rm -rf /" }, "bypassPermissions", store)).toBe("allow");
  });
});
