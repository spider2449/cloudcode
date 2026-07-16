import { describe, it, expect } from "vitest";
import { SessionFile } from "../src/engine/sessions.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("SessionFile", () => {
  it("round-trips appended messages", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-sess-"));
    const s = new SessionFile("abc", dir);
    s.append({ role: "user", content: "hi" });
    s.append({ role: "assistant", content: [{ type: "text", text: "hello" }] });
    expect(SessionFile.load("abc", dir)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] }
    ]);
  });
  it("returns empty array for unknown session", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-sess2-"));
    expect(SessionFile.load("missing", dir)).toEqual([]);
  });
});
