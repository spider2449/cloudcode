import { describe, it, expect } from "vitest";
import {
  isValidNetworkStorageRule,
  normalizeNetworkTarget,
  isNetworkPath,
  networkStorageRoot,
  matchNetworkStorage,
  type NetworkStorageRule
} from "../src/agent/networkStorage.js";

const rules = (...rs: Array<[string, "allow" | "deny"]>): NetworkStorageRule[] =>
  rs.map(([target, decision]) => ({ target, decision }));

describe("normalizeNetworkTarget", () => {
  it("converts backslashes to slashes, strips trailing slashes, lowercases", () => {
    expect(normalizeNetworkTarget("\\\\Server\\Share\\")).toBe("//server/share");
    expect(normalizeNetworkTarget("Z:\\")).toBe("z:");
    expect(normalizeNetworkTarget("z:/Data/Sub/")).toBe("z:/data/sub");
  });
});

describe("isValidNetworkStorageRule", () => {
  it("accepts UNC and drive-letter roots", () => {
    expect(isValidNetworkStorageRule({ target: "\\\\srv\\sh", decision: "allow" })).toBe(true);
    expect(isValidNetworkStorageRule({ target: "Z:", decision: "deny" })).toBe(true);
    expect(isValidNetworkStorageRule({ target: "//srv/sh/sub", decision: "deny" })).toBe(true);
  });

  it("rejects malformed entries", () => {
    expect(isValidNetworkStorageRule({ target: "//srv", decision: "allow" })).toBe(false);
    expect(isValidNetworkStorageRule({ target: "//srv/sh", decision: "maybe" })).toBe(false);
    expect(isValidNetworkStorageRule({ target: 42, decision: "allow" })).toBe(false);
    expect(isValidNetworkStorageRule(null)).toBe(false);
    expect(isValidNetworkStorageRule("Z:")).toBe(false);
  });
});

describe("isNetworkPath", () => {
  it("detects normalized UNC paths and drive-letter paths", () => {
    expect(isNetworkPath("//server/share/file.txt")).toBe(true);
    expect(isNetworkPath("z:/data/a.txt")).toBe(true);
    // resolve() output on any platform never looks like these:
    expect(isNetworkPath("/home/user/project/a.txt")).toBe(false);
    expect(isNetworkPath("c:/users/x/appdata/a.txt")).toBe(true);
  });
});

describe("networkStorageRoot", () => {
  it("reduces a UNC path to its share root", () => {
    expect(networkStorageRoot("//server/share/deep/file.txt")).toBe("//server/share");
    expect(networkStorageRoot("//server/share")).toBe("//server/share");
  });

  it("reduces a drive path to the bare drive letter", () => {
    expect(networkStorageRoot("z:/data/a.txt")).toBe("z:");
  });

  // POSIX-only: on win32 every absolute path resolves to a drive letter, so
  // "/home/..." becomes "<cwd-drive>:/home/..." and is drive-shaped by design.
  it.skipIf(process.platform === "win32")("returns undefined for local paths", () => {
    expect(networkStorageRoot("/home/user/project/a.txt")).toBeUndefined();
  });
});

describe("matchNetworkStorage", () => {
  it("matches equal and deeper paths under a UNC share root", () => {
    const rs = rules(["//server/share", "deny"]);
    expect(matchNetworkStorage(rs, "//server/share")).toBe("deny");
    expect(matchNetworkStorage(rs, "//server/share/sub/f.txt")).toBe("deny");
  });

  it("does not treat sibling shares as matches", () => {
    expect(matchNetworkStorage(rules(["//server/share", "deny"]), "//server/other/f.txt")).toBeUndefined();
  });

  it("matches drive-letter paths by literal form", () => {
    expect(matchNetworkStorage(rules(["z:", "allow"]), "z:/data/f.txt")).toBe("allow");
    expect(matchNetworkStorage(rules(["z:", "allow"]), "y:/data/f.txt")).toBeUndefined();
  });

  it("deny wins over allow across both forms of a mapped drive", () => {
    // z:/f.txt matches both the drive rule and (when Z: maps to //srv/sh)
    // the UNC rule; deny beats allow regardless of rule order.
    const rs = rules(["//srv/sh", "deny"], ["z:", "allow"]);
    expect(matchNetworkStorage(rs, "z:/f.txt", () => "//srv/sh")).toBe("deny");
    expect(matchNetworkStorage([...rs].reverse(), "z:/f.txt", () => "//srv/sh")).toBe("deny");
  });

  it("uses resolved UNC form for mapped drives via the injected resolver", () => {
    const rs = rules(["//srv/sh", "allow"]);
    expect(matchNetworkStorage(rs, "z:/f.txt", () => "//srv/sh")).toBe("allow");
    expect(matchNetworkStorage(rs, "z:/f.txt", () => null)).toBeUndefined();
  });

  // POSIX-only, same reason as networkStorageRoot's local-path test above.
  it.skipIf(process.platform === "win32")("ignores non-network paths entirely", () => {
    expect(matchNetworkStorage(rules(["z:", "allow"]), "/home/u/p/f.txt")).toBeUndefined();
  });
});
