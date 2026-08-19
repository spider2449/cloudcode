import { describe, expect, it, vi } from "vitest";
import { createMaintenanceExecutor } from "../src/commands/cli/maintenanceExecutor.js";
import type { MaintenanceProfile } from "../src/agent/maintenanceConfig.js";

const profile: MaintenanceProfile = {
  name: "health", prompt: "inspect", execution: "analysis", limits: { maxTurns: 2 },
  networkMode: "providerOnly", source: "builtin"
};

describe("maintenance executor", () => {
  it("runs analysis with only read/search/LSP tools and captures structured evidence", async () => {
    const runPrintFn = vi.fn(async (options, io) => {
      io.out(JSON.stringify({ schemaVersion: 1, sessionId: "s1", event: { kind: "assistant.text_delta", text: "report" } }) + "\n");
      return 0;
    });
    const execute = createMaintenanceExecutor({ providerName: "local", provider: {}, runPrintFn });
    const output = await execute(profile, { cwd: "/project", trustProjectConfig: false });
    expect(output).toMatchObject({ exitCode: 0, report: "report", sessionId: "s1" });
    expect(runPrintFn).toHaveBeenCalledWith(expect.objectContaining({
      disableMcp: true, toolAllowlist: expect.arrayContaining(["Read", "Diagnostics"])
    }), expect.anything());
    const passed = runPrintFn.mock.calls[0][0];
    expect(passed.toolAllowlist).not.toEqual(expect.arrayContaining(["Write", "Edit", "Bash"]));
  });

  it("keeps saved offlineStrict policy when a profile permits providerOnly", async () => {
    const runPrintFn = vi.fn(async () => 7);
    const execute = createMaintenanceExecutor({
      providerName: "remote", provider: {}, savedNetworkMode: "offlineStrict", runPrintFn
    });
    await execute(profile, { cwd: "/project", trustProjectConfig: false });
    expect(runPrintFn.mock.calls[0][0].networkMode).toBe("offlineStrict");
  });
});
