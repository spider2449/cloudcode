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
  it("main never writes to the backend pipe unguarded", () => {
    const source = readFileSync("desktop/main.mjs", "utf8");
    expect(source).toContain("writeChatBackend");
    const bare = source.split("\n").filter(line => line.includes("chatChild?.stdin.write"));
    expect(bare).toHaveLength(1);
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
  it("chat requests carry the workspace so the backend runs in the right directory", () => {
    const pane = readFileSync("desktop/renderer/chatPane.tsx", "utf8");
    expect(pane).toContain("workspaceId");
    const main = readFileSync("desktop/main.mjs", "utf8");
    expect(main).toContain("host.cwd(");
  });
  it("argument completion round-trips through the backend and preserves the prefix", () => {    const pane = readFileSync("desktop/renderer/chatPane.tsx", "utf8");
    expect(pane).toContain("chatComplete");
    expect(pane).toContain("replaceStart");
    const main = readFileSync("desktop/main.mjs", "utf8");
    expect(main).toContain("chat-complete");
    // The renderer sends kind-less completion requests; main must stamp the
    // kind or the backend routes keystrokes into the turn pipeline as
    // text-less messages ("Invalid chat text." per keystroke).
    const completeBlock = main.slice(main.indexOf("chat-complete"));
    expect(completeBlock).toContain('kind: "complete"');
    const cli = readFileSync("src/cli.tsx", "utf8");
    expect(cli).toContain('kind === "complete"');
    const preload = readFileSync("desktop/preload.cjs", "utf8");
    expect(preload).toContain("chatComplete");
  });
  it("dropdown is scrollable and keyboard-operable", () => {
    const css = readFileSync("desktop/renderer/style.css", "utf8");
    expect(css).toContain(".slash-complete");
    expect(css).toContain("overflow-y: auto");
    expect(css).toContain("max-height");
    const pane = readFileSync("desktop/renderer/chatPane.tsx", "utf8");
    expect(pane).toContain("ArrowDown");
    expect(pane).toContain("ArrowUp");
    expect(pane).toContain('"Tab"');
    expect(pane).toContain("Escape");
  });
  it("composer is multiline with IME-safe submit", () => {
    const pane = readFileSync("desktop/renderer/chatPane.tsx", "utf8");
    expect(pane).toContain("<textarea");
    expect(pane).toContain("onCompositionStart");
    expect(pane).toContain("isComposing");
    const css = readFileSync("desktop/renderer/style.css", "utf8");
    expect(css).toContain(".chat-input textarea");
  });
  it("composer buttons follow the theme", () => {
    const pane = readFileSync("desktop/renderer/chatPane.tsx", "utf8");
    expect(pane).toContain("chat-send");
    expect(pane).toContain("chat-stop");
    const css = readFileSync("desktop/renderer/style.css", "utf8");
    expect(css).toContain(".chat-input .chat-send");
    expect(css).toContain(".chat-input .chat-stop");
  });
});
