import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWelcome } from "../src/ui/welcome.js";

const vars = { version: "0.1.0", provider: "anthropic", model: "claude-sonnet-5" };

function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "welcome-"));
  const file = join(dir, "welcome.txt");
  writeFileSync(file, content);
  return file;
}

describe("loadWelcome", () => {
  it("substitutes placeholders", () => {
    const file = tmpFile("cloudcode {version} — {provider} ({model})");
    expect(loadWelcome(vars, file)).toBe("cloudcode 0.1.0 — anthropic (claude-sonnet-5)");
  });

  it("leaves unknown placeholders as-is", () => {
    const file = tmpFile("hello {nope}");
    expect(loadWelcome(vars, file)).toBe("hello {nope}");
  });

  it("uses empty string for undefined model", () => {
    const file = tmpFile("model: {model}");
    expect(loadWelcome({ version: "1", provider: "p" }, file)).toBe("model: ");
  });

  it("preserves multi-line content and trims trailing newline", () => {
    const file = tmpFile("line one\nline two\n");
    expect(loadWelcome(vars, file)).toBe("line one\nline two");
  });

  it("returns undefined when file is missing", () => {
    expect(loadWelcome(vars, join(tmpdir(), "does-not-exist", "welcome.txt"))).toBeUndefined();
  });

  it("reads the package-root welcome.txt by default", () => {
    const text = loadWelcome(vars);
    expect(text).toBeTruthy();
    expect(text).not.toContain("{version}");
  });
});
