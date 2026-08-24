import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, saveSetting, saveNetworkStorageRule } from "../src/agent/settings.js";

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

  it("round-trips effort and rejects invalid values", () => {
    const file = join(dir(), "settings.json");
    saveSetting("effort", "medium", file);
    expect(loadSettings(file).effort).toBe("medium");
    saveSetting("effort", "extreme", file);
    expect(loadSettings(file).effort).toBeUndefined();
  });

  it("persists strict/provider-only network modes but rejects unrestricted", () => {
    const file = join(dir(), "settings.json");
    saveSetting("networkMode", "offlineStrict", file);
    expect(loadSettings(file).networkMode).toBe("offlineStrict");
    saveSetting("networkMode", "unrestricted", file);
    expect(loadSettings(file).networkMode).toBeUndefined();
  });
});

describe("autoMemoryEnabled", () => {
  it("round-trips booleans and ignores non-booleans", () => {
    const file = join(dir(), "settings.json");
    saveSetting("autoMemoryEnabled", false, file);
    expect(loadSettings(file).autoMemoryEnabled).toBe(false);
    saveSetting("autoMemoryEnabled", true, file);
    expect(loadSettings(file).autoMemoryEnabled).toBe(true);
    writeFileSync(file, JSON.stringify({ autoMemoryEnabled: "yes" }));
    expect(loadSettings(file).autoMemoryEnabled).toBeUndefined();
  });
});

describe("statusLineItems setting", () => {
  it("round-trips an array through save/load", () => {
    const file = join(dir(), "settings.json");
    saveSetting("statusLineItems", ["cost", "mode"], file);
    expect(loadSettings(file).statusLineItems).toEqual(["cost", "mode"]);
  });

  it("drops unknown IDs and duplicates on load", () => {
    const file = join(dir(), "settings.json");
    writeFileSync(file, JSON.stringify({ statusLineItems: ["nope", "cost", "cost"] }));
    expect(loadSettings(file).statusLineItems).toEqual(["cost"]);
  });

  it("ignores non-array values and preserves an explicit empty array", () => {
    const bad = join(dir(), "bad.json");
    writeFileSync(bad, JSON.stringify({ statusLineItems: "model" }));
    expect(loadSettings(bad).statusLineItems).toBeUndefined();
    const empty = join(dir(), "empty.json");
    writeFileSync(empty, JSON.stringify({ statusLineItems: [] }));
    expect(loadSettings(empty).statusLineItems).toEqual([]);
  });

  it("preserves unknown sibling keys when saving the array", () => {
    const file = join(dir(), "settings.json");
    saveSetting("provider", "local", file);
    saveSetting("statusLineItems", ["cost"], file);
    expect(loadSettings(file)).toEqual({ provider: "local", statusLineItems: ["cost"] });
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(raw["provider"]).toBe("local");
  });
});

describe("networkStorage setting", () => {
  it("round-trips valid rules through save/load", () => {
    const file = join(dir(), "settings.json");
    saveSetting(
      "networkStorage",
      [{ target: "\\\\srv\\sh", decision: "allow" }],
      file
    );
    expect(loadSettings(file).networkStorage).toEqual([
      { target: "//srv/sh", decision: "allow" }
    ]);
  });

  it("drops malformed entries but keeps valid siblings", () => {
    const file = join(dir(), "settings.json");
    writeFileSync(file, JSON.stringify({
      networkStorage: [
        { target: "//srv/sh", decision: "allow" },
        { target: "//only-server", decision: "allow" },
        { target: "Z:", decision: "maybe" },
        "garbage",
        { target: 42, decision: "deny" }
      ]
    }));
    expect(loadSettings(file).networkStorage).toEqual([
      { target: "//srv/sh", decision: "allow" }
    ]);
  });

  it("ignores a non-array networkStorage", () => {
    const file = join(dir(), "settings.json");
    writeFileSync(file, JSON.stringify({ networkStorage: "all" }));
    expect(loadSettings(file).networkStorage).toBeUndefined();
  });

  it("upserts a single rule via saveNetworkStorageRule, replacing same target", () => {
    const file = join(dir(), "settings.json");
    saveNetworkStorageRule("\\\\srv\\sh", "deny", file);
    saveNetworkStorageRule("//srv/sh", "allow", file);
    saveNetworkStorageRule("Z:", "allow", file);
    expect(loadSettings(file).networkStorage).toEqual([
      { target: "//srv/sh", decision: "allow" },
      { target: "z:", decision: "allow" }
    ]);
  });

  it("preserves unknown sibling keys when saving a rule", () => {
    const file = join(dir(), "settings.json");
    writeFileSync(file, JSON.stringify({ futureKey: "x" }));
    saveNetworkStorageRule("Z:", "deny", file);
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(raw["futureKey"]).toBe("x");
  });
});

