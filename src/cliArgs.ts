import { parseArgs } from "node:util";
import type { PermissionMode } from "./agent/session.js";

export const SUBCOMMANDS = ["doctor", "config", "mcp", "update"] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

export type CliResult =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string }
  | { kind: "subcommand"; name: Subcommand; args: string[] }
  | { kind: "interactive"; continue: boolean; resume: boolean; provider?: string }
  | { kind: "print"; prompt?: string; continue: boolean; provider?: string; permissionMode: PermissionMode };

const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "bypassPermissions"];

export const HELP_TEXT = `cloudcode - terminal AI coding agent

Usage:
  cloudcode [options]              Start an interactive session
  cloudcode -p [prompt] [options]  Run one prompt non-interactively and exit
  cloudcode <command>

Commands:
  doctor    Check environment and configuration health
  config    Show config file paths and effective settings
  mcp       List configured MCP servers
  update    Update cloudcode to the latest version

Options:
  -c, --continue                Resume the most recent session for this directory
  -r, --resume                  Open the session picker on start
      --provider <name>         Use a provider from ~/.cloudcode/providers.json
  -p, --print [prompt]          Non-interactive mode; prompt as argument or on stdin
      --permission-mode <mode>  default | acceptEdits | bypassPermissions (with -p only)
  -v, --version                 Print version and exit
  -h, --help                    Show this help`;

export function parseCli(argv: string[]): CliResult {
  const first = argv[0];
  if (first !== undefined && !first.startsWith("-")) {
    if ((SUBCOMMANDS as readonly string[]).includes(first)) {
      return { kind: "subcommand", name: first as Subcommand, args: argv.slice(1) };
    }
    return { kind: "error", message: `Unknown command "${first}". Run cloudcode --help for usage.` };
  }
  let values: {
    help: boolean; version: boolean; continue: boolean; resume: boolean; print: boolean;
    provider?: string; "permission-mode"?: string;
  };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
        continue: { type: "boolean", short: "c", default: false },
        resume: { type: "boolean", short: "r", default: false },
        print: { type: "boolean", short: "p", default: false },
        provider: { type: "string" },
        "permission-mode": { type: "string" }
      }
    }));
  } catch (err) {
    // parseArgs error messages run several sentences; keep only the first.
    const msg = (err instanceof Error ? err.message : String(err)).split(". ")[0];
    return { kind: "error", message: `${msg}. Run cloudcode --help for usage.` };
  }
  if (values.help) return { kind: "help" };
  if (values.version) return { kind: "version" };
  const mode = values["permission-mode"];
  if (mode !== undefined && !values.print) {
    return { kind: "error", message: "--permission-mode is only valid with --print. Run cloudcode --help for usage." };
  }
  if (values.print) {
    if (mode !== undefined && !PERMISSION_MODES.includes(mode as PermissionMode)) {
      return { kind: "error", message: `Invalid --permission-mode "${mode}". Valid: ${PERMISSION_MODES.join(", ")}.` };
    }
    if (values.resume) {
      return { kind: "error", message: "--resume is not supported with --print; use --continue." };
    }
    if (positionals.length > 1) {
      return { kind: "error", message: "Too many arguments: expected at most one prompt. Run cloudcode --help for usage." };
    }
    return {
      kind: "print",
      prompt: positionals[0],
      continue: values.continue,
      provider: values.provider,
      permissionMode: (mode as PermissionMode) ?? "default"
    };
  }
  if (positionals.length > 0) {
    return { kind: "error", message: `Unexpected argument "${positionals[0]}". Run cloudcode --help for usage.` };
  }
  return { kind: "interactive", continue: values.continue, resume: values.resume, provider: values.provider };
}
