import { parseArgs } from "node:util";
import type { PermissionMode } from "./agent/session.js";
import { isNetworkMode, type NetworkMode } from "./agent/networkPolicy.js";
import { parseRunLimits } from "./print/runLimits.js";
import { isOutputFormat, type OutputFormat } from "./print/serialize.js";
import type { RunLimits } from "./engine/runLimits.js";

export const SUBCOMMANDS = ["doctor", "config", "mcp", "update", "task", "pack", "maintain", "login", "setup"] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

export type CliResult =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string }
  | { kind: "subcommand"; name: Subcommand; args: string[] }
  | { kind: "interactive"; continue: boolean; resume: boolean; provider?: string; networkMode?: NetworkMode }
  | { kind: "print"; prompt?: string; continue: boolean; provider?: string; permissionMode: PermissionMode; trustProjectConfig: boolean; networkMode?: NetworkMode; outputFormat: OutputFormat; runLimits: RunLimits };

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
   task      Run an isolated local engineering task
   pack      Manage local workflow packs
   maintain  Run bounded local maintenance profiles
  login     Sign in with a Claude.ai subscription (login | logout | status)
  setup     Interactive walkthrough of providers, MCP servers, permissions, and settings

Options:
  -c, --continue                Resume the most recent session for this directory
  -r, --resume                  Open the session picker on start
      --provider <name>         Use a provider from ~/.cloudcode/providers.json
      --network-mode <mode>     offlineStrict | providerOnly | unrestricted
  -p, --print [prompt]          Non-interactive mode; prompt as argument or on stdin
      --permission-mode <mode>  default | acceptEdits | bypassPermissions (with -p only)
      --trust-project-config    Allow this project's MCP/LSP commands (with -p only)
      --output-format <format>  text | json | stream-json (with -p only)
      --max-turns <count>       Maximum provider requests (with -p only)
      --timeout <duration>      Complete run timeout, e.g. 10m (with -p only)
      --max-cost-usd <amount>   Known-model cost cap (with -p only)
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
    provider?: string; "network-mode"?: string; "permission-mode"?: string; "trust-project-config": boolean;
    "output-format"?: string; "max-turns"?: string; timeout?: string; "max-cost-usd"?: string;
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
        "network-mode": { type: "string" },
        "permission-mode": { type: "string" },
        "trust-project-config": { type: "boolean", default: false },
        "output-format": { type: "string" },
        "max-turns": { type: "string" },
        timeout: { type: "string" },
        "max-cost-usd": { type: "string" }
      }
    }));
  } catch (err) {
    // parseArgs error messages run several sentences; keep only the first.
    const msg = (err instanceof Error ? err.message : String(err)).split(". ")[0];
    return { kind: "error", message: `${msg}. Run cloudcode --help for usage.` };
  }
  if (values.help) return { kind: "help" };
  if (values.version) return { kind: "version" };
  const networkMode = values["network-mode"];
  if (networkMode !== undefined && !isNetworkMode(networkMode)) {
    return { kind: "error", message: `Invalid --network-mode "${networkMode}". Valid: offlineStrict, providerOnly, unrestricted.` };
  }
  const mode = values["permission-mode"];
  const printOnlyUsed = mode !== undefined || values["trust-project-config"] || values["output-format"] !== undefined ||
    values["max-turns"] !== undefined || values.timeout !== undefined || values["max-cost-usd"] !== undefined;
  if (printOnlyUsed && !values.print) {
    return { kind: "error", message: "Print automation flags are only valid with --print. Run cloudcode --help for usage." };
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
    const outputFormat = values["output-format"] ?? "text";
    if (!isOutputFormat(outputFormat)) {
      return { kind: "error", message: `Invalid --output-format "${outputFormat}". Valid: text, json, stream-json.` };
    }
    let runLimits: RunLimits;
    try {
      runLimits = parseRunLimits({
        maxTurns: values["max-turns"], timeout: values.timeout, maxCostUsd: values["max-cost-usd"]
      });
    } catch (err) {
      return { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
    return {
      kind: "print",
      prompt: positionals[0],
      continue: values.continue,
      provider: values.provider,
      permissionMode: (mode as PermissionMode) ?? "default",
      trustProjectConfig: values["trust-project-config"],
      ...(networkMode ? { networkMode: networkMode as NetworkMode } : {}),
      outputFormat,
      runLimits
    };
  }
  if (positionals.length > 0) {
    return { kind: "error", message: `Unexpected argument "${positionals[0]}". Run cloudcode --help for usage.` };
  }
  return {
    kind: "interactive", continue: values.continue, resume: values.resume, provider: values.provider,
    ...(networkMode ? { networkMode: networkMode as NetworkMode } : {})
  };
}

export function networkModeFromArgs(args: string[]): { mode?: NetworkMode; error?: string } {
  const index = args.indexOf("--network-mode");
  if (index === -1) return {};
  const value = args[index + 1];
  if (!isNetworkMode(value)) {
    return { error: `Invalid --network-mode "${value ?? ""}". Valid: offlineStrict, providerOnly, unrestricted.` };
  }
  if (args.length !== 2 || index !== 0) {
    return { error: "Unexpected command arguments. Only --network-mode <mode> is supported." };
  }
  return { mode: value };
}
