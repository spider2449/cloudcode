import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { encodeMessage, MessageBuffer } from "./rpc.js";

export interface Diagnostic {
  line: number;
  column: number;
  severity: number;
  message: string;
  code?: string;
}

export interface Location {
  uri: string;
  line: number;
  column: number;
}

type SpawnFn = (command: string, args: string[], options: object) => ChildProcess;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  onAbort?: () => void;
  signal?: AbortSignal;
}

export function fileUri(path: string): string {
  return pathToFileURL(path).toString();
}

export class LspServer {
  private proc: ChildProcess | undefined;
  private buffer = new MessageBuffer();
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private startPromise: Promise<void> | undefined;
  private opened = new Set<string>();
  private versions = new Map<string, number>();
  private dead = false;

  constructor(
    private command: string,
    private args: string[],
    private rootPath: string,
    private onDiagnostics: (uri: string, diags: Diagnostic[]) => void,
    private deps: { spawnFn?: SpawnFn } = {}
  ) {}

  get alive(): boolean {
    return !this.dead && this.proc !== undefined;
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart();
    return this.startPromise;
  }

  private doStart(): Promise<void> {
    const spawnFn = this.deps.spawnFn ?? spawn;
    const proc = spawnFn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    proc.on("exit", () => this.markDead(new Error("language server exited")));
    proc.on("error", (err: Error) => this.markDead(err));

    return this.request("initialize", {
      processId: process.pid,
      rootUri: fileUri(this.rootPath),
      capabilities: { textDocument: { publishDiagnostics: {} } }
    }).then(() => {
      this.notify("initialized", {});
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer.push(chunk);
    for (const msg of this.buffer.drain()) this.dispatch(msg as Record<string, unknown>);
  }

  private dispatch(msg: Record<string, unknown>): void {
    if (typeof msg.id === "number" && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.onAbort && p.signal) p.signal.removeEventListener("abort", p.onAbort);
      if (msg.error) p.reject(new Error(String((msg.error as { message?: string }).message ?? "LSP error")));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      const params = msg.params as { uri: string; diagnostics: RawDiag[] };
      this.onDiagnostics(params.uri, params.diagnostics.map(normalizeDiag));
    }
  }

  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.dead) return Promise.reject(new Error("language server is not running"));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const pending: Pending = { resolve, reject, signal };
      if (signal) {
        const onAbort = () => {
          this.pending.delete(id);
          reject(new Error("aborted"));
        };
        pending.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.pending.set(id, pending);
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(msg: unknown): void {
    this.proc?.stdin?.write(encodeMessage(msg));
  }

  didOpen(uri: string, text: string): void {
    this.opened.add(uri);
    this.versions.set(uri, 1);
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "plaintext", version: 1, text }
    });
  }

  didChange(uri: string, text: string): void {
    if (!this.opened.has(uri)) { this.didOpen(uri, text); return; }
    const version = (this.versions.get(uri) ?? 1) + 1;
    this.versions.set(uri, version);
    this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }]
    });
  }

  isOpen(uri: string): boolean {
    return this.opened.has(uri);
  }

  stop(): void {
    if (this.dead) return;
    try {
      this.notify("shutdown", null);
      this.notify("exit", null);
    } catch {
      // best-effort
    }
    this.proc?.kill();
    this.markDead(new Error("stopped"));
  }

  private markDead(err: Error): void {
    if (this.dead) return;
    this.dead = true;
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }
}

interface RawDiag {
  range: { start: { line: number; character: number } };
  severity?: number;
  message: string;
  code?: string | number;
}

function normalizeDiag(d: RawDiag): Diagnostic {
  return {
    line: d.range.start.line,
    column: d.range.start.character,
    severity: d.severity ?? 1,
    message: d.message,
    code: d.code === undefined ? undefined : String(d.code)
  };
}
