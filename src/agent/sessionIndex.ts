import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "./providers.js";

export interface SessionEntry {
  id: string;
  cwd: string;
  firstMessage: string;
  timestamp: string;
  provider: string;
}

export class SessionIndex {
  private entries: SessionEntry[] = [];

  constructor(private filePath: string = join(configDir(), "sessions.json")) {
    this.reload();
  }

  /** Re-read the index file so long-lived hosts see sessions recorded by other processes. */
  reload(): void {
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (Array.isArray(raw)) this.entries = raw;
    } catch {
      // missing or invalid file: keep in-memory entries
    }
  }

  record(entry: SessionEntry): void {
    this.reload();
    this.entries = this.entries.filter(e => e.id !== entry.id);
    this.entries.push(entry);
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2));
  }

  list(): SessionEntry[] {
    this.reload();
    return [...this.entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  /** Refresh the timestamp so the most recently used session sorts first. */
  touch(id: string): void {
    this.reload();
    const entry = this.entries.find(e => e.id === id);
    if (!entry) return;
    entry.timestamp = new Date().toISOString();
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2));
  }

  /** Rename a session's display title and bump it to most-recent. Blank titles and unknown ids are ignored. */
  rename(id: string, firstMessage: string): void {
    const title = firstMessage.trim().slice(0, 200);
    if (!title) return;
    this.reload();
    const entry = this.entries.find(e => e.id === id);
    if (!entry) return;
    entry.firstMessage = title;
    entry.timestamp = new Date().toISOString();
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2));
  }

  /** Drop a session entry. Unknown ids are ignored, mirroring touch(). */
  remove(id: string): void {
    this.reload();
    const before = this.entries.length;
    this.entries = this.entries.filter(e => e.id !== id);
    if (this.entries.length === before) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2));
  }

  latestForCwd(cwd: string): SessionEntry | undefined {
    return this.list().find(e => e.cwd === cwd);
  }

  listForCwd(cwd: string): SessionEntry[] {
    return this.list().filter(e => e.cwd === cwd);
  }
}
