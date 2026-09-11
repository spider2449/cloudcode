import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionIndex } from "../src/agent/sessionIndex.js";
import { recordGuiTurn } from "../src/desktop/sessionRecord.js";

function tempIndex(): SessionIndex {
  return new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-gui-record-")), "sessions.json"));
}

describe("recordGuiTurn", () => {
  it("records the first turn with the message as firstMessage", () => {
    const index = tempIndex();
    recordGuiTurn(index, { cwd: "/repo", provider: "anthropic", sessionId: "sess-1", text: "Fix the sidebar" });
    const entries = index.listForCwd("/repo");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "sess-1", cwd: "/repo", firstMessage: "Fix the sidebar", provider: "anthropic" });
  });
  it("touches instead of duplicating on later turns", () => {
    const index = tempIndex();
    recordGuiTurn(index, { cwd: "/repo", provider: "anthropic", sessionId: "sess-1", text: "first" });
    recordGuiTurn(index, { cwd: "/repo", provider: "anthropic", sessionId: "sess-1", text: "second" });
    const entries = index.listForCwd("/repo");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.firstMessage).toBe("first");
  });
  it("ignores turns without an assigned session id", () => {
    const index = tempIndex();
    recordGuiTurn(index, { cwd: "/repo", provider: "anthropic", sessionId: undefined, text: "hello" });
    expect(index.listForCwd("/repo")).toHaveLength(0);
  });
});
