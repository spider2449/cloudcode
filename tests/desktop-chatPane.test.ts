import { describe, expect, it } from "vitest";
import { applySuggestionText, describeSlashInput, isNewSessionEvent, parseSessionIdEvent } from "../desktop/renderer/chatPane.js";

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
    expect(describeSlashInput("/theme")).toEqual({ kind: "args", prefix: "/theme " });
  });
  it("keeps completing arguments after the first space", () => {
    expect(describeSlashInput("/config th")).toEqual({ kind: "args", prefix: "/config th" });
    expect(describeSlashInput("/theme github")).toEqual({ kind: "args", prefix: "/theme github" });
  });
});

describe("suggestion application", () => {
  it("replaces only the option token, preserving the command prefix", () => {
    expect(applySuggestionText("/theme gi", { value: "github", replaceStart: 7, replaceEnd: 9 })).toBe("/theme github");
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
