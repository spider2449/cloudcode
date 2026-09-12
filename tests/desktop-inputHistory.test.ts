import { describe, expect, it } from "vitest";
import {
  emptyHistoryNav,
  MAX_INPUT_HISTORY,
  pushInputHistoryEntry,
  recallHistoryBack,
  recallHistoryForward,
  resetHistoryNav,
  shouldRecallHistory,
} from "../desktop/renderer/inputHistory.js";

describe("pushInputHistoryEntry", () => {
  it("trims and ignores empty input", () => {
    expect(pushInputHistoryEntry([], "  ")).toEqual([]);
    expect(pushInputHistoryEntry(["a"], "  b  ")).toEqual(["a", "b"]);
  });
  it("dedupes consecutive repeats", () => {
    expect(pushInputHistoryEntry(["a"], "a")).toEqual(["a"]);
    expect(pushInputHistoryEntry(["a"], "b")).toEqual(["a", "b"]);
  });
  it("caps to the most recent entries", () => {
    const full = Array.from({ length: MAX_INPUT_HISTORY }, (_, i) => `m${i}`);
    const next = pushInputHistoryEntry(full, "new");
    expect(next).toHaveLength(MAX_INPUT_HISTORY);
    expect(next[next.length - 1]).toBe("new");
    expect(next[0]).toBe("m1");
  });
});

describe("history recall", () => {
  it("walks back then forward, restoring the draft at the end", () => {
    const entries = ["first", "second"];
    let nav = { ...emptyHistoryNav(), entries, cursor: entries.length };
    const up1 = recallHistoryBack(nav, "draft");
    expect(up1?.text).toBe("second");
    nav = up1!.nav;
    const up2 = recallHistoryBack(nav, "ignored");
    expect(up2?.text).toBe("first");
    // Draft is stashed only once (the original live input).
    expect(up2?.nav.draft).toBe("draft");
    nav = up2!.nav;
    expect(recallHistoryBack(nav, "first")).toBeUndefined();
    const down1 = recallHistoryForward(nav);
    expect(down1?.text).toBe("second");
    const down2 = recallHistoryForward(down1!.nav);
    expect(down2?.text).toBe("draft");
    expect(down2?.nav.draft).toBeUndefined();
    expect(recallHistoryForward(down2!.nav)).toBeUndefined();
  });
  it("restores an empty input when there was no draft", () => {
    const nav = { ...emptyHistoryNav(), entries: ["only"], cursor: 1 };
    const up = recallHistoryBack(nav, "");
    expect(up?.text).toBe("only");
    expect(recallHistoryForward(up!.nav)?.text).toBe("");
  });
  it("returns undefined with no entries", () => {
    const nav = emptyHistoryNav();
    expect(recallHistoryBack(nav, "x")).toBeUndefined();
    expect(recallHistoryForward(nav)).toBeUndefined();
  });
  it("resetHistoryNav re-pins the cursor and drops the draft", () => {
    const nav = { entries: ["a"], cursor: 0, draft: "d" };
    expect(resetHistoryNav(nav)).toEqual({ entries: ["a"], cursor: 1, draft: undefined });
  });
});

describe("shouldRecallHistory", () => {
  it("recalls on single-line input", () => {
    expect(shouldRecallHistory("hello", 5, 5, "up")).toBe(true);
    expect(shouldRecallHistory("hello", 5, 5, "down")).toBe(true);
  });
  it("keeps native caret motion inside multi-line text", () => {
    const value = "line1\nline2";
    // Caret on second line: Up moves the caret, it does not recall.
    expect(shouldRecallHistory(value, 8, 8, "up")).toBe(false);
    // Caret on first line: Up recalls.
    expect(shouldRecallHistory(value, 2, 2, "up")).toBe(true);
    // Caret on first line: Down moves the caret, it does not recall.
    expect(shouldRecallHistory(value, 2, 2, "down")).toBe(false);
    // Caret on last line: Down recalls.
    expect(shouldRecallHistory(value, 8, 8, "down")).toBe(true);
  });
  it("never recalls with a range selection", () => {
    expect(shouldRecallHistory("hello", 1, 3, "up")).toBe(false);
    expect(shouldRecallHistory("hello", 1, 3, "down")).toBe(false);
  });
});
