import { describe, it, expect } from "vitest";
import { decidePermission, hostScope } from "../src/engine/permissions.js";
import { PermissionStore } from "../src/agent/permissionStore.js";
import { configDir } from "../src/agent/providers.js";
import { memoryDir, userMemoryFile } from "../src/engine/memoryPaths.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NetworkStorageRule } from "../src/agent/networkStorage.js";

const CWD = process.cwd();

const netRules = (...rs: Array<[string, "allow" | "deny"]>): NetworkStorageRule[] =>
  rs.map(([target, decision]) => ({ target, decision }));

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

  it("asks before searching a path outside cwd", () => {
    const store = freshStore();
    expect(decidePermission("Glob", { pattern: "*", path: OUTSIDE }, "default", store, CWD)).toBe("ask");
    expect(decidePermission("Grep", { pattern: "x", path: OUTSIDE }, "default", store, CWD)).toBe("ask");
    // Confinement holds in bypassPermissions too, as it does for reads.
    expect(decidePermission("Grep", { pattern: "x", path: OUTSIDE }, "bypassPermissions", store, CWD)).toBe("ask");
    // A relative path that climbs out of cwd is the same case.
    expect(decidePermission("Grep", { pattern: "x", path: "../.." }, "default", store, CWD)).toBe("ask");
  });

  it("auto-allows a search with no path, an empty path, or a path inside cwd", () => {
    const store = freshStore();
    expect(decidePermission("Glob", { pattern: "*" }, "default", store, CWD)).toBe("allow");
    expect(decidePermission("Glob", { pattern: "*", path: "" }, "default", store, CWD)).toBe("allow");
    expect(decidePermission("Grep", { pattern: "x", path: join(CWD, "src") }, "default", store, CWD)).toBe("allow");
    expect(decidePermission("Grep", { pattern: "x", path: "src" }, "default", store, CWD)).toBe("allow");
  });

  it("a remembered rule for the searched directory wins over the cwd guard", () => {
    const store = freshStore();
    store.rememberDir("Grep", OUTSIDE, "allow");
    expect(decidePermission("Grep", { pattern: "x", path: OUTSIDE }, "default", store, CWD)).toBe("allow");
    // Per-tool, as everywhere else in the store.
    expect(decidePermission("Glob", { pattern: "*", path: OUTSIDE }, "default", store, CWD)).toBe("ask");
  });

  it("a remembered deny blocks a search of a directory inside cwd", () => {
    const store = freshStore();
    store.rememberDir("Grep", join(CWD, "secrets"), "deny");
    expect(decidePermission("Grep", { pattern: "x", path: join(CWD, "secrets") }, "default", store, CWD)).toBe("deny");
    // Subdirectories of a denied directory are covered by the same rule.
    expect(decidePermission("Grep", { pattern: "x", path: join(CWD, "secrets", "keys") }, "default", store, CWD)).toBe("deny");
    // bypassPermissions still short-circuits inside cwd, as it does for every
    // other tool — deny rules only apply in the modes that consult them.
    expect(decidePermission("Grep", { pattern: "x", path: join(CWD, "secrets") }, "bypassPermissions", store, CWD)).toBe("allow");
  });
});

describe("WebFetch permissions", () => {
  it("asks by default", () => {
    const store = freshStore();
    expect(decidePermission("WebFetch", { url: "https://example.com/x" }, "default", store, CWD)).toBe("ask");
  });
  it("honors remembered host allow/deny", () => {
    const store = freshStore();
    store.rememberHost("WebFetch", "docs.example.com", "allow");
    store.rememberHost("WebFetch", "evil.example.com", "deny");
    expect(decidePermission("WebFetch", { url: "https://docs.example.com/page#sec" }, "default", store, CWD)).toBe("allow");
    expect(decidePermission("WebFetch", { url: "https://evil.example.com/" }, "default", store, CWD)).toBe("deny");
  });
  it("host matching ignores case", () => {
    const store = freshStore();
    store.rememberHost("WebFetch", "Docs.Example.com", "allow");
    expect(decidePermission("WebFetch", { url: "https://DOCS.EXAMPLE.COM/x" }, "default", store, CWD)).toBe("allow");
  });
  it("an unparseable url falls through to ask", () => {
    const store = freshStore();
    expect(decidePermission("WebFetch", { url: "not a url" }, "default", store, CWD)).toBe("ask");
  });
});

describe("hostScope", () => {
  it("returns the hostname for a WebFetch call", () => {
    expect(hostScope("WebFetch", { url: "https://Example.com/a" })).toBe("example.com");
  });
  it("returns undefined for other tools or bad urls", () => {
    expect(hostScope("Read", { url: "https://example.com" })).toBeUndefined();
    expect(hostScope("WebFetch", {})).toBeUndefined();
    expect(hostScope("WebFetch", { url: "ftp://example.com" })).toBeUndefined();
  });
});

describe("TodoWrite permissions", () => {
  it("is always allowed without prompting or store rules", () => {
    const store = freshStore();
    expect(decidePermission("TodoWrite", { todos: [] }, "default", store, CWD)).toBe("allow");
    expect(decidePermission("TodoWrite", { todos: [] }, "acceptEdits", store, CWD)).toBe("allow");
    expect(decidePermission("TodoWrite", {}, "bypassPermissions", store, CWD)).toBe("allow");
  });
});

describe("memory file permissions", () => {
  const MEM = memoryDir(CWD);
  const USER_MD = userMemoryFile();

  it("acceptEdits auto-allows writes into the project memory dir", () => {
    const store = freshStore();
    expect(decidePermission("Write", { file_path: join(MEM, "topic.md") }, "acceptEdits", store, CWD)).toBe("allow");
    expect(decidePermission("Edit", { file_path: join(MEM, "MEMORY.md") }, "acceptEdits", store, CWD)).toBe("allow");
  });

  it("bypassPermissions auto-allows memory writes", () => {
    expect(decidePermission("Write", { file_path: join(MEM, "topic.md") }, "bypassPermissions", freshStore(), CWD)).toBe("allow");
  });

  it("memory edits still follow default mode and ask, like inside-cwd edits", () => {
    expect(decidePermission("Write", { file_path: join(MEM, "topic.md") }, "default", freshStore(), CWD)).toBe("ask");
  });

  it("reads and searches inside the memory dir are allowed in default mode", () => {
    const store = freshStore();
    expect(decidePermission("Read", { file_path: join(MEM, "topic.md") }, "default", store, CWD)).toBe("allow");
    expect(decidePermission("Grep", { pattern: "x", path: MEM }, "default", store, CWD)).toBe("allow");
    expect(decidePermission("Glob", { pattern: "*", path: MEM }, "default", store, CWD)).toBe("allow");
  });

  it("the user-level CLOUDCODE.md is writable without an outside-cwd ask", () => {
    const store = freshStore();
    expect(decidePermission("Edit", { file_path: USER_MD }, "acceptEdits", store, CWD)).toBe("allow");
    expect(decidePermission("Read", { file_path: USER_MD }, "default", store, CWD)).toBe("allow");
  });

  it("another project's memory dir is not exempted", () => {
    const other = join(configDir(), "projects", "F--some-other-project", "memory");
    expect(decidePermission("Write", { file_path: join(other, "topic.md") }, "bypassPermissions", freshStore(), CWD)).toBe("ask");
  });

  it("a .. path that climbs out of the memory dir is not exempted", () => {
    const escape = join(MEM, "..", "elsewhere", "f.md");
    expect(decidePermission("Write", { file_path: escape }, "bypassPermissions", freshStore(), CWD)).toBe("ask");
  });

  it("a remembered deny rule for a memory path still wins", () => {
    const store = freshStore();
    store.remember("Write", join(MEM, "topic.md"), "deny");
    expect(decidePermission("Write", { file_path: join(MEM, "topic.md") }, "acceptEdits", store, CWD)).toBe("deny");
  });

  it("unrelated files next to the memory install are not exempted", () => {
    expect(decidePermission("Read", { file_path: userMemoryFile() + ".bak" }, "bypassPermissions", freshStore(), CWD)).toBe("ask");
  });
});

describe("network storage rules", () => {
  it("a network deny blocks reads and edits outright", () => {
    const rs = netRules(["//server/share", "deny"]);
    expect(decidePermission("Read", { file_path: "//server/share/f.txt" }, "default", freshStore(), CWD, rs)).toBe("deny");
    expect(decidePermission("Write", { file_path: "//server/share/f.txt" }, "bypassPermissions", freshStore(), CWD, rs)).toBe("deny");
  });

  it("a network allow makes reads behave like inside-cwd", () => {
    const rs = netRules(["//server/share", "allow"]);
    expect(decidePermission("Read", { file_path: "//server/share/f.txt" }, "default", freshStore(), CWD, rs)).toBe("allow");
    expect(decidePermission("Read", { file_path: "//server/share/f.txt" }, "bypassPermissions", freshStore(), CWD, rs)).toBe("allow");
  });

  it("a network allow makes edits follow mode logic instead of always asking", () => {
    const rs = netRules(["//server/share", "allow"]);
    expect(decidePermission("Write", { file_path: "//server/share/f.txt" }, "acceptEdits", freshStore(), CWD, rs)).toBe("allow");
    expect(decidePermission("Write", { file_path: "//server/share/f.txt" }, "default", freshStore(), CWD, rs)).toBe("ask");
  });

  it("an unmatched network path still asks in every mode", () => {
    const rs = netRules(["//other/share", "allow"], ["z:", "deny"]);
    expect(decidePermission("Read", { file_path: "//server/share/f.txt" }, "bypassPermissions", freshStore(), CWD, rs)).toBe("ask");
    expect(decidePermission("Grep", { pattern: "x", path: "//server/share" }, "default", freshStore(), CWD, rs)).toBe("ask");
  });

  it("a project-store deny wins over a network allow", () => {
    const rs = netRules(["//server/share", "allow"]);
    const store = freshStore();
    store.rememberDir("Read", "//server/share/private", "deny");
    expect(decidePermission("Read", { file_path: "//server/share/private/k.pem" }, "default", store, CWD, rs)).toBe("deny");
  });

  it("search tools honor network rules on their path input", () => {
    const rs = netRules(["//server/share", "allow"]);
    expect(decidePermission("Glob", { pattern: "*", path: "//server/share/src" }, "default", freshStore(), CWD, rs)).toBe("allow");
  });

  it("rules absent (undefined) preserves today's behavior", () => {
    expect(decidePermission("Read", { file_path: "//server/share/f.txt" }, "bypassPermissions", freshStore(), CWD)).toBe("ask");
  });
});
