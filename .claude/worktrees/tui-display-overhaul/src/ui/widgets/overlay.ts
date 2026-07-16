import type { SessionEntry } from "../../agent/sessionIndex.js";
import type { PermissionRequest } from "../../agent/session.js";
import type { Key } from "../input.js";
import { visibleWindow, MAX_ROWS } from "./menu.js";
import { toolLabel } from "../transcript.js";
import { sgr, SGR_RESET } from "../term/ansi.js";
import type { Theme } from "../theme.js";
import type { MemoryOption } from "../MemoryPicker.js";

export type OverlayMode = "none" | "resume" | "project" | "permission" | "memory";

interface PermOption {
  label: string;
  hotkey: string;
  allow: boolean;
  rememberAs?: "allow" | "deny";
}

const BASE_OPTIONS: PermOption[] = [
  { label: "Yes (y)", hotkey: "y", allow: true },
  { label: "No (n)", hotkey: "n", allow: false }
];

const FILE_OPTIONS: PermOption[] = [
  { label: "Yes (y)", hotkey: "y", allow: true },
  { label: "Always for this directory (a)", hotkey: "a", allow: true, rememberAs: "allow" },
  { label: "No (n)", hotkey: "n", allow: false },
  { label: "Never for this directory (d)", hotkey: "d", allow: false, rememberAs: "deny" }
];

interface PermissionState {
  request: PermissionRequest;
  options: PermOption[];
  selected: number;
  onDecision: (allow: boolean, rememberAs?: "allow" | "deny") => void;
}

interface ResumeState {
  entries: SessionEntry[];
  index: number;
  onPick: (e: SessionEntry) => void;
  onCancel: () => void;
}

interface ProjectState {
  projects: string[];
  currentCwd: string;
  index: number;
  text: string;
  onPick: (p: string) => void;
  onCancel: () => void;
}

interface MemoryState {
  options: MemoryOption[];
  index: number;
  onPick: (o: MemoryOption) => void;
  onCancel: () => void;
}

export class OverlayManager {
  private _mode: OverlayMode = "none";
  private resumeState: ResumeState | undefined;
  private projectState: ProjectState | undefined;
  private permissionState: PermissionState | undefined;
  private memoryState: MemoryState | undefined;

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

  openProject(projects: string[], currentCwd: string, onPick: (p: string) => void, onCancel: () => void): void {
    this._mode = "project";
    this.projectState = { projects, currentCwd, index: 0, text: "", onPick, onCancel };
  }

  openPermission(request: PermissionRequest, onDecision: (allow: boolean, rememberAs?: "allow" | "deny") => void): void {
    this._mode = "permission";
    const hasFilePath = typeof request.input.file_path === "string";
    this.permissionState = { request, options: hasFilePath ? FILE_OPTIONS : BASE_OPTIONS, selected: 0, onDecision };
  }

  openMemory(options: MemoryOption[], onPick: (o: MemoryOption) => void, onCancel: () => void): void {
    this._mode = "memory";
    this.memoryState = { options, index: 0, onPick, onCancel };
  }

  close(): void {
    this._mode = "none";
    this.resumeState = undefined;
    this.projectState = undefined;
    this.permissionState = undefined;
    this.memoryState = undefined;
  }

  handleKey(k: Key, input?: string): void {
    if (this._mode === "resume") this.handleResumeKey(k);
    else if (this._mode === "project") this.handleProjectKey(k, input);
    else if (this._mode === "permission") this.handlePermissionKey(k, input);
    else if (this._mode === "memory") this.handleMemoryKey(k);
  }

  private handleMemoryKey(k: Key): void {
    const s = this.memoryState;
    if (!s) return;
    if (k.t === "esc") { const cb = s.onCancel; this.close(); cb(); return; }
    if (k.t === "up") { s.index = Math.max(0, s.index - 1); return; }
    if (k.t === "down") { s.index = Math.min(s.options.length - 1, s.index + 1); return; }
    if (k.t === "enter") {
      const opt = s.options[s.index];
      if (opt) { const cb = s.onPick; this.close(); cb(opt); }
    }
  }

  private filteredProjects(s: ProjectState): string[] {
    return s.text ? s.projects.filter(p => p.toLowerCase().includes(s.text.toLowerCase())) : s.projects;
  }

  private handlePermissionKey(k: Key, input?: string): void {
    const s = this.permissionState;
    if (!s) return;
    const decide = (opt: PermOption) => {
      const cb = s.onDecision;
      this.close();
      cb(opt.allow, opt.rememberAs);
    };
    if (input) {
      const hot = s.options.find(o => o.hotkey === input.toLowerCase());
      if (hot) { decide(hot); return; }
    }
    if (k.t === "esc") { const cb = s.onDecision; this.close(); cb(false); return; }
    if (k.t === "left" || k.t === "up") { s.selected = (s.selected + s.options.length - 1) % s.options.length; return; }
    if (k.t === "right" || k.t === "down") { s.selected = (s.selected + 1) % s.options.length; return; }
    if (k.t === "enter") decide(s.options[s.selected]);
  }

  private handleProjectKey(k: Key, input?: string): void {
    const s = this.projectState;
    if (!s) return;
    if (k.t === "esc") { const cb = s.onCancel; this.close(); cb(); return; }
    const filtered = this.filteredProjects(s);
    if (k.t === "up") { s.index = Math.max(0, s.index - 1); return; }
    if (k.t === "down") { s.index = Math.min(filtered.length - 1, s.index + 1); return; }
    if (k.t === "backspace") { s.text = s.text.slice(0, -1); s.index = 0; return; }
    if (k.t === "enter") {
      const p = filtered[s.index];
      if (p) {
        if (p === s.currentCwd) { const cb = s.onCancel; this.close(); cb(); }
        else { const cb = s.onPick; this.close(); cb(p); }
      } else if (s.text) {
        const cb = s.onPick;
        const text = s.text;
        this.close();
        cb(text);
      }
      return;
    }
    if (k.t === "printable" && input) { s.text += input; s.index = 0; }
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
    if (this._mode === "project") return this.renderProject(theme, width);
    if (this._mode === "permission") return this.renderPermission(theme, width);
    if (this._mode === "memory") return this.renderMemory(theme, width);
    return [];
  }

  private renderMemory(theme: Theme, width: number): string[] {
    const s = this.memoryState;
    if (!s) return [];
    const warning = sgr(theme.warning);
    const rows: string[] = [
      "╭" + "─".repeat(Math.max(0, width - 2)) + "╮",
      `${warning}Memory (↑/↓, Enter, Esc)${SGR_RESET}`
    ];
    s.options.forEach((o, i) => {
      rows.push(i === s.index ? `\x1b[7m${o.label}\x1b[27m` : o.label);
    });
    rows.push("╰" + "─".repeat(Math.max(0, width - 2)) + "╯");
    return rows;
  }

  private renderPermission(theme: Theme, width: number): string[] {
    const s = this.permissionState;
    if (!s) return [];
    const warning = sgr(theme.warning);
    const optionsLine = s.options
      .map((o, i) => (i === s.selected ? `\x1b[7m ${o.label} \x1b[27m` : ` ${o.label} `))
      .join("  ");
    return [
      "╭" + "─".repeat(Math.max(0, width - 2)) + "╮",
      `${warning}Permission required${SGR_RESET}`,
      toolLabel(s.request.toolName, s.request.input),
      optionsLine,
      "╰" + "─".repeat(Math.max(0, width - 2)) + "╯"
    ];
  }

  private renderProject(theme: Theme, width: number): string[] {
    const s = this.projectState;
    if (!s) return [];
    const muted = sgr(theme.muted);
    const warning = sgr(theme.warning);
    const filtered = this.filteredProjects(s);
    const rows: string[] = [
      "╭" + "─".repeat(Math.max(0, width - 2)) + "╮",
      `${warning}Switch project (type a path, ↑/↓ to pick recent, Enter, Esc)${SGR_RESET}`,
      `> ${s.text}\x1b[7m \x1b[27m`
    ];
    if (filtered.length === 0) {
      const msg = s.projects.length === 0 ? "No recent projects." : "No matches.";
      rows.push(`${muted}${msg} Press Enter to use the typed path.${SGR_RESET}`);
    } else {
      const { start, end } = visibleWindow(filtered.length, s.index, MAX_ROWS);
      for (let i = start; i < end; i++) {
        const p = filtered[i];
        const marker = p === s.currentCwd ? "● " : "  ";
        const line = marker + p;
        rows.push(i === s.index ? `\x1b[7m${line}\x1b[27m` : line);
      }
    }
    rows.push("╰" + "─".repeat(Math.max(0, width - 2)) + "╯");
    return rows;
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
