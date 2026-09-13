import { useState } from "react";
import { STATUS_LINE_ITEMS, STATUS_LINE_LABELS } from "../../statusLineItems.js";
import { formatStatusSegments, type DesktopStatusPayload } from "../statusPayload.js";

// Global footer statusline (mirrors the TUI bottom bar segment semantics).
// Branch data comes from the shell's gitState poll, overlaid onto the backend
// snapshot before formatting so canonical registry order is preserved.
export function buildSegments(
  status: DesktopStatusPayload,
  gitBranch?: string,
  gitDirty?: boolean
): string[] {
  if (!gitBranch) return formatStatusSegments(status);
  return formatStatusSegments({ ...status, branchInfo: { name: gitBranch, dirty: gitDirty === true } });
}

export function StatusBar({ status, gitBranch, gitDirty, onOpenPicker }: {
  status: DesktopStatusPayload | undefined;
  gitBranch?: string;
  gitDirty?: boolean;
  onOpenPicker(): void;
}) {
  if (!status) return <footer className="statusline" aria-label="Status"><span className="statusline-empty">No project</span></footer>;
  const segments = buildSegments(status, gitBranch, gitDirty);
  return <footer className="statusline" aria-label="Status" title={status.cwd}>
    <span className="statusline-segments">{segments.join(" · ") || "—"}</span>
    <button className="bare-button" title="Choose statusline segments (/statusline)" onClick={onOpenPicker}>⚙</button>
  </footer>;
}

// Checkbox checklist for /statusline. Controlled by the shell: `initial`
// comes from the latest status snapshot (or the statusline_picker event),
// every toggle saves through onSave (which forwards a statusline-set request
// to the backend and persists settings.json there).
export function StatuslinePicker({ initial, onSave, onClose }: {
  initial: string[];
  onSave(items: string[]): void;
  onClose(): void;
}) {
  const [checked, setChecked] = useState(() => new Set(initial));
  function toggle(item: string) {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(item)) next.delete(item);
      else next.add(item);
      return next;
    });
  }
  function save() {
    onSave(STATUS_LINE_ITEMS.filter(item => checked.has(item)));
  }
  return <div className="desktop-dialog" role="dialog" aria-label="Statusline segments">
    <strong>Choose statusline segments</strong>
    <div className="desktop-dialog-options" role="group" aria-label="Segments">
      {STATUS_LINE_ITEMS.map(item => <label key={item} className="statusline-option">
        <input type="checkbox" checked={checked.has(item)} onChange={() => toggle(item)} />{" "}
        <span>{STATUS_LINE_LABELS[item]}</span>{" "}
        <small>{item}</small>
      </label>)}
    </div>
    <div className="desktop-dialog-actions">
      <button onClick={onClose}>Cancel</button>
      <button onClick={save}>Save</button>
    </div>
  </div>;
}
