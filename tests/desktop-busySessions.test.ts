import { describe, expect, it } from "vitest";
import {
  countBusyInWorkspace, isSessionBusy, migrateAdoptedSession,
  trackTurnEnd, trackTurnStart, type BusyTurns
} from "../src/desktop/renderer/busySessions.js";

describe("busy session tracking", () => {
  it("marks the sending session busy until its turn ends", () => {
    let turns: BusyTurns = {};
    turns = trackTurnStart(turns, "t1", { workspaceId: "w1", sessionId: "s1" });
    expect(isSessionBusy(turns, "w1", "s1")).toBe(true);
    expect(isSessionBusy(turns, "w1", "s2")).toBe(false);
    expect(isSessionBusy(turns, "w2", "s1")).toBe(false);
    turns = trackTurnEnd(turns, "t1");
    expect(isSessionBusy(turns, "w1", "s1")).toBe(false);
  });
  it("ignores turn ends for unknown ids", () => {
    const turns = trackTurnStart({}, "t1", { workspaceId: "w1", sessionId: "s1" });
    expect(trackTurnEnd(turns, "history-1")).toBe(turns);
  });
  it("keeps anonymous turns marked across adoption", () => {
    let turns: BusyTurns = {};
    turns = trackTurnStart(turns, "t1", { workspaceId: "w1", sessionId: undefined });
    expect(isSessionBusy(turns, "w1", "s9")).toBe(false);
    turns = migrateAdoptedSession(turns, "w1", "s9");
    expect(isSessionBusy(turns, "w1", "s9")).toBe(true);
    expect(migrateAdoptedSession(turns, "w1", "s9")).toBe(turns);
  });
  it("counts only attributable turns in the repo being left", () => {
    let turns: BusyTurns = {};
    turns = trackTurnStart(turns, "t1", { workspaceId: "w1", sessionId: "s1" });
    turns = trackTurnStart(turns, "t2", { workspaceId: "w1", sessionId: "s2" });
    turns = trackTurnStart(turns, "t3", { workspaceId: "w2", sessionId: "s1" });
    turns = trackTurnStart(turns, "t4", { workspaceId: undefined, sessionId: undefined });
    expect(countBusyInWorkspace(turns, "w1")).toBe(2);
    expect(countBusyInWorkspace(turns, "w2")).toBe(1);
    expect(countBusyInWorkspace(turns, undefined)).toBe(0);
  });
});
