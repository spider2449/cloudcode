import type { DisplayItem } from "./transcript.js";
import { layoutItem } from "./layout.js";
import type { Theme } from "./theme.js";

/**
 * Holds transcript items and tracks which of them have already been
 * committed (printed once into the terminal's normal scrollback).
 * Committed items are never laid out or emitted again.
 */
export class Buffer {
  private items: DisplayItem[] = [];
  private committed = 0;

  append(item: DisplayItem): void {
    this.items.push(item);
  }

  get itemCount(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
    this.committed = 0;
  }

  /** Lay out all not-yet-committed items and mark them committed. */
  takeCommitRows(width: number, theme: Theme): string[] {
    const rows: string[] = [];
    for (; this.committed < this.items.length; this.committed++) {
      rows.push(...layoutItem(this.items[this.committed], theme, width));
    }
    return rows;
  }
}
