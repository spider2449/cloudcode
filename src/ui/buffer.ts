import type { DisplayItem } from "./transcript.js";
import { layoutItem } from "./layout.js";
import type { Theme } from "./theme.js";

export class Buffer {
  private items: DisplayItem[] = [];
  private rowOffsets: number[] = [0];
  private cachedWidth = -1;

  append(item: DisplayItem): void {
    this.items.push(item);
    // Invalidate the index; it is rebuilt lazily on next read at whatever
    // width is requested (append itself never lays anything out).
    this.rowOffsets = [0];
    this.cachedWidth = -1;
  }

  clear(): void {
    this.items = [];
    this.rowOffsets = [0];
    this.cachedWidth = -1;
  }

  private ensureIndex(width: number, theme: Theme): void {
    if (this.cachedWidth === width && this.rowOffsets.length === this.items.length + 1) return;
    const offsets = [0];
    for (const item of this.items) {
      offsets.push(offsets[offsets.length - 1] + layoutItem(item, theme, width).length);
    }
    this.rowOffsets = offsets;
    this.cachedWidth = width;
  }

  totalRows(width: number, theme: Theme): number {
    this.ensureIndex(width, theme);
    return this.rowOffsets[this.rowOffsets.length - 1];
  }

  visibleWindow(
    startRow: number | null,
    height: number,
    width: number,
    theme: Theme
  ): { rows: string[]; tailRow: number } {
    this.ensureIndex(width, theme);
    const total = this.rowOffsets[this.rowOffsets.length - 1];
    if (total === 0) return { rows: [], tailRow: -1 };

    const from = startRow === null ? Math.max(0, total - height) : Math.max(0, Math.min(startRow, total));
    const to = Math.min(total, from + height);

    // Binary search for the first item whose range contains row `from`.
    let lo = 0, hi = this.rowOffsets.length - 2;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.rowOffsets[mid + 1] <= from) lo = mid + 1; else hi = mid;
    }

    const rows: string[] = [];
    let itemIndex = lo;
    let cursor = this.rowOffsets[lo];
    while (cursor < to && itemIndex < this.items.length) {
      const itemRows = layoutItem(this.items[itemIndex], theme, width);
      for (let r = 0; r < itemRows.length && cursor < to; r++, cursor++) {
        if (cursor >= from) rows.push(itemRows[r]);
      }
      itemIndex++;
    }
    return { rows, tailRow: to - 1 };
  }
}
