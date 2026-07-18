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

  it("rewrite() replaces all previously appended entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-sess3-"));
    const s = new SessionFile("abc", dir);
    s.append({ role: "user", content: "old 1" });
    s.append({ role: "assistant", content: [{ type: "text", text: "old 2" }] });
    s.rewrite([{ role: "user", content: "Summary of prior conversation: condensed" }]);
    expect(SessionFile.load("abc", dir)).toEqual([
      { role: "user", content: "Summary of prior conversation: condensed" }
    ]);
  });

  it("append() after rewrite() extends the rewritten history", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-sess4-"));
    const s = new SessionFile("abc", dir);
    s.append({ role: "user", content: "old" });
    s.rewrite([{ role: "user", content: "summary" }]);
    s.append({ role: "assistant", content: [{ type: "text", text: "new" }] });
    expect(SessionFile.load("abc", dir)).toEqual([
      { role: "user", content: "summary" },
      { role: "assistant", content: [{ type: "text", text: "new" }] }
    ]);
  });

  it("rewrite([]) leaves an empty, loadable session", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-sess5-"));
    const s = new SessionFile("abc", dir);
    s.append({ role: "user", content: "old" });
    s.rewrite([]);
    expect(SessionFile.load("abc", dir)).toEqual([]);
  });
});
