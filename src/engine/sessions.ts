import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../agent/providers.js";

const defaultDir = () => join(configDir(), "sessions");

export class SessionFile {
  private filePath: string;

  constructor(sessionId: string, dir: string = defaultDir()) {
    mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, `${sessionId}.jsonl`);
  }

  append(entry: unknown): void {
    appendFileSync(this.filePath, JSON.stringify(entry) + "\n");
  }

  // Replaces the whole file — used after /compact so a resumed session
  // loads the compacted history instead of the stale pre-compact transcript.
  rewrite(entries: unknown[]): void {
    writeFileSync(this.filePath, entries.map(e => JSON.stringify(e) + "\n").join(""));
  }

  static load(sessionId: string, dir: string = defaultDir()): unknown[] {
    try {
      return readFileSync(join(dir, `${sessionId}.jsonl`), "utf8")
        .split("\n")
        .filter(l => l.trim() !== "")
        .map(l => JSON.parse(l));
    } catch {
      return [];
    }
  }
}
