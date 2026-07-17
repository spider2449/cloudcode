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
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (Array.isArray(raw)) this.entries = raw;
    } catch {
      // missing or invalid file: start empty
    }
  }

  record(entry: SessionEntry): void {
    this.entries = this.entries.filter(e => e.id !== entry.id);
    this.entries.push(entry);
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2));
  }

  list(): SessionEntry[] {
    return [...this.entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  latestForCwd(cwd: string): SessionEntry | undefined {
    return this.list().find(e => e.cwd === cwd);
  }

  listForCwd(cwd: string): SessionEntry[] {
    return this.list().filter(e => e.cwd === cwd);
  }
}
