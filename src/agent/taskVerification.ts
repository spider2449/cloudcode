import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface VerificationCommand {
  command: string;
  args: string[];
  timeoutMs: number;
}

export interface VerificationProfile {
  name: string;
  commands: VerificationCommand[];
}

export interface VerificationCommandResult {
  command: string;
  args: string[];
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  interrupted: boolean;
  truncated: boolean;
}

export interface VerificationResult {
  profile: string;
  success: boolean;
  startedAt: string;
  completedAt: string;
  commands: VerificationCommandResult[];
}

export type VerificationEvent =
  | { kind: "verification.command.started"; index: number; command: string; args: string[] }
  | { kind: "verification.command.finished"; index: number; result: VerificationCommandResult };

const DEFAULT_TIMEOUT = 10 * 60_000;
const OUTPUT_LIMIT = 128 * 1024;

function commandEntry(value: unknown): VerificationCommand | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as { command?: unknown; args?: unknown; timeoutMs?: unknown };
  if (typeof entry.command !== "string" || entry.command === "") return undefined;
  if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some(arg => typeof arg !== "string"))) return undefined;
  if (entry.timeoutMs !== undefined && (!Number.isSafeInteger(entry.timeoutMs) || Number(entry.timeoutMs) <= 0)) return undefined;
  return { command: entry.command, args: (entry.args as string[] | undefined) ?? [], timeoutMs: Number(entry.timeoutMs ?? DEFAULT_TIMEOUT) };
}

export function loadVerificationProfiles(cwd: string): { profiles: VerificationProfile[]; warnings: string[] } {
  const path = join(cwd, ".cloudcode", "task.json");
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch { return { profiles: [], warnings: [] }; }
  const profilesRaw = raw && typeof raw === "object" ? (raw as { profiles?: unknown }).profiles : undefined;
  if (!profilesRaw || typeof profilesRaw !== "object" || Array.isArray(profilesRaw)) {
    return { profiles: [], warnings: [`${path}: profiles must be an object.`] };
  }
  const profiles: VerificationProfile[] = [];
  const warnings: string[] = [];
  for (const [name, value] of Object.entries(profilesRaw)) {
    const entries = value && typeof value === "object" ? (value as { commands?: unknown }).commands : undefined;
    if (!Array.isArray(entries)) { warnings.push(`${name}: commands must be an array.`); continue; }
    const commands = entries.map(commandEntry);
    if (commands.some(command => command === undefined)) { warnings.push(`${name}: invalid command entry.`); continue; }
    profiles.push({ name, commands: commands as VerificationCommand[] });
  }
  return { profiles, warnings };
}

export type VerificationRunner = (
  command: VerificationCommand, cwd: string, signal?: AbortSignal
) => Promise<VerificationCommandResult>;

function append(chunks: Buffer[], size: number, chunk: Buffer): { size: number; truncated: boolean } {
  if (size >= OUTPUT_LIMIT) return { size, truncated: true };
  const remaining = OUTPUT_LIMIT - size;
  chunks.push(chunk.subarray(0, remaining));
  return { size: size + Math.min(chunk.length, remaining), truncated: chunk.length > remaining };
}

export const runVerificationCommand: VerificationRunner = (entry, cwd, signal) => new Promise(resolvePromise => {
  const started = Date.now();
  const child = spawn(entry.command, entry.args, { cwd, shell: false, windowsHide: true });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutSize = 0;
  let stderrSize = 0;
  let truncated = false;
  let timedOut = false;
  let interrupted = false;
  let settled = false;
  const stop = () => { if (!child.killed) child.kill(); };
  const timer = setTimeout(() => { timedOut = true; stop(); }, entry.timeoutMs);
  const onAbort = () => { interrupted = true; stop(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  child.stdout.on("data", (chunk: Buffer) => {
    const value = append(stdout, stdoutSize, chunk); stdoutSize = value.size; truncated ||= value.truncated;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const value = append(stderr, stderrSize, chunk); stderrSize = value.size; truncated ||= value.truncated;
  });
  const finish = (code: number, error?: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    resolvePromise({
      command: entry.command, args: entry.args, code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: error ?? Buffer.concat(stderr).toString("utf8"),
      durationMs: Date.now() - started, timedOut, interrupted, truncated
    });
  };
  child.on("error", error => finish(-1, error.message));
  child.on("close", code => finish(code ?? -1));
});

export async function runVerification(input: {
  cwd: string; profile: VerificationProfile; signal?: AbortSignal;
  runner?: VerificationRunner; onEvent?: (event: VerificationEvent) => void;
}): Promise<VerificationResult> {
  const startedAt = new Date().toISOString();
  const results: VerificationCommandResult[] = [];
  const runner = input.runner ?? runVerificationCommand;
  for (let index = 0; index < input.profile.commands.length; index++) {
    if (input.signal?.aborted) break;
    const command = input.profile.commands[index];
    input.onEvent?.({ kind: "verification.command.started", index, command: command.command, args: command.args });
    const result = await runner(command, input.cwd, input.signal);
    results.push(result);
    input.onEvent?.({ kind: "verification.command.finished", index, result });
    if (result.code !== 0 || result.timedOut || result.interrupted) break;
  }
  return {
    profile: input.profile.name,
    success: results.length === input.profile.commands.length && results.every(result => result.code === 0),
    startedAt, completedAt: new Date().toISOString(), commands: results
  };
}
