import type { SessionIndex, SessionEntry } from "../agent/sessionIndex.js";
import { recentProjects, resolveProjectPath } from "../commands/projectPath.js";
import { openInEditor, openFolder } from "../commands/editor.js";
import { ensureMemoryDir } from "../engine/memoryPaths.js";
import { buildMemoryOptions } from "./MemoryPicker.js";
import type { ConfigEntry, OverlayManager } from "./widgets/overlay.js";
import type { StatusLineItem } from "../statusLineItems.js";

/**
 * Wiring for the list overlays the slash commands open (/resume, /project,
 * /memory, /statusline, /config). Each one is opened the same way: build its options,
 * hand the overlay a pick callback and a cancel callback that closes and
 * repaints, then repaint so the overlay appears immediately.
 */
export interface PickerDeps {
  overlay: OverlayManager;
  cwd: string;
  sessionIndex: SessionIndex;
  notice(text: string): void;
  recompute(): void;
}

function cancel(deps: PickerDeps): () => void {
  return () => { deps.overlay.close(); deps.recompute(); };
}

export function openResumePicker(deps: PickerDeps, onPick: (entry: SessionEntry) => void): void {
  deps.overlay.openResume(deps.sessionIndex.listForCwd(deps.cwd), onPick, cancel(deps));
  deps.recompute();
}

export function openProjectPicker(deps: PickerDeps, switchProject: (path: string) => void): void {
  deps.overlay.openProject(
    recentProjects(deps.sessionIndex.list(), deps.cwd),
    deps.cwd,
    p => {
      const result = resolveProjectPath(p, deps.cwd);
      if (!result.ok) { deps.notice(result.error); return; }
      switchProject(result.path);
    },
    cancel(deps)
  );
  deps.recompute();
}

/** `onEdited` runs only when an editor actually opened a memory file, since
 * that is what can change the memory content behind the system prompt. */
export function openMemoryPicker(deps: PickerDeps, onEdited: () => void): void {
  deps.overlay.openMemory(
    buildMemoryOptions(deps.cwd),
    o => {
      if (o.kind === "folder") {
        ensureMemoryDir(o.path);
        openFolder(o.path);
        deps.notice(`Opened ${o.path}`);
        return;
      }
      const r = openInEditor(o.path);
      deps.notice(r.hint);
      if (r.ok) onEdited();
    },
    cancel(deps)
  );
  deps.recompute();
}

/** Toggle list for /statusline: every change flows through onChange so the
 * app can persist and repaint while the overlay stays open. */
export function openStatusLinePicker(
  deps: PickerDeps,
  initial: StatusLineItem[],
  onChange: (next: StatusLineItem[]) => void
): void {
  deps.overlay.openStatusLine(initial, onChange, cancel(deps));
  deps.recompute();
}

/** Settings picker for bare /config: entries are computed by the caller
 * (configChoices) at open time; picks are applied by the caller's callback.
 * onHighlight previews the browsed value without applying it (the overlay
 * re-highlights the entry's original current when backing out, so callers
 * only need to render the preview, never to track revert state). */
export function openConfigPicker(
  deps: PickerDeps,
  entries: ConfigEntry[],
  onPick: (key: string, value: string) => void,
  onHighlight?: (key: string, value: string) => void
): void {
  deps.overlay.openConfig(entries, onPick, cancel(deps), onHighlight);
  deps.recompute();
}

/** Standalone theme picker for bare /theme: same contract as the config
 * values phase — onHighlight previews without applying, Esc restores the
 * saved theme through the same channel, Enter goes through onPick. */
export function openThemePicker(
  deps: PickerDeps,
  names: string[],
  current: string,
  onPick: (name: string) => void,
  onHighlight?: (name: string) => void
): void {
  deps.overlay.openTheme(names, current, onPick, cancel(deps), onHighlight);
  deps.recompute();
}
