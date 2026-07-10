import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, saveSetting } from "../src/agent/settings.js";

const dir = () => mkdtempSync(join(tmpdir(), "settings-"));

describe("settings persistence", () => {
  it("round-trips a saved setting", () => {
    const file = join(dir(), "settings.json");
    saveSetting("provider", "local", file);
    expect(loadSettings(file)).toEqual({ provider: "local" });
  });

  it("preserves other keys on save", () => {
    const file = join(dir(), "settings.json");
    saveSetting("provider", "local", file);
    saveSetting("model", "claude-sonnet-5", file);
    expect(loadSettings(file)).toEqual({ provider: "local", model: "claude-sonnet-5" });
  });

  it("returns empty settings when the file is missing", () => {
    expect(loadSettings(join(dir(), "nope.json"))).toEqual({});
  });

  it("returns empty settings when the file is corrupt", () => {
    const file = join(dir(), "settings.json");
    writeFileSync(file, "not json{{");
    expect(loadSettings(file)).toEqual({});
  });

  it("drops invalid field shapes", () => {
    const file = join(dir(), "settings.json");
    writeFileSync(file, JSON.stringify({ provider: 42, model: ["x"], permissionMode: "yolo" }));
    expect(loadSettings(file)).toEqual({});
  });

  it("keeps a valid permissionMode", () => {
    const file = join(dir(), "settings.json");
    writeFileSync(file, JSON.stringify({ permissionMode: "acceptEdits" }));
    expect(loadSettings(file)).toEqual({ permissionMode: "acceptEdits" });
  });

  it("preserves keys it does not understand when saving", () => {
    const file = join(dir(), "settings.json");
    writeFileSync(file, JSON.stringify({ permissionMode: "bypassPermissions", futureKey: "x" }));
    saveSetting("provider", "local", file);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw).toEqual({ permissionMode: "bypassPermissions", futureKey: "x", provider: "local" });
  });

  it("drops a persisted bypassPermissions (session-only mode)", () => {
    const file = join(dir(), "settings.json");
    writeFileSync(file, JSON.stringify({ permissionMode: "bypassPermissions" }));
    expect(loadSettings(file)).toEqual({});
  });
});
