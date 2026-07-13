import { getSuggestions, applySuggestion, type CompletionContext, type Suggestion } from "../../commands/completion.js";
import type { History } from "../../agent/history.js";
import type { Key } from "../input.js";
import { renderMenu } from "./menu.js";
import { sgr, SGR_RESET } from "../term/ansi.js";
import type { Theme } from "../theme.js";

export interface InputBoxRender {
  borderRows: string[];
  contentRows: string[];
  menuRows: string[];
  hintRow: string | null;
  totalRows: number;
}

export class InputBox {
  onSubmit: ((text: string) => void) | undefined;

  private value = "";
  private cursor = 0;
  private selected = 0;
  private draft: string | undefined;
  private suppressed = false;
  private hadAtToken = false;

  constructor(private completionCtx: CompletionContext, private history: History) {}

  private currentSuggestions(): Suggestion[] {
    if (this.suppressed) return [];
    return getSuggestions(this.value, this.cursor, this.completionCtx);
  }

  private setValue(nextValue: string, nextCursor: number): void {
    const changed = nextValue !== this.value;
    this.value = nextValue;
    this.cursor = Math.max(0, Math.min(nextCursor, nextValue.length));
    if (changed) {
      this.suppressed = false;
      this.selected = 0;
      const hasAt = /(^|\s)@[\w./-]*$/.test(nextValue.slice(0, this.cursor));
      if (hasAt && !this.hadAtToken) this.completionCtx.refreshFiles?.();
      this.hadAtToken = hasAt;
    }
  }

  private submit(): void {
    const current = this.value;
    if (current.endsWith("\\")) {
      this.setValue(current.slice(0, -1) + "\n", current.length);
      return;
    }
    const text = current.trim();
    this.setValue("", 0);
    this.draft = undefined;
    this.history.resetCursor();
    if (text) {
      this.history.add(text);
      this.onSubmit?.(text);
    }
  }

  private accept(suggestions: Suggestion[]): void {
    const s = suggestions[Math.min(this.selected, suggestions.length - 1)];
    const r = applySuggestion(this.value, s);
    this.setValue(r.text, r.cursor);
  }

  private acceptIsNoop(suggestions: Suggestion[]): boolean {
    const s = suggestions[Math.min(this.selected, suggestions.length - 1)];
    return applySuggestion(this.value, s).text === this.value.trimEnd();
  }

  handleKey(k: Key, disabled: boolean): void {
    if (disabled) return;
    if (k.t === "ctrl" || k.t === "alt") return;
    const menu = this.currentSuggestions();
    const menuOpen = menu.length > 0;

    if (k.t === "esc" && menuOpen) { this.suppressed = true; return; }
    if (k.t === "left") { this.setValue(this.value, this.cursor - 1); return; }
    if (k.t === "right") { this.setValue(this.value, this.cursor + 1); return; }
    if (k.t === "up") {
      if (menuOpen) { this.selected = (this.selected - 1 + menu.length) % menu.length; return; }
      if (this.draft === undefined) this.draft = this.value;
      const recalled = this.history.back();
      if (recalled !== undefined) { this.setValue(recalled, recalled.length); this.suppressed = true; }
      return;
    }
    if (k.t === "down") {
      if (menuOpen) { this.selected = (this.selected + 1) % menu.length; return; }
      const recalled = this.history.forward();
      if (recalled !== undefined) {
        this.setValue(recalled, recalled.length);
        this.suppressed = true;
      } else {
        this.setValue(this.draft ?? "", (this.draft ?? "").length);
        this.draft = undefined;
      }
      return;
    }
    if (k.t === "backspace" || k.t === "delete") {
      if (this.cursor > 0) this.setValue(this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor), this.cursor - 1);
      return;
    }
    if (k.t === "tab") { if (menuOpen) this.accept(menu); return; }
    if (k.t === "enter") {
      if (menuOpen && !this.acceptIsNoop(menu)) this.accept(menu);
      else this.submit();
      return;
    }
    if (k.t === "printable") {
      const ch = k.ch;
      if (ch >= " ") this.setValue(this.value.slice(0, this.cursor) + ch + this.value.slice(this.cursor), this.cursor + 1);
    }
  }

  handlePaste(text: string, disabled: boolean): void {
    if (disabled) return;
    for (const ch of text) {
      if (ch === "\r" || ch === "\n") {
        const m = this.currentSuggestions();
        if (m.length > 0 && !this.acceptIsNoop(m)) this.accept(m);
        else this.submit();
      } else if (ch >= " ") {
        this.setValue(this.value.slice(0, this.cursor) + ch + this.value.slice(this.cursor), this.cursor + 1);
      }
    }
  }

  render(theme: Theme, width: number, disabled: boolean): InputBoxRender {
    const before = this.value.slice(0, this.cursor);
    const after = this.value.slice(this.cursor);
    const content = "> " + before + (disabled ? "" : "█") + after;
    const innerWidth = Math.max(1, width - 4);
    const wrapped = this.wrap(content, innerWidth);
    // A single muted divider separating the transcript from the input area.
    const dividerCode = sgr(theme.muted);
    const divider = "─".repeat(Math.max(1, width));
    const borderRows = [dividerCode ? `${dividerCode}${divider}${SGR_RESET}` : divider];
    const hintRow = disabled ? "working… (Esc to interrupt)" : null;
    const suggestions = disabled ? [] : this.currentSuggestions();
    const menuRows = disabled ? [] : renderMenu(suggestions, Math.min(this.selected, Math.max(0, suggestions.length - 1)), theme, width);
    return {
      borderRows,
      contentRows: wrapped,
      menuRows,
      hintRow,
      totalRows: borderRows.length + wrapped.length + (hintRow ? 1 : 0) + menuRows.length
    };
  }

  private wrap(text: string, width: number): string[] {
    const out: string[] = [];
    for (const line of text.split("\n")) {
      let rest = line;
      if (rest.length === 0) { out.push(""); continue; }
      while (rest.length > width) { out.push(rest.slice(0, width)); rest = rest.slice(width); }
      out.push(rest);
    }
    return out;
  }
}
