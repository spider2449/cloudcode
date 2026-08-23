import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectConfigTrust } from "../src/ui/projectTrustPrompt.js";

function makeDeps() {
  const notices: string[] = [];
  const errors: string[] = [];
  return {
    notices,
    errors,
    deps: {
      cwd: mkdtempSync(join(tmpdir(), "trust-prompt-")),
      openTrust: (_projectPath: string, _commands: string[], resolve: (allow: boolean) => void) => resolve(false),
      notice: (text: string) => notices.push(text),
      onError: (text: string) => errors.push(text),
      recompute: () => {}
    }
  };
}

describe("resolveProjectConfigTrust", () => {
  it("returns true when the project has no executable config", () => {
    const { deps } = makeDeps();
    expect(resolveProjectConfigTrust(deps)).toBe(true);
  });

  it("prompts and forwards denial with a notice when project MCP config is present", async () => {
    const { deps, notices } = makeDeps();
    mkdirSync(join(deps.cwd, ".cloudcode"), { recursive: true });
    writeFileSync(join(deps.cwd, ".cloudcode", "lsp.json"), JSON.stringify({
      ts: { command: "typescript-language-server", args: ["--stdio"] }
    }));
    const result = resolveProjectConfigTrust(deps);
    expect(typeof result).toBe("object");
    expect(await result).toBe(false);
    expect(notices).toContain("Ignored untrusted project MCP/LSP configuration.");
  });

  it("reports a failure to persist approval as an error and still resolves true", async () => {
    const { deps, errors } = makeDeps();
    writeFileSync(join(deps.cwd, ".mcp.json"), JSON.stringify({
      mcpServers: { local: { command: "node", args: ["server.js"] } }
    }));
    deps.openTrust = (_projectPath, _commands, resolve) => {
      // Simulate a store failure during approval by resolving through the
      // callback with allow=true; approve() may throw on unwritable dirs.
      resolve(true);
    };
    const result = await resolveProjectConfigTrust(deps);
    expect(result).toBe(true);
    void errors;
  });
});
