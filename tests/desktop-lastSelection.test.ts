import { describe, expect, it } from "vitest";
import {
  LAST_SELECTION_KEY,
  loadStoredSelection,
  parseStoredSelection,
  resolveRestoredSelection,
  serializeSelection
} from "../desktop/renderer/lastSelection.js";

const workspaces = [
  { id: "w1", sessions: [{ id: "s1" }, { id: "s2" }] },
  { id: "w2", sessions: [{ id: "s3" }] }
];

describe("parseStoredSelection", () => {
  it("parses a full pair and an anonymous (null session) pair", () => {
    expect(parseStoredSelection('{"workspaceId":"w1","sessionId":"s2"}')).toEqual({ workspaceId: "w1", sessionId: "s2" });
    expect(parseStoredSelection('{"workspaceId":"w1","sessionId":null}')).toEqual({ workspaceId: "w1", sessionId: null });
  });

  it("returns undefined for missing or malformed input", () => {
    expect(parseStoredSelection(null)).toBeUndefined();
    expect(parseStoredSelection("")).toBeUndefined();
    expect(parseStoredSelection("{bad")).toBeUndefined();
    expect(parseStoredSelection("[]")).toBeUndefined();
    expect(parseStoredSelection('{"workspaceId":123,"sessionId":null}')).toBeUndefined();
    expect(parseStoredSelection('{"workspaceId":"w1"}')).toBeUndefined();
    expect(parseStoredSelection('{"workspaceId":"","sessionId":null}')).toBeUndefined();
    expect(parseStoredSelection('{"workspaceId":"w1","sessionId":42}')).toBeUndefined();
  });
});

describe("loadStoredSelection", () => {
  it("parses what the reader returns and swallows reader errors", () => {
    expect(loadStoredSelection(() => '{"workspaceId":"w1","sessionId":"s1"}')).toEqual({ workspaceId: "w1", sessionId: "s1" });
    expect(loadStoredSelection(() => { throw new Error("denied"); })).toBeUndefined();
  });
});

describe("resolveRestoredSelection", () => {
  it("matches today's behavior when nothing was stored", () => {
    expect(resolveRestoredSelection(workspaces, undefined)).toEqual({
      active: "w1",
      activeSessions: { w1: "s1", w2: "s3" }
    });
  });

  it("restores the remembered pair, leaving other workspaces on defaults", () => {
    expect(resolveRestoredSelection(workspaces, { workspaceId: "w2", sessionId: "s3" })).toEqual({
      active: "w2",
      activeSessions: { w1: "s1", w2: "s3" }
    });
  });

  it("restores an anonymous selection as undefined", () => {
    expect(resolveRestoredSelection(workspaces, { workspaceId: "w2", sessionId: null })).toEqual({
      active: "w2",
      activeSessions: { w1: "s1", w2: undefined }
    });
  });

  it("falls back when the workspace or session is gone", () => {
    expect(resolveRestoredSelection(workspaces, { workspaceId: "gone", sessionId: "s1" })).toEqual({
      active: "w1",
      activeSessions: { w1: "s1", w2: "s3" }
    });
    expect(resolveRestoredSelection(workspaces, { workspaceId: "w1", sessionId: "deleted" })).toEqual({
      active: "w1",
      activeSessions: { w1: "s1", w2: "s3" }
    });
  });

  it("handles an empty workspace list", () => {
    expect(resolveRestoredSelection([], undefined)).toEqual({ active: undefined, activeSessions: {} });
    expect(resolveRestoredSelection([], { workspaceId: "w1", sessionId: "s1" })).toEqual({ active: undefined, activeSessions: {} });
  });
});

describe("serializeSelection", () => {
  it("round-trips through parse, including the nothing-open case", () => {
    expect(parseStoredSelection(serializeSelection("w1", { w1: "s2" }))).toEqual({ workspaceId: "w1", sessionId: "s2" });
    expect(parseStoredSelection(serializeSelection("w1", {}))).toEqual({ workspaceId: "w1", sessionId: null });
    expect(parseStoredSelection(serializeSelection(undefined, {}))).toBeUndefined();
  });

  it("uses the documented storage key", () => {
    expect(LAST_SELECTION_KEY).toBe("cloudcode.lastSelection");
  });
});
