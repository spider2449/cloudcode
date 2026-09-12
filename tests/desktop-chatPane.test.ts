import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { applySuggestionText, busyLabel, describeSlashInput, echoUserBubble, isLiveTurnEvent, isNewSessionEvent, parseSessionIdEvent, shouldStickToBottom, STICK_THRESHOLD_PX, titleForCompletionPrefix, visibleCompletions } from "../desktop/renderer/chatPane.js";

describe("slash input classification", () => {
  it("treats plain text as non-slash", () => {
    expect(describeSlashInput("hi")).toEqual({ kind: "plain" });
    expect(describeSlashInput("")).toEqual({ kind: "plain" });
    expect(describeSlashInput("github")).toEqual({ kind: "plain" });
  });
  it("completes command names while typing", () => {
    expect(describeSlashInput("/")).toEqual({ kind: "command", token: "/" });
    expect(describeSlashInput("/con")).toEqual({ kind: "command", token: "/con" });
  });
  it("jumps to argument options once the command name is exact", () => {
    expect(describeSlashInput("/config")).toEqual({ kind: "args", prefix: "/config " });
    expect(describeSlashInput("/model")).toEqual({ kind: "args", prefix: "/model " });
  });
  it("treats menu-bar-only commands as plain command tokens in the input", () => {
    // /theme is hidden from the desktop registry (View > Theme instead).
    expect(describeSlashInput("/theme")).toEqual({ kind: "command", token: "/theme" });
  });
  it("keeps completing arguments after the first space", () => {
    expect(describeSlashInput("/config th")).toEqual({ kind: "args", prefix: "/config th" });
    expect(describeSlashInput("/model a-model")).toEqual({ kind: "args", prefix: "/model a-model" });
  });
});

describe("user bubble echo", () => {
  it("echoes plain prompts but not executed slash commands", () => {
    expect(echoUserBubble("hello")).toBe(true);
    expect(echoUserBubble("/permissions bypassPermissions")).toBe(false);
    expect(echoUserBubble("/cost")).toBe(false);
  });
});

describe("transcript stickiness", () => {
  it("sticks only near the bottom", () => {
    expect(shouldStickToBottom(1000, 960, 100)).toBe(true);
    expect(shouldStickToBottom(1000, 500, 100)).toBe(false);
    expect(STICK_THRESHOLD_PX).toBeGreaterThan(0);
  });
});

describe("turn event ownership", () => {
  it("applies own and history deltas, drops background-session deltas", () => {
    expect(isLiveTurnEvent("turn-1", ["turn-1"])).toBe(true);
    expect(isLiveTurnEvent("history-1-2", [])).toBe(true);
    expect(isLiveTurnEvent("other-turn", ["turn-1"])).toBe(false);
    expect(isLiveTurnEvent("other-turn", [])).toBe(false);
  });
});

describe("suggestion application", () => {
  it("replaces only the option token, preserving the command prefix", () => {
    expect(applySuggestionText("/model a-m", { value: "a-model", replaceStart: 7, replaceEnd: 10 })).toBe("/model a-model");
    expect(applySuggestionText("/config ", { value: "provider", replaceStart: 8, replaceEnd: 8 })).toBe("/config provider");
  });
  it("detects pure echoes that should descend or hide", () => {
    const echo = { value: "theme", replaceStart: 8, replaceEnd: 13 };
    expect(applySuggestionText("/config theme", echo)).toBe("/config theme");
    const nested = { value: "theme dark", replaceStart: 8, replaceEnd: 14 };
    expect(applySuggestionText("/config theme ", nested)).toBe("/config theme dark");
  });
});

describe("new session events", () => {
  it("recognizes the backend new-session signal", () => {
    expect(isNewSessionEvent({ type: "new_session" })).toBe(true);
    expect(isNewSessionEvent({ type: "done" })).toBe(false);
    expect(isNewSessionEvent({ type: "notice" })).toBe(false);
  });
});

describe("session id events", () => {
  it("extracts the backend session id for adoption", () => {
    expect(parseSessionIdEvent({ type: "session_id", sessionId: "sess-9" })).toBe("sess-9");
    expect(parseSessionIdEvent({ type: "done" })).toBeUndefined();
    expect(parseSessionIdEvent({ type: "session_id" })).toBeUndefined();
    expect(parseSessionIdEvent({ type: "session_id", sessionId: "" })).toBeUndefined();
    expect(parseSessionIdEvent({ type: "session_id", sessionId: 42 })).toBeUndefined();
  });
});

describe("busy label", () => {
  it("shows Thinking while turns are in flight, nothing when idle", () => {
    expect(busyLabel(0)).toBeNull();
    expect(busyLabel(1)).toBe("Thinking");
    expect(busyLabel(3)).toBe("Thinking");
  });
});

describe("completion visibility", () => {
  it("drops blank rows that would render as empty buttons", () => {
    const items = [
      { label: "/config", value: "/config ", replaceStart: 0, replaceEnd: 7 },
      { label: "   ", value: "x", replaceStart: 8, replaceEnd: 8 },
      { label: "", value: "", replaceStart: 8, replaceEnd: 8 },
    ];
    expect(visibleCompletions(items)).toEqual([items[0]]);
  });
  it("keeps every well-formed option", () => {
    const items = [
      { label: "theme", value: "theme", replaceStart: 8, replaceEnd: 8 },
      { label: "provider", value: "provider", replaceStart: 8, replaceEnd: 8 },
    ];
    expect(visibleCompletions(items)).toEqual(items);
  });
});

describe("completion title", () => {
  it("titles argument options with their command", () => {
    expect(titleForCompletionPrefix("/config ")).toBe("/config");
    expect(titleForCompletionPrefix("/model a")).toBe("/model");
  });
  it("keeps the generic title for command-name lists and plain text", () => {
    expect(titleForCompletionPrefix("/con")).toBe("Commands");
    expect(titleForCompletionPrefix("/")).toBe("Commands");
    expect(titleForCompletionPrefix("hello")).toBe("Commands");
    expect(titleForCompletionPrefix("")).toBe("Commands");
  });
});

describe("completion dropdown shell", () => {
  it("clears the stale command list when entering argument mode", () => {
    // Typing "/config" exactly normalizes to "/config " and asks the backend
    // for args; the stale "/config" self-suggestion must be dropped now,
    // not left flashing until the slower backend answers.
    const pane = readFileSync("desktop/renderer/chatPane.tsx", "utf8");
    const argsBlock = pane.slice(pane.indexOf('completionSource.current === "commands"'));
    expect(argsBlock).toContain("showCompletions([])");
    expect(pane).toContain("data-title={completionTitle}");
  });
  it("renders the header from state and keeps Thinking clear of the list", () => {
    const css = readFileSync("desktop/renderer/style.css", "utf8");
    expect(css).toContain("content: attr(data-title)");
    expect(css).toContain(".chat-pane.has-complete .chat-busy-floating");
  });
});
