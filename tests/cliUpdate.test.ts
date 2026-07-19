import { describe, it, expect } from "vitest";
import { isNpmGlobalInstall, runUpdate, UPDATE_INSTRUCTIONS, type Exec } from "../src/commands/cli/update.js";

describe("isNpmGlobalInstall", () => {
  it("detects a global npm install", () => {
    expect(isNpmGlobalInstall("/usr/lib\n`-- cloudcode@0.1.0\n")).toBe(true);
  });
  it("rejects empty npm ls output", () => {
    expect(isNpmGlobalInstall("/usr/lib\n`-- (empty)\n")).toBe(false);
    expect(isNpmGlobalInstall("")).toBe(false);
  });
});

describe("runUpdate", () => {
  it("prints instructions when not installed via npm", () => {
    const calls: string[][] = [];
    const logs: string[] = [];
    const exec: Exec = args => { calls.push(args); return { stdout: "`-- (empty)", status: 1 }; };
    expect(runUpdate(exec, s => logs.push(s))).toBe(0);
    expect(calls).toEqual([["ls", "-g", "cloudcode", "--depth=0"]]);
    expect(logs.join("\n")).toContain(UPDATE_INSTRUCTIONS);
  });

  it("runs npm install -g when installed via npm", () => {
    const calls: string[][] = [];
    const exec: Exec = args => {
      calls.push(args);
      return args[0] === "ls"
        ? { stdout: "`-- cloudcode@0.1.0", status: 0 }
        : { stdout: null, status: 0 };
    };
    expect(runUpdate(exec, () => {})).toBe(0);
    expect(calls[1]).toEqual(["install", "-g", "cloudcode@latest"]);
  });

  it("propagates npm install failure as exit 1", () => {
    const exec: Exec = args =>
      args[0] === "ls" ? { stdout: "`-- cloudcode@0.1.0", status: 0 } : { stdout: null, status: 3 };
    expect(runUpdate(exec, () => {})).toBe(1);
  });
});
