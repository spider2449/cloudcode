import type { SessionEntry } from "../../agent/sessionIndex.js";
import type { PermissionRequest } from "../../agent/session.js";
import type { Key } from "../input.js";
import { visibleWindow, MAX_ROWS } from "./menu.js";
import { toolLabel } from "../transcript.js";
import { sgr, SGR_RESET } from "../term/ansi.js";
import type { Theme } from "../theme.js";
import type { MemoryOption } from "../MemoryPicker.js";
import { commandPrefix } from "../../agent/permissionStore.js";
import { hostScope, ruleScope } from "../../engine/permissions.js";
import { STATUS_LINE_ITEMS, STATUS_LINE_LABELS, canonicalOrder } from "../../statusLineItems.js";
import type { StatusLineItem } from "../../statusLineItems.js";

export type OverlayMode = "none" | "resume" | "project" | "permission" | "memory" | "trust" | "statusline";

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

function safeTerminalText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 300);
}

const FILE_OPTIONS: PermOption[] = [
  { label: "Yes (y)", hotkey: "y", allow: true },
  { label: "Always for this directory (a)", hotkey: "a", allow: true, rememberAs: "allow" },
  { label: "No (n)", hotkey: "n", allow: false },
  { label: "Never for this directory (d)", hotkey: "d", allow: false, rememberAs: "deny" }
];

function commandOptions(prefix: string): PermOption[] {
  return [
    { label: "Yes (y)", hotkey: "y", allow: true },
    { label: `Always allow '${prefix}' commands (a)`, hotkey: "a", allow: true, rememberAs: "allow" },
    { label: "No (n)", hotkey: "n", allow: false },
    { label: `Never allow '${prefix}' commands (d)`, hotkey: "d", allow: false, rememberAs: "deny" }
  ];
}

function hostOptions(host: string): PermOption[] {
  return [
    { label: "Yes (y)", hotkey: "y", allow: true },
    { label: `Always allow ${host} (a)`, hotkey: "a", allow: true, rememberAs: "allow" },
    { label: "No (n)", hotkey: "n", allow: false },
    { label: `Never allow ${host} (d)`, hotkey: "d", allow: false, rememberAs: "deny" }
  ];
}

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

export class OverlayManager {
  private _mode: OverlayMode = "none";
  private resumeState: ResumeState | undefined;
  private projectState: ProjectState | undefined;
  private permissionState: PermissionState | undefined;
  private memoryState: MemoryState | undefined;
  private trustState: TrustState | undefined;
  private statusLineState: StatusLineState | undefined;

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
    // Offer "always" exactly when a remembered rule would actually be
    // consulted later: path-scoped (see ruleScope), command-prefix (Bash),
    // or host-scoped (WebFetch).
    const hasPathRule = ruleScope(request.toolName, request.input) !== undefined;
    const isBashCommand = request.toolName === "Bash" && typeof request.input.command === "string";
    const host = hostScope(request.toolName, request.input);
    const options = hasPathRule
      ? FILE_OPTIONS
      : isBashCommand
        ? commandOptions(commandPrefix(String(request.input.command)))
        : host
          ? hostOptions(host)
          : BASE_OPTIONS;
    this.permissionState = { request, options, selected: 0, onDecision };
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

  close(): void {
    this._mode = "none";
    this.resumeState = undefined;
    this.projectState = undefined;
    this.permissionState = undefined;
    this.memoryState = undefined;
    this.trustState = undefined;
    this.statusLineState = undefined;
  }

  handleKey(k: Key, input?: string): void {
    if (this._mode === "resume") this.handleResumeKey(k);
    else if (this._mode === "project") this.handleProjectKey(k, input);
    else if (this._mode === "permission") this.handlePermissionKey(k, input);
    else if (this._mode === "memory") this.handleMemoryKey(k);
    else if (this._mode === "trust") this.handleTrustKey(k, input);
    else if (this._mode === "statusline") this.handleStatusLineKey(k, input);
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
    if (this._mode === "trust") return this.renderTrust(theme, width);
    if (this._mode === "statusline") return this.renderStatusLine(theme, width);
    return [];
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
