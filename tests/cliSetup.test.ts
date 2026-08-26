import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetupCommand, type SetupDeps } from "../src/commands/cli/setup.js";

function scriptDeps(answers: string[]): { deps: SetupDeps; configBase: string; cwd: string } {
  const queue = [...answers];
  const configBase = mkdtempSync(join(tmpdir(), "setup-cfg-"));
  const cwd = mkdtempSync(join(tmpdir(), "setup-cwd-"));
  const deps: SetupDeps = {
    configBase,
    cwd,
    promptText: async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error("prompt script exhausted");
      return next;
    }
  };
  return { deps, configBase, cwd };
}

const settingsOf = (configBase: string) =>
  JSON.parse(readFileSync(join(configBase, "settings.json"), "utf8"));

describe("runSetupCommand settings sections", () => {
  it("saves provider, model, network mode, theme, effort, and memory answers", async () => {
    const { deps, configBase } = scriptDeps([
      "acme", "my-model",
      "offlineStrict",
      "dracula", "high", "n"
    ]);
    writeFileSync(join(configBase, "providers.json"), JSON.stringify({ acme: { kind: "openai" } }));
    const result = await runSetupCommand([], deps);
    expect(result.exitCode).toBe(0);
    expect(settingsOf(configBase)).toEqual({
      provider: "acme",
      model: "my-model",
      networkMode: "offlineStrict",
      theme: "dracula",
      effort: "high",
      autoMemoryEnabled: false
    });
  });

  it("Enter keeps current values and writes nothing when nothing changes", async () => {
    const { deps, configBase } = scriptDeps(["", "", "", "", "", ""]);
    await runSetupCommand([], deps);
    expect(existsSync(join(configBase, "settings.json"))).toBe(false);
  });

  it("re-prompts on invalid network mode and invalid effort before accepting", async () => {
    const { deps, configBase } = scriptDeps([
      "", "",
      "bogus", "providerOnly",
      "", "nope", "low", ""
    ]);
    await runSetupCommand([], deps);
    const s = settingsOf(configBase);
    expect(s.networkMode).toBe("providerOnly");
    expect(s.effort).toBe("low");
  });

  it("rejects unknown provider names without saving them", async () => {
    const { deps, configBase } = scriptDeps(["ghost", "", "", "", "", ""]);
    await runSetupCommand([], deps);
    expect(existsSync(join(configBase, "settings.json"))).toBe(false);
  });

  it("ends with a summary containing effective values", async () => {
    const { deps } = scriptDeps(["", "", "", "", "", ""]);
    const result = await runSetupCommand([], deps);
    expect(result.stdout).toContain("Effective settings:");
  });
});
