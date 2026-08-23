import { spawn } from "node:child_process";

export interface ChildLike {
  pid?: number;
  stdout: { on(event: string, handler: (chunk: Buffer) => void): void } | null;
  stderr: { on(event: string, handler: (chunk: Buffer) => void): void } | null;
  kill(): void;
}

export type BgSpawner = (command: string, cwd: string) => ChildLike;

const MAX_SHELLS = 10;
const RING_BYTES = 200 * 1024;

/** Fixed-capacity byte ring; drain() returns everything appended since last read. */
class Ring {
  private buf = Buffer.alloc(0);
  private dropped = false;
  append(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > RING_BYTES) {
      this.buf = this.buf.subarray(this.buf.length - RING_BYTES);
      this.dropped = true;
    }
  }
  drain(): string {
    const text = this.buf.toString("utf8");
    this.buf = Buffer.alloc(0);
    if (text === "") return "";
    return (this.dropped ? "[earlier output dropped]" : "") + text;
  }
}

interface Shell {
  id: string;
  child: ChildLike;
  ring: Ring;
  running: boolean;
  exitCode?: number;
}

export function realBgSpawner(command: string, cwd: string): ChildLike {
  const shell = process.platform === "win32"
    ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { cwd, windowsHide: true })
    : spawn("/bin/sh", ["-c", command], { cwd });
  return shell as unknown as ChildLike;
}

/**
 * Owns every background shell of a session: sequential b1..bn ids, capped
 * concurrency, per-shell ring buffers, and bulk teardown at dispose.
 */
export class BackgroundShellManager {
  private shells = new Map<string, Shell>();
  private seq = 0;

  constructor(private spawner: BgSpawner) {}

  start(command: string, cwd: string): { id?: string; error?: string } {
    const liveCount = [...this.shells.values()].filter(s => s.running).length;
    if (liveCount >= MAX_SHELLS) {
      return { error: `Already ${MAX_SHELLS} background shells running; kill one with KillShell first.` };
    }
    this.seq += 1;
    const id = `b${this.seq}`;
    try {
      const child = this.spawner(command, cwd);
      const shell: Shell = { id, child, ring: new Ring(), running: true };
      const onData = (chunk: Buffer) => shell.ring.append(chunk);
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      // Exit events arrive through the child's emitter; optional so the test
      // fakes (plain objects with on()) keep working.
      const anyChild = child as unknown as { on?(event: string, h: (...a: unknown[]) => void): void };
      anyChild.on?.("exit", (code: unknown) => {
        shell.running = false;
        shell.exitCode = typeof code === "number" ? code : undefined;
      });
      this.shells.set(id, shell);
      return { id };
    } catch (err) {
      this.seq -= 1;
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  private get(id: string): Shell | undefined {
    return this.shells.get(id);
  }

  /** Drains new output since the last read; undefined for unknown ids. */
  read(id: string): string | undefined {
    const shell = this.get(id);
    if (!shell) return undefined;
    return shell.ring.drain();
  }

  status(id: string): "running" | "exited" | undefined {
    const shell = this.get(id);
    if (!shell) return undefined;
    return shell.running ? "running" : "exited";
  }

  exitCode(id: string): number | undefined {
    return this.get(id)?.exitCode;
  }

  count(): number {
    return [...this.shells.values()].filter(s => s.running).length;
  }

  ids(): string[] {
    return [...this.shells.keys()];
  }

  async kill(id: string): Promise<string | undefined> {
    const shell = this.get(id);
    if (!shell) return undefined;
    const remaining = shell.ring.drain();
    if (shell.running) {
      shell.child.kill();
      shell.running = false;
    }
    // Keep the entry so a final status/read still works; count() only
    // counts running shells, so the slot is freed either way.
    return `${remaining}Background shell ${id} killed.`.trim();
  }

  killAll(): void {
    for (const id of [...this.shells.keys()]) void this.kill(id);
  }
}
