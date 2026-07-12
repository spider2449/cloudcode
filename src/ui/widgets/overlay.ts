import type { SessionEntry } from "../../agent/sessionIndex.js";
import type { Key } from "../input.js";
import { visibleWindow, MAX_ROWS } from "./menu.js";
import { sgr, SGR_RESET } from "../term/ansi.js";
import type { Theme } from "../theme.js";

export type OverlayMode = "none" | "resume" | "project" | "permission";

interface ResumeState {
  entries: SessionEntry[];
  index: number;
  onPick: (e: SessionEntry) => void;
  onCancel: () => void;
}

export class OverlayManager {
  private _mode: OverlayMode = "none";
  private resumeState: ResumeState | undefined;

  get mode(): OverlayMode {
    return this._mode;
  }

  get isOpen(): boolean {
    return this._mode !== "none";
  }

  openResume(entries: SessionEntry[], onPick: (e: SessionEntry) => void, onCancel: () => void): void {
    this._mode = "resume";
    this.resumeState = { entries, index: 0, onPick, onCancel };
  }

  close(): void {
    this._mode = "none";
    this.resumeState = undefined;
  }

  handleKey(k: Key): void {
    if (this._mode === "resume") this.handleResumeKey(k);
  }

  private handleResumeKey(k: Key): void {
    const s = this.resumeState;
    if (!s) return;
    if (k.t === "esc") { const cb = s.onCancel; this.close(); cb(); return; }
    if (k.t === "up") { s.index = Math.max(0, s.index - 1); return; }
    if (k.t === "down") { s.index = Math.min(s.entries.length - 1, s.index + 1); return; }
    if (k.t === "enter") {
      const entry = s.entries[s.index];
      if (entry) { const cb = s.onPick; this.close(); cb(entry); }
    }
  }

  render(theme: Theme, width: number): string[] {
    if (this._mode === "resume") return this.renderResume(theme, width);
    return [];
  }

  private renderResume(theme: Theme, width: number): string[] {
    const s = this.resumeState;
    if (!s) return [];
    const muted = sgr(theme.muted);
    if (s.entries.length === 0) {
      return [`${muted}No past sessions. Press Esc to close.${SGR_RESET}`];
    }
    const { start, end } = visibleWindow(s.entries.length, s.index, MAX_ROWS);
    const warning = sgr(theme.warning);
    const rows: string[] = [
      "╭" + "─".repeat(Math.max(0, width - 2)) + "╮",
      `${warning}Resume a session (↑/↓, Enter, Esc)${SGR_RESET}`
    ];
    for (let i = start; i < end; i++) {
      const e = s.entries[i];
      const line = `${e.timestamp}  [${e.provider}]  ${e.firstMessage.slice(0, 60)}`;
      rows.push(i === s.index ? `\x1b[7m${line}\x1b[27m` : line);
    }
    rows.push("╰" + "─".repeat(Math.max(0, width - 2)) + "╯");
    return rows;
  }
}
