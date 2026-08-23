import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./providers.js";
import {
  inspectProjectExecutableConfig,
  ProjectTrustStore
} from "./projectTrust.js";

export type HookEvent =
  | "SessionStart" | "UserPromptSubmit" | "PreToolUse"
  | "PostToolUse" | "Stop" | "SessionEnd";

export const HOOK_EVENTS: readonly HookEvent[] = [
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"
];

export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;

export interface HookEntry { command: string; timeoutMs?: number }

export interface HooksConfig {
  hooks: Partial<Record<HookEvent, HookEntry[]>>;
  warnings: string[];
  /** True when a project hooks file exists but its config is not trusted. */
  projectUntrusted: boolean;
}

export type HookExecutor = (
  command: string,
  options: { input: string; timeoutMs: number }
) => Promise<{ code: number; stderr: string }>;

export interface HookOutcome { blocked: boolean; notices: string[] }

function isHookEntry(value: unknown): value is HookEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as { command?: unknown; timeoutMs?: unknown };
  if (typeof entry.command !== "string" || entry.command === "") return false;
  if (entry.timeoutMs !== undefined && (typeof entry.timeoutMs !== "number" || entry.timeoutMs <= 0)) return false;
  return true;
}

/** Validates one parsed hooks.json "hooks" object; skips junk with warnings. */
function parseEntries(events: unknown, source: string): {
  hooks: Partial<Record<HookEvent, HookEntry[]>>;
  warnings: string[];
} {
  const hooks: Partial<Record<HookEvent, HookEntry[]>> = {};
  const warnings: string[] = [];
  if (!events || typeof events !== "object" || Array.isArray(events)) return { hooks, warnings };
  for (const [event, rawEntries] of Object.entries(events)) {
    if (!HOOK_EVENTS.includes(event as HookEvent)) {
      warnings.push(`${source}: ignoring unknown hook event "${event}"`);
      continue;
    }
    if (!Array.isArray(rawEntries)) {
      warnings.push(`${source}: hook event "${event}" must be an array`);
      continue;
    }
    const entries: HookEntry[] = [];
    for (const raw of rawEntries) {
      if (!isHookEntry(raw)) {
        warnings.push(`${source}: skipping invalid ${event} hook entry`);
        continue;
      }
      entries.push(raw);
    }
    if (entries.length > 0) hooks[event as HookEvent] = entries;
  }
  return { hooks, warnings };
}

function readLayer(path: string): { hooks: Partial<Record<HookEvent, HookEntry[]>>; warnings: string[] } {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const events = (raw as { hooks?: unknown }).hooks;
    return parseEntries(events, path);
  } catch {
    // Missing or unreadable file simply contributes nothing.
    return { hooks: {}, warnings: [] };
  }
}

function layerExists(layer: { hooks: Partial<Record<HookEvent, HookEntry[]>>; warnings: string[] }): boolean {
  return layer.warnings.length > 0 || Object.keys(layer.hooks).length > 0;
}

export function loadHooksConfig(
  cwd: string,
  base: string = configDir(),
  trust: ProjectTrustStore = new ProjectTrustStore()
): HooksConfig {
  const user = readLayer(join(base, "hooks.json"));

  let projectUntrusted = false;
  let project = { hooks: {} as Partial<Record<HookEvent, HookEntry[]>>, warnings: [] as string[] };
  const probe = readLayer(join(cwd, ".cloudcode", "hooks.json"));
  if (layerExists(probe)) {
    const descriptor = inspectProjectExecutableConfig(cwd, base);
    if (descriptor && trust.isTrusted(descriptor)) {
      project = probe;
    } else {
      projectUntrusted = true;
    }
  }

  const hooks: Partial<Record<HookEvent, HookEntry[]>> = {};
  for (const event of HOOK_EVENTS) {
    const merged = [...(user.hooks[event] ?? []), ...(project.hooks[event] ?? [])];
    if (merged.length > 0) hooks[event] = merged;
  }
  return {
    hooks,
    warnings: [...user.warnings, ...project.warnings],
    projectUntrusted
  };
}

// Same shell selection as tools/bash.ts so hooks behave identically across
// platforms without each entry needing to spell out its interpreter.
function shellArgs(command: string): { cmd: string; args: string[] } {
  if (process.platform === "win32") {
    return { cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command] };
  }
  return { cmd: "/bin/sh", args: ["-c", command] };
}

const defaultExecutor: HookExecutor = (command, options) =>
  new Promise(resolvePromise => {
    const { cmd, args } = shellArgs(command);
    let eventName = "";
    try {
      eventName = (JSON.parse(options.input) as { event?: unknown }).event?.toString() ?? "";
    } catch {
      eventName = "";
    }
    const child = execFile(cmd, args, {
      cwd: process.cwd(),
      timeout: options.timeoutMs,
      windowsHide: true,
      env: { ...process.env, CLOUDCODE_HOOK_EVENT: eventName }
    }, (err, _stdout, stderr) => {
      // execFile passes err === null on success; guard before reading fields.
      const killed = err !== null && (err as { killed?: boolean }).killed === true;
      const code = err === null
        ? 0
        : typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1;
      resolvePromise({
        code,
        stderr: `${killed ? `[hook timed out after ${options.timeoutMs}ms]\n` : ""}${stderr}`
      });
    });
    child.stdin?.end(options.input);
  });

/**
 * Runs every registered entry for an event sequentially. Failures are always
 * isolated to their entry; whether a failure blocks depends on the event
 * (only PreToolUse is fail-closed).
 */
export class HooksRunner {
  constructor(
    private readonly entries: Partial<Record<HookEvent, HookEntry[]>>,
    private readonly cwd: string,
    private readonly executor: HookExecutor = defaultExecutor
  ) {}

  run(event: HookEvent, payload: Record<string, unknown> = {}): Promise<HookOutcome> {
    return this.runAll(this.entries[event] ?? [], event, payload);
  }

  private async runAll(
    entries: HookEntry[],
    event: HookEvent,
    payload: Record<string, unknown>
  ): Promise<HookOutcome> {
    const notices: string[] = [];
    let blocked = false;
    for (const entry of entries) {
      const timeoutMs = entry.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
      const input = JSON.stringify({ event, ...payload });
      try {
        const result = await this.executor(entry.command, { input, timeoutMs });
        if (result.code !== 0) {
          const detail = result.stderr.trim() || `exit code ${result.code}`;
          notices.push(`hook "${entry.command}" failed: ${detail}`);
          if (event === "PreToolUse") blocked = true;
        }
      } catch (err) {
        notices.push(`hook "${entry.command}" failed: ${err instanceof Error ? err.message : String(err)}`);
        if (event === "PreToolUse") blocked = true;
      }
    }
    return { blocked, notices };
  }
}
