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
      kind: "print", prompt: "fix it", continue: false, provider: undefined, permissionMode: "default"
    });
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
      "--provider", "--permission-mode", "doctor", "config", "mcp", "update"]) {
      expect(HELP_TEXT).toContain(s);
    }
  });
});
