import { describe, it, expect } from "vitest";
import { parseCli, HELP_TEXT } from "../src/cliArgs.js";

describe("parseCli", () => {
  it("defaults to interactive", () => {
    expect(parseCli([])).toEqual({ kind: "interactive", continue: false, resume: false, provider: undefined });
  });

  it("parses help and version, long and short", () => {
    expect(parseCli(["--help"])).toEqual({ kind: "help" });
    expect(parseCli(["-h"])).toEqual({ kind: "help" });
    expect(parseCli(["--version"])).toEqual({ kind: "version" });
    expect(parseCli(["-v"])).toEqual({ kind: "version" });
  });

  it("parses continue/resume/provider", () => {
    expect(parseCli(["-c"])).toMatchObject({ kind: "interactive", continue: true });
    expect(parseCli(["-r"])).toMatchObject({ kind: "interactive", resume: true });
    expect(parseCli(["--provider", "local"])).toMatchObject({ kind: "interactive", provider: "local" });
  });

  it("parses and validates a per-invocation network mode", () => {
    expect(parseCli(["--network-mode", "offlineStrict"])).toMatchObject({ kind: "interactive", networkMode: "offlineStrict" });
    expect(parseCli(["-p", "x", "--network-mode", "unrestricted"])).toMatchObject({ kind: "print", networkMode: "unrestricted" });
    expect(parseCli(["--network-mode", "offline-ish"]).kind).toBe("error");
  });

  it("detects subcommands and passes remaining args", () => {
    expect(parseCli(["doctor"])).toEqual({ kind: "subcommand", name: "doctor", args: [] });
    expect(parseCli(["mcp", "--x"])).toEqual({ kind: "subcommand", name: "mcp", args: ["--x"] });
  });

  it("rejects an unknown bare word", () => {
    const r = parseCli(["frobnicate"]);
    expect(r.kind).toBe("error");
    expect((r as { message: string }).message).toContain("Unknown command");
  });

  it("errors on unknown flags with a one-line message", () => {
    const r = parseCli(["--bogus"]);
    expect(r.kind).toBe("error");
    expect((r as { message: string }).message).toContain("--help");
  });

  it("parses print mode with a positional prompt", () => {
    expect(parseCli(["-p", "fix it"])).toEqual({
      kind: "print", prompt: "fix it", continue: false, provider: undefined, permissionMode: "default",
      trustProjectConfig: false, outputFormat: "text", runLimits: {}
    });
  });

  it("parses structured output and run limits", () => {
    expect(parseCli([
      "-p", "go", "--output-format", "stream-json", "--max-turns", "8", "--timeout", "10m",
      "--max-cost-usd", "1.50"
    ])).toMatchObject({
      kind: "print", outputFormat: "stream-json",
      runLimits: { maxTurns: 8, timeoutMs: 600_000, maxCostUsd: 1.5 }
    });
    expect(parseCli(["-p", "go", "--output-format", "xml"]).kind).toBe("error");
    expect(parseCli(["-p", "go", "--timeout", "soon"]).kind).toBe("error");
    expect(parseCli(["--max-turns", "2"]).kind).toBe("error");
  });

  it("accepts project configuration trust only in print mode", () => {
    expect(parseCli(["-p", "--trust-project-config", "hi"])).toMatchObject({ kind: "print", trustProjectConfig: true });
    expect(parseCli(["--trust-project-config"])).toMatchObject({ kind: "error" });
  });

  it("parses print mode without a prompt (stdin case)", () => {
    expect(parseCli(["-p"])).toMatchObject({ kind: "print", prompt: undefined });
  });

  it("accepts a valid --permission-mode with print", () => {
    expect(parseCli(["-p", "x", "--permission-mode", "acceptEdits"]))
      .toMatchObject({ kind: "print", permissionMode: "acceptEdits" });
  });

  it("rejects an invalid --permission-mode", () => {
    expect(parseCli(["-p", "x", "--permission-mode", "yolo"]).kind).toBe("error");
  });

  it("rejects --permission-mode without --print", () => {
    expect(parseCli(["--permission-mode", "acceptEdits"]).kind).toBe("error");
  });

  it("rejects --resume with --print", () => {
    expect(parseCli(["-p", "x", "-r"]).kind).toBe("error");
  });

  it("rejects positionals in interactive mode and extras in print mode", () => {
    expect(parseCli(["-c", "stray"]).kind).toBe("error");
    expect(parseCli(["-p", "one", "two"]).kind).toBe("error");
  });
});

describe("HELP_TEXT", () => {
  it("mentions every flag and subcommand", () => {
    for (const s of ["--help", "--version", "--continue", "--resume", "--print",
      "--provider", "--network-mode", "--permission-mode", "--output-format", "--max-turns", "--timeout",
      "--max-cost-usd", "doctor", "config", "mcp", "update", "task"]) {
      expect(HELP_TEXT).toContain(s);
    }
  });
});
