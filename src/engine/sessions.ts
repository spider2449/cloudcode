import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
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
