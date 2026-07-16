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
