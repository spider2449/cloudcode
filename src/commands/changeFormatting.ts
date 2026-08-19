import type { ChangeSummary, UndoPreview, UndoResult } from "../agent/changeJournal.js";

function shortId(id: string): string {
  return id.slice(0, 8);
}

export function formatChanges(summaries: ChangeSummary[]): string {
  if (summaries.length === 0) return "No session-owned changes.";
  const lines: string[] = [];
  for (const summary of summaries) {
    lines.push(`${shortId(summary.id)}  ${summary.status}  ${summary.startedAt}`);
    for (const change of summary.changes) {
      const protection = change.undoAvailable ? "undoable" : `not undoable: ${change.unavailableReason ?? "unknown reason"}`;
      lines.push(`  ${change.kind.padEnd(8)} ${change.path}  (${protection})`);
    }
  }
  return lines.join("\n");
}

export function formatUndoPreview(preview: UndoPreview): string {
  if (!preview.checkpointId) return "No checkpoint is available to undo.";
  const lines = [`Undo checkpoint ${shortId(preview.checkpointId)}:`];
  for (const operation of preview.operations) lines.push(`  ${operation.action.padEnd(7)} ${operation.path}`);
  for (const conflict of preview.conflicts) lines.push(`  conflict ${conflict}`);
  if (preview.conflicts.length > 0) lines.push("Undo cannot proceed until every conflict is resolved.");
  else lines.push("Run /undo --yes to apply these operations.");
  return lines.join("\n");
}

export function formatUndoResult(result: UndoResult): string {
  if (!result.applied) {
    const base = formatUndoPreview(result);
    const rollback = result.rollbackErrors.length > 0
      ? `\nRollback errors:\n${result.rollbackErrors.map(error => `  ${error}`).join("\n")}`
      : "";
    return `${base}${rollback}`;
  }
  return `Undid checkpoint ${result.checkpointId?.slice(0, 8)} (${result.operations.length} file${result.operations.length === 1 ? "" : "s"}).`;
}
