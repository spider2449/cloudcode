import { describe, expect, it } from "vitest";
import { formatChanges, formatUndoPreview, formatUndoResult } from "../src/commands/changeFormatting.js";

describe("change formatting", () => {
  it("formats checkpoint ownership and protection", () => {
    const text = formatChanges([{
      id: "12345678-rest", startedAt: "2026-08-19T00:00:00Z", status: "complete",
      changes: [
        { path: "C:\\p\\a.ts", kind: "modified", undoAvailable: true },
        { path: "C:\\p\\large.bin", kind: "modified", undoAvailable: false, unavailableReason: "too large" }
      ]
    }]);
    expect(text).toContain("12345678");
    expect(text).toContain("undoable");
    expect(text).toContain("not undoable: too large");
  });

  it("requires explicit confirmation and renders conflicts", () => {
    const preview = formatUndoPreview({
      checkpointId: "abcdefgh-rest", operations: [{ path: "a.ts", action: "restore" }], conflicts: []
    });
    expect(preview).toContain("/undo --yes");
    expect(formatUndoPreview({ checkpointId: "x", operations: [], conflicts: ["a.ts changed"] })).toContain("cannot proceed");
  });

  it("formats successful and failed undo results", () => {
    expect(formatUndoResult({ checkpointId: "abcdefgh", operations: [{ path: "a", action: "remove" }], conflicts: [], applied: true, rollbackErrors: [] }))
      .toContain("1 file");
    expect(formatUndoResult({ checkpointId: "abcdefgh", operations: [], conflicts: ["failed"], applied: false, rollbackErrors: ["rollback"] }))
      .toContain("Rollback errors");
  });
});
