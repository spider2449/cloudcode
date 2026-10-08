import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function desktopDebugDirectory(): string {
  return join(tmpdir(), "cloudcode", "logs");
}

export type DiagnosticFields = Record<string, string | number | boolean | null | undefined>;

// Error messages can contain prompts, credentials, or tool output. Keep only
// classification metadata; callers must never pass raw application payloads.
export function diagnosticError(error: unknown): DiagnosticFields {
  if (!(error instanceof Error)) return { errorName: "UnknownError" };
  const code = "code" in error ? error.code : undefined;
  return { errorName: error.name, errorCode: typeof code === "string" ? code : undefined };
}

export class DesktopDebugLog {
  readonly file: string;
  private bytes: number | undefined;

  constructor(readonly directory: string, readonly enabled = true, private readonly maxBytes = 2 * 1024 * 1024) {
    this.file = join(directory, "desktop-debug.jsonl");
  }

  write(event: string, fields: DiagnosticFields = {}): void {
    if (!this.enabled) return;
    try {
      mkdirSync(this.directory, { recursive: true });
      if (this.bytes === undefined) this.bytes = existsSync(this.file) ? statSync(this.file).size : 0;
      const line = JSON.stringify({ ...fields, time: new Date().toISOString(), pid: process.pid, event }) + "\n";
      const size = Buffer.byteLength(line);
      if (size > this.maxBytes) return;
      if (this.bytes + size > this.maxBytes) {
        const oldest = `${this.file}.2`;
        if (existsSync(oldest)) unlinkSync(oldest);
        if (existsSync(`${this.file}.1`)) renameSync(`${this.file}.1`, oldest);
        if (existsSync(this.file)) renameSync(this.file, `${this.file}.1`);
        this.bytes = 0;
      }
      // Synchronous writes preserve the final event before process teardown.
      appendFileSync(this.file, line, { encoding: "utf8", mode: 0o600 });
      this.bytes += size;
    } catch {
      // Disk failures must not become another cause of application failure.
      this.bytes = undefined;
    }
  }
}
