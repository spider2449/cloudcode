import type { SessionEntry } from "../../agent/sessionIndex.js";
import type { PermissionRequest } from "../../agent/session.js";
import type { Key } from "../input.js";
import { visibleWindow, MAX_ROWS } from "./menu.js";
import { sgr, SGR_RESET } from "../term/ansi.js";
import type { Theme } from "../theme.js";
import type { MemoryOption } from "../MemoryPicker.js";
import { PermissionOverlay, type PermissionDecisionHandler } from "./permissionOverlay.js";
import { STATUS_LINE_ITEMS, STATUS_LINE_LABELS, canonicalOrder } from "../../statusLineItems.js";
import type { StatusLineItem } from "../../statusLineItems.js";

export type OverlayMode = "none" | "resume" | "project" | "permission" | "memory" | "trust" | "statusline" | "config" | "theme";

function safeTerminalText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 300);
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

interface TrustState {
  projectPath: string;
  commands: string[];
  selected: number;
  onDecision: (allow: boolean) => void;
}

interface StatusLineState {
  items: StatusLineItem[];
  enabled: Set<StatusLineItem>;
  index: number;
  onToggle: (next: StatusLineItem[]) => void;
  onCancel: () => void;
}

export interface ConfigEntry {
  key: string;
  current: string;
  choices: string[];
}

interface ConfigState {
  entries: ConfigEntry[];
  phase: "keys" | "values";
  keyIndex: number;
  valueIndex: number;
  activeKey: ConfigEntry | undefined;
  onPick: (key: string, value: string) => void;
  onCancel: () => void;
  // Fires whenever the highlighted value changes (entering the values
  // phase, arrow navigation) and with the entry's original current when
  // backing out to the keys phase, so callers can live-preview a value
  // without applying it. Enter still goes through onPick.
  onHighlight?: (key: string, value: string) => void;
}

// Standalone theme picker backing bare /theme: same preview semantics as
// the config values phase (highlight previews, Enter applies, Esc reverts
// to the saved theme) without the keys-phase detour.
interface ThemeState {
  names: string[];
  current: string;
  index: number;
  onPick: (name: string) => void;
  onCancel: () => void;
  onHighlight?: (name: string) => void;
}

export class OverlayManager {
  private _mode: OverlayMode = "none";
  private resumeState: ResumeState | undefined;
  private projectState: ProjectState | undefined;
  private permission = new PermissionOverlay();
  private memoryState: MemoryState | undefined;
  private trustState: TrustState | undefined;
  private statusLineState: StatusLineState | undefined;
  private configState: ConfigState | undefined;
  private themeState: ThemeState | undefined;

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

  openPermission(request: PermissionRequest, onDecision: PermissionDecisionHandler): void {
    this._mode = "permission";
    this.permission.open(request, onDecision);
  }

  openMemory(options: MemoryOption[], onPick: (o: MemoryOption) => void, onCancel: () => void): void {
    this._mode = "memory";
    this.memoryState = { options, index: 0, onPick, onCancel };
  }

  openTrust(projectPath: string, commands: string[], onDecision: (allow: boolean) => void): void {
    this._mode = "trust";
    this.trustState = { projectPath, commands, selected: 1, onDecision };
  }

  openStatusLine(
    current: StatusLineItem[],
    onToggle: (next: StatusLineItem[]) => void,
    onCancel: () => void
  ): void {
    this._mode = "statusline";
    this.statusLineState = {
      items: [...STATUS_LINE_ITEMS],
      enabled: new Set(current),
      index: 0,
      onToggle,
      onCancel
    };
  }

  openConfig(
    entries: ConfigEntry[],
    onPick: (key: string, value: string) => void,
    onCancel: () => void,
    onHighlight?: (key: string, value: string) => void
  ): void {
    this._mode = "config";
    this.configState = { entries, phase: "keys", keyIndex: 0, valueIndex: 0, activeKey: undefined, onPick, onCancel, onHighlight };
  }

  openTheme(
    names: string[],
    current: string,
    onPick: (name: string) => void,
    onCancel: () => void,
    onHighlight?: (name: string) => void
  ): void {
    this._mode = "theme";
    this.themeState = {
      names, current,
      index: Math.max(0, names.indexOf(current)),
      onPick, onCancel, onHighlight
    };
  }

  close(): void {
    this._mode = "none";
    this.resumeState = undefined;
    this.projectState = undefined;
    this.permission.reset();
    this.memoryState = undefined;
    this.trustState = undefined;
    this.statusLineState = undefined;
    this.configState = undefined;
    this.themeState = undefined;
  }

  handleKey(k: Key, input?: string): void {
    if (this._mode === "resume") this.handleResumeKey(k);
    else if (this._mode === "project") this.handleProjectKey(k, input);
    else if (this._mode === "permission") this.permission.handleKey(k, input, () => this.close());
    else if (this._mode === "memory") this.handleMemoryKey(k);
    else if (this._mode === "trust") this.handleTrustKey(k, input);
    else if (this._mode === "statusline") this.handleStatusLineKey(k, input);
    else if (this._mode === "config") this.handleConfigKey(k);
    else if (this._mode === "theme") this.handleThemeKey(k);
  }

  private handleTrustKey(k: Key, input?: string): void {
    const s = this.trustState;
    if (!s) return;
    const decide = (allow: boolean) => { const cb = s.onDecision; this.close(); cb(allow); };
    if (input?.toLowerCase() === "y") { decide(true); return; }
    if (input?.toLowerCase() === "n") { decide(false); return; }
    if (k.t === "esc") { decide(false); return; }
    if (k.t === "left" || k.t === "right" || k.t === "up" || k.t === "down") s.selected = s.selected === 0 ? 1 : 0;
    if (k.t === "enter") decide(s.selected === 0);
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

  private handleStatusLineKey(k: Key, input?: string): void {
    const s = this.statusLineState;
    if (!s) return;
    if (k.t === "esc") { const cb = s.onCancel; this.close(); cb(); return; }
    if (k.t === "up") { s.index = Math.max(0, s.index - 1); return; }
    if (k.t === "down") { s.index = Math.min(s.items.length - 1, s.index + 1); return; }
    const toggle = k.t === "enter" || (k.t === "printable" && input === " ");
    if (!toggle) return;
    const item = s.items[s.index];
    if (!item) return;
    if (s.enabled.has(item)) s.enabled.delete(item);
    else s.enabled.add(item);
    s.onToggle(canonicalOrder(s.enabled));
  }

  private filteredProjects(s: ProjectState): string[] {
    return s.text ? s.projects.filter(p => p.toLowerCase().includes(s.text.toLowerCase())) : s.projects;
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

  private handleConfigKey(k: Key): void {
    const s = this.configState;
    if (!s) return;
    if (s.phase === "keys") {
      if (k.t === "esc") { const cb = s.onCancel; this.close(); cb(); return; }
      if (k.t === "up") { s.keyIndex = Math.max(0, s.keyIndex - 1); return; }
      if (k.t === "down") { s.keyIndex = Math.min(s.entries.length - 1, s.keyIndex + 1); return; }
      if (k.t === "enter") {
        const entry = s.entries[s.keyIndex];
        if (entry && entry.choices.length > 0) {
          s.activeKey = entry;
          s.valueIndex = Math.max(0, entry.choices.indexOf(entry.current));
          s.phase = "values";
          const highlighted = entry.choices[s.valueIndex];
          if (highlighted !== undefined) s.onHighlight?.(entry.key, highlighted);
        }
      }
      return;
    }
    if (k.t === "esc") {
      // Backing out restores the entry's original current through the same
      // preview channel, so an unconfirmed highlight never leaks.
      const key = s.activeKey;
      s.phase = "keys";
      s.activeKey = undefined;
      s.valueIndex = 0;
      if (key) s.onHighlight?.(key.key, key.current);
      return;
    }
    if (k.t === "up") {
      s.valueIndex = Math.max(0, s.valueIndex - 1);
      const highlighted = s.activeKey?.choices[s.valueIndex];
      if (s.activeKey && highlighted !== undefined) s.onHighlight?.(s.activeKey.key, highlighted);
      return;
    }
    if (k.t === "down") {
      if (s.activeKey) {
        s.valueIndex = Math.min(s.activeKey.choices.length - 1, s.valueIndex + 1);
        const highlighted = s.activeKey.choices[s.valueIndex];
        if (highlighted !== undefined) s.onHighlight?.(s.activeKey.key, highlighted);
      }
      return;
    }
    if (k.t === "enter") {
      const value = s.activeKey?.choices[s.valueIndex];
      if (s.activeKey && value !== undefined) {
        const cb = s.onPick;
        const key = s.activeKey.key;
        this.close();
        cb(key, value);
      }
    }
  }

  private handleThemeKey(k: Key): void {
    const s = this.themeState;
    if (!s) return;
    if (k.t === "esc") {
      // Abandoned: restore the saved theme through the preview channel,
      // but only when the highlight actually moved away from it.
      const cb = s.onCancel;
      const previewed = s.names[s.index];
      const current = s.current;
      this.close();
      if (previewed !== undefined && previewed !== current) s.onHighlight?.(current);
      cb();
      return;
    }
    if (k.t === "up" || k.t === "down") {
      const next = k.t === "up"
        ? Math.max(0, s.index - 1)
        : Math.min(s.names.length - 1, s.index + 1);
      if (next !== s.index) {
        s.index = next;
        const name = s.names[next];
        if (name !== undefined) s.onHighlight?.(name);
      }
      return;
    }
    if (k.t === "enter") {
      const name = s.names[s.index];
      if (name !== undefined) {
        const cb = s.onPick;
        this.close();
        cb(name);
      }
    }
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
    if (this._mode === "permission") return this.permission.render(theme, width);
    if (this._mode === "memory") return this.renderMemory(theme, width);
    if (this._mode === "trust") return this.renderTrust(theme, width);
    if (this._mode === "statusline") return this.renderStatusLine(theme, width);
    if (this._mode === "config") return this.renderConfig(theme, width);
    if (this._mode === "theme") return this.renderTheme(theme, width);
    return [];
  }

  private renderConfig(theme: Theme, width: number): string[] {
    const s = this.configState;
    if (!s) return [];
    const muted = sgr(theme.muted);
    const warning = sgr(theme.warning);
    const rows: string[] = [
      "╭" + "─".repeat(Math.max(0, width - 2)) + "╮",
      s.phase === "keys"
        ? `${warning}Settings (↑/↓ move, Enter choose, Esc done)${SGR_RESET}`
        : `${warning}Settings — ${s.activeKey?.key ?? ""} (↑/↓ move, Enter apply, Esc back)${SGR_RESET}`
    ];
    if (s.phase === "keys") {
      const { start, end } = visibleWindow(s.entries.length, s.keyIndex, MAX_ROWS);
      for (let i = start; i < end; i++) {
        const e = s.entries[i];
        const line = `${e.key.padEnd(16)}${e.choices.length === 0 ? `${muted}${e.current}${SGR_RESET}` : e.current}`;
        rows.push(i === s.keyIndex ? `\x1b[7m ${line}\x1b[27m` : ` ${line}`);
      }
    } else if (s.activeKey) {
      const { start, end } = visibleWindow(s.activeKey.choices.length, s.valueIndex, MAX_ROWS);
      for (let i = start; i < end; i++) {
        const choice = s.activeKey.choices[i];
        const line = `${choice === s.activeKey.current ? "●" : " "} ${choice}`;
        rows.push(i === s.valueIndex ? `\x1b[7m ${line}\x1b[27m` : ` ${line}`);
      }
    }
    rows.push("╰" + "─".repeat(Math.max(0, width - 2)) + "╯");
    return rows;
  }

  private renderTheme(theme: Theme, width: number): string[] {
    const s = this.themeState;
    if (!s) return [];
    const warning = sgr(theme.warning);
    const rows: string[] = [
      "╭" + "─".repeat(Math.max(0, width - 2)) + "╮",
      `${warning}Theme (↑/↓ preview, Enter apply, Esc cancel)${SGR_RESET}`
    ];
    const { start, end } = visibleWindow(s.names.length, s.index, MAX_ROWS);
    for (let i = start; i < end; i++) {
      const name = s.names[i];
      const line = `${name === s.current ? "●" : " "} ${name}`;
      rows.push(i === s.index ? `\x1b[7m ${line}\x1b[27m` : ` ${line}`);
    }
    rows.push("╰" + "─".repeat(Math.max(0, width - 2)) + "╯");
    return rows;
  }

  private renderStatusLine(theme: Theme, width: number): string[] {
    const s = this.statusLineState;
    if (!s) return [];
    const warning = sgr(theme.warning);
    const rows: string[] = [
      "╭" + "─".repeat(Math.max(0, width - 2)) + "╮",
      `${warning}Status line (↑/↓ move, Enter/Space toggle, Esc done)${SGR_RESET}`
    ];
    const { start, end } = visibleWindow(s.items.length, s.index, MAX_ROWS);
    for (let i = start; i < end; i++) {
      const item = s.items[i];
      const line = (s.enabled.has(item) ? "[x] " : "[ ] ") + STATUS_LINE_LABELS[item];
      rows.push(i === s.index ? `\x1b[7m ${line}\x1b[27m` : ` ${line}`);
    }
    rows.push("╰" + "─".repeat(Math.max(0, width - 2)) + "╯");
    return rows;
  }

  private renderTrust(theme: Theme, width: number): string[] {
    const s = this.trustState;
    if (!s) return [];
    const warning = sgr(theme.warning);
    const yes = s.selected === 0 ? "\x1b[7m Trust and run (y) \x1b[27m" : " Trust and run (y) ";
    const no = s.selected === 1 ? "\x1b[7m Ignore project config (n) \x1b[27m" : " Ignore project config (n) ";
    return [
      "╭" + "─".repeat(Math.max(0, width - 2)) + "╮",
      `${warning}Project configuration requests permission to run commands${SGR_RESET}`,
      safeTerminalText(s.projectPath),
      ...s.commands.map(safeTerminalText),
      `${yes}  ${no}`,
      "╰" + "─".repeat(Math.max(0, width - 2)) + "╯"
    ];
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
