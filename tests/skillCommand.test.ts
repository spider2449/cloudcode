import { describe, it, expect } from "vitest";
import { buildRegistry } from "../src/commands/builtins.js";
import type { CommandContext } from "../src/commands/types.js";

function fakeCtx(notices: string[]): CommandContext {
  return {
    notice: (t: string) => notices.push(t),
    reloadSkills: () => notices.push("<reload>")
    // remaining members are unused by /skill
  } as unknown as CommandContext;
}

describe("/skill command", () => {
  it("is registered with a description", () => {
    const cmd = buildRegistry().get("skill");
    expect(cmd).toBeDefined();
    expect(cmd!.description).toContain("install");
  });

  it("prints usage for a missing subcommand", async () => {
    const notices: string[] = [];
    await buildRegistry().get("skill")!.run(fakeCtx(notices), "");
    expect(notices[0]).toContain("Usage: /skill");
  });

  it("prints usage for an unknown subcommand", async () => {
    const notices: string[] = [];
    await buildRegistry().get("skill")!.run(fakeCtx(notices), "frobnicate");
    expect(notices[0]).toContain("Usage: /skill");
  });

  it("requires --yes before removing", async () => {
    const notices: string[] = [];
    await buildRegistry().get("skill")!.run(fakeCtx(notices), "remove some--repo");
    expect(notices[0]).toContain("--yes");
  });

  it("completes subcommand names", () => {
    const cmd = buildRegistry().get("skill")!;
    expect(cmd.completeArgs!("in", {} as never)).toEqual(["install"]);
  });
});
