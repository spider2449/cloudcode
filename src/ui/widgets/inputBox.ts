import { getSuggestions, applySuggestion, type CompletionContext, type Suggestion } from "../../commands/completion.js";
import type { History } from "../../agent/history.js";
import type { Key } from "../input.js";
import { renderMenu } from "./menu.js";
import { sgr, SGR_RESET } from "../term/ansi.js";
import type { Theme } from "../theme.js";
import { charWidth } from "../width.js";

export interface InputBoxRender {
  borderRows: string[];
  contentRows: string[];
  menuRows: string[];
  hintRow: string | null;
  totalRows: number;
  /** Zero-based display-cell location of the drawn insertion marker. */
  cursorRow: number;
  cursorColumn: number;
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

  handleKey(k: Key): void {
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
    if (k.t === "shift-enter") {
      this.setValue(this.value.slice(0, this.cursor) + "\n" + this.value.slice(this.cursor), this.cursor + 1);
      return;
    }
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

  handlePaste(text: string): void {
    // Pasted newlines are literal text, never Enter: submitting mid-paste
    // would fire the first line at the model. Normalize CRLF/CR to LF and
    // strip other control characters.
    const clean = [...text.replace(/\r\n?/g, "\n")].filter(ch => ch === "\n" || ch >= " ").join("");
    this.setValue(this.value.slice(0, this.cursor) + clean + this.value.slice(this.cursor), this.cursor + clean.length);
  }

  render(theme: Theme, width: number, streaming: boolean): InputBoxRender {
    const before = this.value.slice(0, this.cursor);
    const after = this.value.slice(this.cursor);
    const content = "> " + before + "█" + after;
    const innerWidth = Math.max(1, width - 4);
    const wrapped = this.wrap(content, innerWidth, 2 + before.length);
    // A single muted divider separating the transcript from the input area.
    const dividerCode = sgr(theme.muted);
    const divider = "─".repeat(Math.max(1, width));
    const borderRows = [dividerCode ? `${dividerCode}${divider}${SGR_RESET}` : divider];
    const hintRow = streaming ? "working… (Esc to interrupt)" : null;
    const suggestions = this.currentSuggestions();
    const menuRows = renderMenu(suggestions, Math.min(this.selected, Math.max(0, suggestions.length - 1)), theme, width);
    return {
      borderRows,
      contentRows: wrapped.rows,
      menuRows,
      hintRow,
      totalRows: borderRows.length + wrapped.rows.length + (hintRow ? 1 : 0) + menuRows.length,
      cursorRow: wrapped.cursorRow,
      cursorColumn: wrapped.cursorColumn
    };
  }

  private wrap(text: string, width: number, cursorOffset: number): {
    rows: string[];
    cursorRow: number;
    cursorColumn: number;
  } {
    const out: string[] = [];
    let offset = 0;
    let cursorRow = 0;
    let cursorColumn = 0;
    const lines = text.split("\n");
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      if (line.length === 0) {
        out.push("");
        if (lineIndex < lines.length - 1) offset++;
        continue;
      }
      let row = "";
      let w = 0;
      for (const ch of line) {
        const cw = charWidth(ch.codePointAt(0)!);
        if (w + cw > width) {
          if (w === 0) {
            // The row is already empty and this single character alone
            // exceeds `width` (e.g. a wide CJK/emoji char in a 1-column
            // width). There is no way to make it fit narrower, so hard-cut:
            // emit this one character as its own row (even though it
            // overflows) and move on, matching wrapText's resolution in
            // layout.ts for the same unavoidable edge case.
            if (offset === cursorOffset) {
              cursorRow = out.length;
              cursorColumn = 0;
            }
            out.push(ch);
            offset += ch.length;
            continue;
          }
          out.push(row);
          row = "";
          w = 0;
        }
        if (offset === cursorOffset) {
          cursorRow = out.length;
          cursorColumn = w;
        }
        row += ch;
        w += cw;
        offset += ch.length;
      }
      out.push(row);
      if (lineIndex < lines.length - 1) offset++;
    }
    return { rows: out, cursorRow, cursorColumn };
  }
}
