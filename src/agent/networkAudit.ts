import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "./providers.js";
import type { NetworkDecision, NetworkDecisionRecorder } from "./networkPolicy.js";

export interface NetworkAuditRecord extends NetworkDecision {
  schemaVersion: 1;
  timestamp: string;
}

export interface NetworkAuditOptions {
  filePath?: string;
  maxRecords?: number;
  maxBytes?: number;
  now?: () => Date;
}

const DEFAULT_MAX_RECORDS = 1000;
const DEFAULT_MAX_BYTES = 512 * 1024;

function readLines(filePath: string): string[] {
  try {
    return readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

export class NetworkAudit implements NetworkDecisionRecorder {
  private filePath: string;
  private maxRecords: number;
  private maxBytes: number;
  private now: () => Date;

  constructor(options: NetworkAuditOptions = {}) {
    this.filePath = options.filePath ?? join(configDir(), "audit", "network.jsonl");
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.now = options.now ?? (() => new Date());
  }

  record(decision: NetworkDecision): void {
    const record: NetworkAuditRecord = {
      schemaVersion: 1,
      timestamp: this.now().toISOString(),
      capability: decision.capability,
      destinationHost: decision.destinationHost,
      mode: decision.mode,
      allowed: decision.allowed,
      ...(decision.reason ? { reason: decision.reason } : {})
    };
    const lines = [...readLines(this.filePath), JSON.stringify(record)].slice(-this.maxRecords);
    while (lines.length > 1 && Buffer.byteLength(lines.join("\n") + "\n") > this.maxBytes) lines.shift();
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, lines.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(temp, this.filePath);
  }
}
