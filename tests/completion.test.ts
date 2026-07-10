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
