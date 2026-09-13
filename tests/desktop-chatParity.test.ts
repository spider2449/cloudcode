import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildRegistry } from "../src/commands/builtins.js";
import { GUI_SLASH_NAMES } from "../src/commands/guiSlashNames.js";

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
    const bare = source.split("\n").filter(line => line.includes("chatChild?.stdin.write") || line.includes("chatChild.stdin.write"));
    expect(bare).toHaveLength(1);
  });
  it("main survives backend death on close without an EPIPE dialog", () => {
    const source = readFileSync("desktop/main.mjs", "utf8");
    // Async EPIPE from a dead child's stdin is an 'error' event, not a sync
    // throw: without a listener Electron shows an Uncaught Exception dialog.
    expect(source).toContain('stdin.on("error"');
    expect(source).toContain('chatChild.on("error"');
    // Late renderer polls (statusline footer) must not respawn the backend
    // or write to a dying pipe during shutdown.
    expect(source).toContain("quitting");
    expect(source).toContain("before-quit");
  });
});

describe("slash parity", () => {
  it("every GUI-visible command is reachable from the chat autocomplete", () => {
    const source = readFileSync("desktop/renderer/chatPane.tsx", "utf8");
    const registry = buildRegistry({ ...process.env, CLOUDCODE_DESKTOP: "1" });
    expect(registry.size).toBeGreaterThan(0);
    // Browser-safe static list (chatPane must not import buildRegistry —
    // that pulls node:* into the Vite bundle). Pinned equal to the registry
    // so the two can never drift.
    expect([...GUI_SLASH_NAMES].sort()).toEqual([...registry.keys()].sort());
    for (const name of registry.keys()) {
      expect(source, `/${name} missing from chat autocomplete`).toContain(`/${name}`);
    }
    // No node-only command surface in the browser bundle.
    expect(source).not.toContain("commands/builtins.js");
  });
  it("renderer stays browser-safe: no node:* or backend imports in the Vite bundle", () => {
    // Regression guard for vite "externalized for browser compatibility"
    // warnings: renderer must use builtinThemes/guiSlashNames (pure), never
    // the node-backed theme.js / builtins.js / src/agent.
    const files = ["chatPane.tsx", "themeMenu.tsx", "themeState.ts", "statusBar.tsx", "src.tsx"];
    for (const file of files) {
      const source = readFileSync(`desktop/renderer/${file}`, "utf8");
      expect(source, `${file} must not import node: builtins`).not.toMatch(/from ["']node:/);
      expect(source, `${file} must not import backend commands`).not.toContain("commands/builtins.js");
      expect(source, `${file} must not import src/agent`).not.toContain("src/agent/");
    }
    expect(readFileSync("desktop/renderer/themeState.ts", "utf8")).toContain("ui/builtinThemes.js");
    expect(readFileSync("desktop/renderer/themeMenu.tsx", "utf8")).toContain("ui/builtinThemes.js");
    expect(readFileSync("desktop/renderer/chatPane.tsx", "utf8")).toContain("commands/guiSlashNames.js");
    expect(readFileSync("src/ui/builtinThemes.ts", "utf8")).not.toMatch(/from ["']node:/);
    expect(readFileSync("src/commands/guiSlashNames.ts", "utf8")).not.toMatch(/from ["']node:/);
  });
  it("desktop theme switching lives in the titlebar menu with preview semantics, not the input", () => {
    // Browsing previews without saving; only Enter persists via the backend.
    const menu = readFileSync("desktop/renderer/themeMenu.tsx", "utf8");
    expect(menu).toContain("previewGuiTheme");
    expect(menu).toContain("getConfirmedGuiTheme");
    expect(menu).toContain("setTheme");
    expect(menu).toContain("Escape");
    const themeState = readFileSync("desktop/renderer/themeState.ts", "utf8");
    expect(themeState).toContain("previewGuiTheme");
    expect(themeState).toContain("confirmGuiTheme");
    expect(themeState).toContain("getConfirmedGuiTheme");
    const main = readFileSync("desktop/main.mjs", "utf8");
    expect(main).toContain("cloudcode:set-theme");
    expect(main).toContain('kind: "theme-set"');
    const preload = readFileSync("desktop/preload.cjs", "utf8");
    expect(preload).toContain("setTheme");
    const backend = readFileSync("src/desktop/guiBackend.ts", "utf8");
    expect(backend).toContain('kind === "theme-set"');
    const pane = readFileSync("desktop/renderer/chatPane.tsx", "utf8");
    expect(pane).toContain("confirmGuiTheme");
    const css = readFileSync("desktop/renderer/style.css", "utf8");
    expect(css).toContain(".theme-menu");
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
    const backend = readFileSync("src/desktop/guiBackend.ts", "utf8");
    expect(backend).toContain('kind === "complete"');
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
  it("statusline footer mirrors the TUI segments with backend polling", () => {
    const bar = readFileSync("desktop/renderer/statusBar.tsx", "utf8");
    expect(bar).toContain("formatStatusSegments");
    expect(bar).toContain("StatuslinePicker");
    const shell = readFileSync("desktop/renderer/src.tsx", "utf8");
    expect(shell).toContain("chatStatus");
    expect(shell).toContain("chatStatusLineSet");
    expect(shell).toContain("statusline_picker");
    expect(shell).toContain("<StatusBar");
    const main = readFileSync("desktop/main.mjs", "utf8");
    expect(main).toContain("chat-status");
    expect(main).toContain('kind: "status"');
    expect(main).toContain('kind: "statusline-set"');
    const preload = readFileSync("desktop/preload.cjs", "utf8");
    expect(preload).toContain("chatStatus");
    expect(preload).toContain("chatStatusLineSet");
    const backend = readFileSync("src/desktop/guiBackend.ts", "utf8");
    expect(backend).toContain('kind === "status"');
    expect(backend).toContain('kind === "statusline-set"');
    expect(backend).toContain("emitStatusLinePicker");
    const css = readFileSync("desktop/renderer/style.css", "utf8");
    expect(css).toContain(".statusline");
    // The footer is a second app-shell grid row: row-1 children must not
    // carry a fixed 100vh height or they cover the footer (input overlap).
    const chatMain = css.match(/\.chat-main \{[^}]*\}/)?.[0] ?? "";
    expect(chatMain).not.toContain("height: 100vh");
    expect(chatMain).toContain("min-height: 0");
  });
  it("interrupted turns always settle: ESC aborts, abort denies prompts, backend death resets", () => {
    const pane = readFileSync("desktop/renderer/chatPane.tsx", "utf8");
    // TUI parity: Esc interrupts the running turn (IME-composing exempt).
    // Window-level (not textarea-level): focus is usually on Send or the
    // transcript while a turn runs, so a textarea handler never fires.
    expect(pane).toContain('"Escape"');
    expect(pane).toContain("pendingIds[pendingIds.length - 1]");
    expect(pane).toContain('addEventListener("keydown"');
    expect(pane).toContain('closest?.(".chat-pane")');
    // Backend death must clear local pending/prompt state, or later Sends
    // are silently swallowed with no response and no error.
    expect(pane).toContain('event.id === "backend"');
    // Aborting drops the dead prompt for that turn.
    expect(pane).toContain("permissionRef");
    const backend = readFileSync("src/desktop/guiBackend.ts", "utf8");
    // Abort denies the outstanding permission first: the loop awaits
    // requestPermission with no abort awareness, so interrupt() alone wedges.
    expect(backend).toContain("pendingPermission.get(request.id)?.(false)");
    // Slash-initiated turns are tracked (streamed, can pop permission).
    expect(backend).toContain("runSlashPrompt");
  });
  it("session switches resurface background turns instead of erroring", () => {
    // Backend tags status with the running turn id; the pane reseeds its
    // pending state from it, so a switch-back shows Thinking + Stop rather
    // than failing the next send with "already running".
    const backend = readFileSync("src/desktop/guiBackend.ts", "utf8");
    expect(backend).toContain("inFlightId");
    const pane = readFileSync("desktop/renderer/chatPane.tsx", "utf8");
    expect(pane).toContain("chatStatus");
    expect(pane).toContain("inFlightId");
    // Background-session deltas must not pollute the transcript on screen.
    expect(pane).toContain("isLiveTurnEvent");
  });
  it("busy sessions are marked and repo switches warn (repo isolation)", () => {
    const shell = readFileSync("desktop/renderer/src.tsx", "utf8");
    expect(shell).toContain("busyTurns");
    expect(shell).toContain("isSessionBusy");
    expect(shell).toContain("session-busy");
    expect(shell).toContain("Switch projects anyway?");
    const css = readFileSync("desktop/renderer/style.css", "utf8");
    expect(css).toContain(".session-busy");
  });
  it("message roles are visually distinct", () => {
    const css = readFileSync("desktop/renderer/style.css", "utf8");
    expect(css).toContain(".bubble.user");
    expect(css).toContain(".bubble.assistant");
    expect(css).toContain(".bubble.notice");
    expect(css).toContain(".bubble.error");
  });
});
