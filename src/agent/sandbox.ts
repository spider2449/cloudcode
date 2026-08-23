import { spawnSync } from "node:child_process";
import type { NetworkMode } from "./networkPolicy.js";

/** A verified no-network wrapper for shell commands. Structural on purpose:
 * engine-layer tool contexts accept this shape without importing this module. */
export interface SandboxAdapter {
  readonly kind: "netns";
  wrap(command: string): { cmd: string; args: string[] };
}

export type SandboxProbeResult =
  | { available: true; adapter: SandboxAdapter }
  | { available: false; reason: string };

export type SandboxRunner =
  (cmd: string, args: string[], timeoutMs: number) => { status: number | null; stdout: string };

export const PROBE_TIMEOUT_MS = 5000;

// Prints one "<name> <operstate>" line per interface. A fresh netns has only
// lo, and lo starts DOWN — exactly "lo down" is the pass condition.
const PROBE_SCRIPT =
  'for i in /sys/class/net/*; do printf "%s %s\\n" "${i##*/}" "$(cat "$i/operstate")"; done';

function defaultRunner(cmd: string, args: string[], timeoutMs: number): { status: number | null; stdout: string } {
  const res = spawnSync(cmd, args, { timeout: timeoutMs, encoding: "utf8", windowsHide: true });
  return { status: res.status, stdout: typeof res.stdout === "string" ? res.stdout : "" };
}

interface Candidate {
  bin: string;
  prefix: string[];
}

function candidates(): Candidate[] {
  return [
    { bin: "unshare", prefix: ["-n"] },
    { bin: "bwrap", prefix: ["--unshare-net", "--dev-bind", "/", "/"] }
  ];
}

export function probeSandbox(
  runner: SandboxRunner = defaultRunner,
  platform: string = process.platform
): SandboxProbeResult {
  if (platform === "win32") {
    return { available: false, reason: "no-network sandbox requires Linux network namespaces" };
  }
  let lastReason = "no sandbox mechanism found (tried unshare, bwrap)";
  for (const c of candidates()) {
    const args = [...c.prefix, "/bin/sh", "-c", PROBE_SCRIPT];
    const res = runner(c.bin, args, PROBE_TIMEOUT_MS);
    // status null covers ENOENT, spawn errors, and timeouts: unusable, try next.
    if (res.status !== 0) continue;
    if (res.stdout.trim() !== "lo down") {
      lastReason = `${c.bin} ran but network isolation is not effective`;
      continue;
    }
    return { available: true, adapter: makeAdapter(c.bin) };
  }
  return { available: false, reason: lastReason };
}

function makeAdapter(bin: string): SandboxAdapter {
  return {
    kind: "netns",
    wrap(command: string) {
      if (bin === "bwrap") {
        return { cmd: "bwrap", args: ["--unshare-net", "--dev-bind", "/", "/", "/bin/sh", "-c", command] };
      }
      return { cmd: "unshare", args: ["-n", "/bin/sh", "-c", command] };
    }
  };
}

let cache: SandboxProbeResult | undefined;

export function probeSandboxCached(): SandboxProbeResult {
  if (!cache) cache = probeSandbox();
  return cache;
}

export function resetSandboxCacheForTests(): void {
  cache = undefined;
}

/** True when the current mode plus the machine's verified sandbox state
 * allows contained Bash execution. Only offlineStrict ever contains Bash. */
export function sandboxEnablesBash(mode: NetworkMode): boolean {
  return mode === "offlineStrict" && probeSandboxCached().available;
}
