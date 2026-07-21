import { describe, it, expect } from "vitest";
import { checkLspServers } from "../../src/commands/cli/doctor.js";
import { DEFAULT_SERVERS } from "../../src/engine/lsp/defaults.js";

describe("checkLspServers", () => {
  it("reports ok for installed and not-ok for missing servers", () => {
    const checks = checkLspServers(DEFAULT_SERVERS, cmd => cmd === "gopls");
    const go = checks.find(c => c.name.includes("go"));
    const ts = checks.find(c => c.name.includes("typescript"));
    expect(go?.ok).toBe(true);
    expect(ts?.ok).toBe(false);
    expect(ts?.detail).toMatch(/not found/i);
  });
});
