import { loadRegistry, type ServerConfig } from "./config.js";
import { detectLanguage, findRoot, commandExists as realCommandExists } from "./detect.js";
import { LspServer, fileUri, normalizeUri, type Diagnostic } from "./server.js";

export { fileUri };
export type { Diagnostic };

interface Deps {
  commandExists?: (command: string) => boolean;
  makeServer?: (cfg: ServerConfig, root: string, onDiag: (uri: string, d: Diagnostic[]) => void) => LspServer;
}

type Waiter = (diags: Diagnostic[]) => void;

export class LspManager {
  private pool = new Map<string, LspServer>();
  private diagnostics = new Map<string, Diagnostic[]>();
  private waiters = new Map<string, Set<Waiter>>();
  private commandExists: (command: string) => boolean;
  private makeServer: NonNullable<Deps["makeServer"]>;

  constructor(
    private registry: Record<string, ServerConfig> = loadRegistry(),
    deps: Deps = {}
  ) {
    this.commandExists = deps.commandExists ?? realCommandExists;
    this.makeServer = deps.makeServer ?? ((cfg, root, onDiag) =>
      new LspServer(cfg.command, cfg.args, root, onDiag));
  }

  async serverFor(filePath: string, cwd: string): Promise<LspServer | undefined> {
    const lang = detectLanguage(filePath, this.registry);
    if (!lang) return undefined;
    const cfg = this.registry[lang];
    if (!this.commandExists(cfg.command)) return undefined;

    const root = findRoot(filePath, cfg.rootMarkers, cwd);
    const key = `${lang}\0${root}`;
    let server = this.pool.get(key);
    if (server && server.alive) return server;

    server = this.makeServer(cfg, root, (uri, diags) => this.onDiagnostics(uri, diags));
    this.pool.set(key, server);
    try {
      await server.start();
    } catch {
      server.stop();
      this.pool.delete(key);
      return undefined;
    }
    return server;
  }

  private onDiagnostics(uri: string, diags: Diagnostic[]): void {
    const key = normalizeUri(uri);
    this.diagnostics.set(key, diags);
    const set = this.waiters.get(key);
    if (set) {
      for (const w of set) w(diags);
      this.waiters.delete(key);
    }
  }

  diagnosticsFor(uri: string): Diagnostic[] {
    return this.diagnostics.get(normalizeUri(uri)) ?? [];
  }

  openFiles(): string[] {
    return [...this.diagnostics.keys()];
  }

  waitForDiagnostics(uri: string, timeoutMs: number): Promise<Diagnostic[]> {
    const key = normalizeUri(uri);
    return new Promise(resolve => {
      let done = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (diags: Diagnostic[]) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(diags);
      };
      const waiter: Waiter = diags => finish(diags);
      let set = this.waiters.get(key);
      if (!set) { set = new Set(); this.waiters.set(key, set); }
      set.add(waiter);
      timer = setTimeout(() => {
        set?.delete(waiter);
        if (set && set.size === 0) this.waiters.delete(key);
        finish(this.diagnosticsFor(key));
      }, timeoutMs);
    });
  }

  shutdown(): void {
    for (const server of this.pool.values()) server.stop();
    this.pool.clear();
    this.waiters.clear();
  }
}
