import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildRegistry } from "../src/commands/builtins.js";

describe("desktop shell split", () => {
  it("preload exposes chat IPC and no terminal IPC", () => {
    const source = readFileSync("desktop/preload.cjs", "utf8");
    expect(source).toContain("chatSend");
    expect(source).toContain("chatRespond");
    expect(source).toContain("onChatEvent");
    expect(source).not.toContain("startTerminal");
    expect(source).not.toContain("drainTerminal");
  });
  it("main spawns the gui server, not a pty", () => {
    const source = readFileSync("desktop/main.mjs", "utf8");
    expect(source).toContain("--gui-server");
    expect(source).not.toContain("node-pty");
    expect(source).not.toContain("pty.spawn");
  });
});

describe("slash parity", () => {
  it("every GUI-visible command is reachable from the chat autocomplete", () => {
    const source = readFileSync("desktop/renderer/chatPane.tsx", "utf8");
    const registry = buildRegistry({ ...process.env, CLOUDCODE_DESKTOP: "1" });
    expect(registry.size).toBeGreaterThan(0);
    for (const name of registry.keys()) {
      expect(source, `/${name} missing from chat autocomplete`).toContain(`/${name}`);
    }
  });
});
