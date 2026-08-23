import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoginCommand } from "../src/commands/cli/login.js";

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

function makeDeps(overrides: Partial<Parameters<typeof runLoginCommand>[1]> = {}) {
  const configBase = mkdtempSync(join(tmpdir(), "login-cmd-"));
  const deps = {
    configBase,
    networkMode: "unrestricted" as const,
    promptText: (async () => "paste-code") as (label: string) => Promise<string>,
    openBrowser: (() => {}) as (url: string) => void,
    fetchImpl: (async () => okResponse({
      access_token: "at", refresh_token: "rt", expires_in: 3600
    })) as never,
    ...overrides
  };
  return { configBase, deps };
}

describe("runLoginCommand", () => {
  it("prints the authorize URL, exchanges the pasted code, and saves", async () => {
    const { deps, configBase } = makeDeps();
    const result = await runLoginCommand(["login"], deps);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(configBase, "credentials.json"))).toBe(true);
    const { loadOwnCredentials } = await import("../src/agent/oauth.js");
    expect(loadOwnCredentials(configBase)?.accessToken).toBe("at");
  });

  it("refuses under providerOnly with widening guidance", async () => {
    const { deps } = makeDeps();
    const result = await runLoginCommand(["login"], { ...deps, networkMode: "providerOnly" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--network-mode unrestricted");
  });

  it("status reports logged-in expiry", async () => {
    const { deps } = makeDeps();
    await runLoginCommand(["login"], deps);
    const result = await runLoginCommand(["status"], deps);
    expect(result.stdout).toContain("Logged in via claude.ai OAuth");
  });

  it("logout removes stored credentials", async () => {
    const { deps, configBase } = makeDeps();
    await runLoginCommand(["login"], deps);
    await runLoginCommand(["logout"], deps);
    expect(existsSync(join(configBase, "credentials.json"))).toBe(false);
    const status = await runLoginCommand(["status"], deps);
    expect(status.stdout).toContain("Not logged in");
  });
});
