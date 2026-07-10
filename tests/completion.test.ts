import { describe, it, expect } from "vitest";
import { getSuggestions, applySuggestion, type CompletionContext } from "../src/commands/completion.js";
import { buildRegistry } from "../src/commands/builtins.js";

function ctx(overrides: Partial<CompletionContext> = {}): CompletionContext {
  return {
    registry: buildRegistry(),
    providerNames: () => ["anthropic", "local"],
    listFiles: () => [],
    ...overrides
  };
}

describe("command-name provider", () => {
  it("suggests all commands for bare slash", () => {
    const s = getSuggestions("/", 1, ctx());
    expect(s.length).toBeGreaterThan(5);
    expect(s[0].label.startsWith("/")).toBe(true);
  });

  it("filters by prefix and includes description", () => {
    const s = getSuggestions("/pe", 3, ctx());
    expect(s.map(x => x.label)).toEqual(["/permissions"]);
    expect(s[0].description).toContain("Permission");
    expect(s[0]).toMatchObject({ replaceStart: 0, replaceEnd: 3, value: "/permissions " });
  });

  it("returns nothing for plain text or unknown prefix", () => {
    expect(getSuggestions("hello", 5, ctx())).toEqual([]);
    expect(getSuggestions("/zzz", 4, ctx())).toEqual([]);
  });

  it("returns nothing when cursor is not at the end of the slash token", () => {
    expect(getSuggestions("/pe", 1, ctx())).toEqual([]);
  });

  it("suggests hyphenated command names", () => {
    const registry = buildRegistry();
    registry.set("commit-helper", { name: "commit-helper", description: "Write a commit", async run() {} });
    const s = getSuggestions("/commit-h", 9, ctx({ registry }));
    expect(s.map(x => x.label)).toEqual(["/commit-helper"]);
  });
});

describe("applySuggestion", () => {
  it("replaces the range and positions the cursor after the value", () => {
    const r = applySuggestion("/pe", { value: "/permissions ", label: "/permissions", replaceStart: 0, replaceEnd: 3 });
    expect(r).toEqual({ text: "/permissions ", cursor: 13 });
  });
});

describe("argument provider", () => {
  it("suggests permission modes and subcommands", () => {
    const s = getSuggestions("/permissions ", 13, ctx());
    expect(s.map(x => x.value)).toEqual(["default", "acceptEdits", "bypassPermissions", "list", "clear"]);
    expect(s[0]).toMatchObject({ replaceStart: 13, replaceEnd: 13 });
  });

  it("filters argument suggestions by prefix", () => {
    const s = getSuggestions("/permissions cl", 15, ctx());
    expect(s.map(x => x.value)).toEqual(["clear"]);
    expect(s[0]).toMatchObject({ replaceStart: 13, replaceEnd: 15 });
  });

  it("suggests provider names for /provider", () => {
    const s = getSuggestions("/provider lo", 12, ctx());
    expect(s.map(x => x.value)).toEqual(["local"]);
  });

  it("returns nothing for commands without completeArgs", () => {
    expect(getSuggestions("/help x", 7, ctx())).toEqual([]);
  });
});

describe("@file provider", () => {
  const files = ["src/cli.tsx", "src/ui/App.tsx", "README.md"];

  it("suggests files for an @token before the cursor", () => {
    const s = getSuggestions("look at @cli", 12, ctx({ listFiles: () => files }));
    expect(s.map(x => x.value)).toEqual(["@src/cli.tsx"]);
    expect(s[0]).toMatchObject({ replaceStart: 8, replaceEnd: 12, label: "src/cli.tsx" });
  });

  it("works with @ at the start of input", () => {
    const s = getSuggestions("@READ", 5, ctx({ listFiles: () => files }));
    expect(s.map(x => x.value)).toEqual(["@README.md"]);
  });

  it("takes priority over the argument provider", () => {
    const s = getSuggestions("/model @cli", 11, ctx({ listFiles: () => files }));
    expect(s[0].value).toBe("@src/cli.tsx");
  });

  it("returns nothing when no files match or no @token", () => {
    expect(getSuggestions("@zzz", 4, ctx({ listFiles: () => files }))).toEqual([]);
    expect(getSuggestions("plain text", 10, ctx({ listFiles: () => files }))).toEqual([]);
  });

  it("ignores an @ that is part of an email-like word", () => {
    expect(getSuggestions("mail me a@b", 11, ctx({ listFiles: () => files }))).toEqual([]);
  });
});
