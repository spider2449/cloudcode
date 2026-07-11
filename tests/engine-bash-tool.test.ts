import { describe, it, expect } from "vitest";
import { bashTool } from "../src/engine/tools/bash.js";

const ctx = { cwd: process.cwd() };

describe("bashTool", () => {
  it("captures stdout", async () => {
    const out = await bashTool.execute({ command: "echo hello" }, ctx);
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("hello");
  });
  it("reports nonzero exit as error with output", async () => {
    const out = await bashTool.execute({ command: "exit 3" }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("exit code 3");
  });
  it("times out long commands", async () => {
    const sleep = process.platform === "win32" ? "Start-Sleep -Seconds 10" : "sleep 10";
    const out = await bashTool.execute({ command: sleep, timeout: 500 }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content.toLowerCase()).toContain("timed out");
  }, 15000);
});
