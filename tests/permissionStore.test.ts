import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionStore, commandPrefix } from "../src/agent/permissionStore.js";

const tempCwd = () => mkdtempSync(join(tmpdir(), "cc-perm-"));

describe("PermissionStore", () => {
  it("remembers and checks a directory rule, including subdirectories", () => {
    const cwd = tempCwd();
    const store = new PermissionStore(cwd);
    store.remember("Write", join(cwd, "src", "a.ts"), "allow");
    expect(store.check("Write", join(cwd, "src", "b.ts"))).toBe("allow");
    expect(store.check("Write", join(cwd, "src", "deep", "c.ts"))).toBe("allow");
    expect(store.check("Write", join(cwd, "other", "d.ts"))).toBeUndefined();
    expect(store.check("Read", join(cwd, "src", "b.ts"))).toBeUndefined(); // per-tool
  });

  it("does not match sibling directories sharing a prefix", () => {
    const cwd = tempCwd();
    const store = new PermissionStore(cwd);
    store.remember("Read", join(cwd, "src", "a.ts"), "allow");
    expect(store.check("Read", join(cwd, "src2", "b.ts"))).toBeUndefined();
  });

  it("deny takes precedence over allow", () => {
    const cwd = tempCwd();
    const store = new PermissionStore(cwd);
    store.remember("Write", join(cwd, "src", "sub", "a.ts"), "deny");
    store.remember("Write", join(cwd, "src", "sub", "b.ts"), "allow"); // same dir: replaced below anyway
    store.remember("Write", join(cwd, "src", "x.ts"), "allow");        // parent dir allow
    expect(store.check("Write", join(cwd, "src", "y.ts"))).toBe("allow");
  });

  it("replaces a rule with the same tool and dir (newest wins)", () => {
    const cwd = tempCwd();
    const store = new PermissionStore(cwd);
    store.remember("Write", join(cwd, "src", "a.ts"), "deny");
    store.remember("Write", join(cwd, "src", "b.ts"), "allow");
    expect(store.list()).toHaveLength(1);
    expect(store.check("Write", join(cwd, "src", "c.ts"))).toBe("allow");
  });

  it("matches case-insensitively", () => {
    const cwd = tempCwd();
    const store = new PermissionStore(cwd);
    store.remember("Read", join(cwd, "Src", "a.ts"), "allow");
    expect(store.check("Read", join(cwd, "src", "B.TS"))).toBe("allow");
  });

  it("persists across instances and clears", () => {
    const cwd = tempCwd();
    const a = new PermissionStore(cwd);
    a.remember("Read", join(cwd, "src", "a.ts"), "allow");
    const b = new PermissionStore(cwd);
    expect(b.check("Read", join(cwd, "src", "z.ts"))).toBe("allow");
    b.clear();
    const c = new PermissionStore(cwd);
    expect(c.list()).toEqual([]);
  });

  it("tolerates corrupt files and skips malformed entries", () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, ".cloudcode"), { recursive: true });
    writeFileSync(join(cwd, ".cloudcode", "permissions.json"), "{nope");
    expect(new PermissionStore(cwd).list()).toEqual([]);
    writeFileSync(join(cwd, ".cloudcode", "permissions.json"),
      JSON.stringify([{ tool: "Read", dir: "/x", decision: "allow" }, { bad: true }, { tool: "Y", dir: 3, decision: "allow" }]));
    expect(new PermissionStore(cwd).list()).toHaveLength(1);
  });

  it("writes the rules file inside <cwd>/.cloudcode", () => {
    const cwd = tempCwd();
    new PermissionStore(cwd).remember("Write", join(cwd, "a.ts"), "allow");
    const raw = JSON.parse(readFileSync(join(cwd, ".cloudcode", "permissions.json"), "utf8"));
    expect(raw).toHaveLength(1);
    expect(raw[0].tool).toBe("Write");
    expect(raw[0].decision).toBe("allow");
  });
});

describe("command prefix rules", () => {
  it("commandPrefix extracts the first token", () => {
    expect(commandPrefix("git status --short")).toBe("git");
    expect(commandPrefix("  npm  test ")).toBe("npm");
    expect(commandPrefix("")).toBe("");
  });

  it("rememberCommand + checkCommand allow a matching prefix", () => {
    const store = new PermissionStore(tempCwd());
    store.rememberCommand("git", "allow");
    expect(store.checkCommand("git status")).toBe("allow");
    expect(store.checkCommand("git")).toBe("allow");
  });

  it("matches whole tokens only, not substrings", () => {
    const store = new PermissionStore(tempCwd());
    store.rememberCommand("git", "allow");
    expect(store.checkCommand("github-cli auth")).toBeUndefined();
  });

  it("deny beats allow for the same command", () => {
    const store = new PermissionStore(tempCwd());
    store.rememberCommand("rm", "allow");
    store.rememberCommand("rm", "deny");
    expect(store.checkCommand("rm -rf x")).toBe("deny");
  });

  it("persists prefix rules across instances", () => {
    const cwd = tempCwd();
    new PermissionStore(cwd).rememberCommand("npm", "allow");
    expect(new PermissionStore(cwd).checkCommand("npm test")).toBe("allow");
    // Directory rules from the same file still work alongside prefix rules.
    const store = new PermissionStore(cwd);
    store.remember("Edit", join(cwd, "src", "a.ts"), "allow");
    expect(new PermissionStore(cwd).check("Edit", join(cwd, "src", "b.ts"))).toBe("allow");
  });
});
