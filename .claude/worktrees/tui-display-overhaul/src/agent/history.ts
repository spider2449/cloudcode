import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "./providers.js";

const MAX_ENTRIES = 100;

export class History {
  private entries: string[] = [];
  private cursor: number;

  constructor(private filePath: string = join(configDir(), "history.json")) {
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (Array.isArray(raw)) this.entries = raw.filter(e => typeof e === "string");
    } catch {
      // missing or invalid file: start empty
    }
    this.cursor = this.entries.length;
  }

  add(text: string): void {
    if (this.entries[this.entries.length - 1] !== text) {
      this.entries.push(text);
      if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES);
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2));
    }
    this.resetCursor();
  }

  back(): string | undefined {
    if (this.entries.length === 0) return undefined;
    if (this.cursor > 0) this.cursor--;
    return this.entries[this.cursor];
  }

  forward(): string | undefined {
    if (this.cursor >= this.entries.length - 1) {
      this.resetCursor();
      return undefined;
    }
    this.cursor++;
    return this.entries[this.cursor];
  }

  resetCursor(): void {
    this.cursor = this.entries.length;
  }
}
