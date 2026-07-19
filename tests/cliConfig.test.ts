import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configReport } from "../src/commands/cli/config.js";

const dir = () => mkdtempSync(join(tmpdir(), "cliconfig-"));

describe("configReport", () => {
  it("shows defaults when no settings file exists", () => {
    const d = dir();
    const report = configReport(d);
    expect(report).toContain(join(d, "settings.json"));
    expect(report).toContain(join(d, "providers.json"));
    expect(report).toContain(join(d, "mcp.json"));
    expect(report).toContain("anthropic (default)");
    expect(report).toContain("permissionMode:  default");
  });

  it("shows saved settings", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"), JSON.stringify({
      provider: "local", model: "claude-sonnet-5", permissionMode: "acceptEdits",
      effort: "high", theme: "light", autoMemoryEnabled: false
    }));
    const report = configReport(d);
    expect(report).toContain("provider:        local");
    expect(report).toContain("model:           claude-sonnet-5");
    expect(report).toContain("permissionMode:  acceptEdits");
    expect(report).toContain("effort:          high");
    expect(report).toContain("theme:           light");
    expect(report).toContain("autoMemory:      disabled");
  });
});
