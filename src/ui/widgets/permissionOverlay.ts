import type { PermissionRequest } from "../../agent/session.js";
import type { Key } from "../input.js";
import { toolLabel } from "../transcript.js";
import { sgr, SGR_RESET } from "../term/ansi.js";
import type { Theme } from "../theme.js";
import { commandPrefix } from "../../agent/permissionStore.js";
import { hostScope, ruleScope } from "../../engine/permissions.js";

export type PermissionDecisionHandler = (
  allow: boolean,
  rememberAs?: "allow" | "deny"
) => void;

interface PermOption {
  label: string;
  hotkey: string;
  allow: boolean;
  rememberAs?: "allow" | "deny";
}

const BASE_OPTIONS: PermOption[] = [
  { label: "Yes (y)", hotkey: "y", allow: true },
  { label: "No (n)", hotkey: "n", allow: false }
];

const FILE_OPTIONS: PermOption[] = [
  { label: "Yes (y)", hotkey: "y", allow: true },
  { label: "Always for this directory (a)", hotkey: "a", allow: true, rememberAs: "allow" },
  { label: "No (n)", hotkey: "n", allow: false },
  { label: "Never for this directory (d)", hotkey: "d", allow: false, rememberAs: "deny" }
];

function commandOptions(prefix: string): PermOption[] {
  return [
    { label: "Yes (y)", hotkey: "y", allow: true },
    { label: `Always allow '${prefix}' commands (a)`, hotkey: "a", allow: true, rememberAs: "allow" },
    { label: "No (n)", hotkey: "n", allow: false },
    { label: `Never allow '${prefix}' commands (d)`, hotkey: "d", allow: false, rememberAs: "deny" }
  ];
}

function hostOptions(host: string): PermOption[] {
  return [
    { label: "Yes (y)", hotkey: "y", allow: true },
    { label: `Always allow ${host} (a)`, hotkey: "a", allow: true, rememberAs: "allow" },
    { label: "No (n)", hotkey: "n", allow: false },
    { label: `Never allow ${host} (d)`, hotkey: "d", allow: false, rememberAs: "deny" }
  ];
}

interface PermissionState {
  request: PermissionRequest;
  options: PermOption[];
  selected: number;
  onDecision: PermissionDecisionHandler;
}

// State-owning permission prompt: option model, key handling, and row
// rendering for the overlay's permission mode. The manager keeps only the
// mode flag and delegates; dismiss() is the manager's close, called before
// the decision callback exactly as before.
export class PermissionOverlay {
  private state: PermissionState | undefined;

  get isOpen(): boolean {
    return this.state !== undefined;
  }

  open(request: PermissionRequest, onDecision: PermissionDecisionHandler): void {
    // Offer "always" exactly when a remembered rule would actually be
    // consulted later: path-scoped (see ruleScope), command-prefix (Bash),
    // or host-scoped (WebFetch).
    const hasPathRule = ruleScope(request.toolName, request.input) !== undefined;
    const isBashCommand = request.toolName === "Bash" && typeof request.input.command === "string";
    const host = hostScope(request.toolName, request.input);
    const options = hasPathRule
      ? FILE_OPTIONS
      : isBashCommand
        ? commandOptions(commandPrefix(String(request.input.command)))
        : host
          ? hostOptions(host)
          : BASE_OPTIONS;
    this.state = { request, options, selected: 0, onDecision };
  }

  reset(): void {
    this.state = undefined;
  }

  handleKey(k: Key, input: string | undefined, dismiss: () => void): void {
    const s = this.state;
    if (!s) return;
    const decide = (opt: PermOption) => {
      const cb = s.onDecision;
      dismiss();
      cb(opt.allow, opt.rememberAs);
    };
    if (input) {
      const hot = s.options.find(o => o.hotkey === input.toLowerCase());
      if (hot) { decide(hot); return; }
    }
    if (k.t === "esc") { const cb = s.onDecision; dismiss(); cb(false); return; }
    if (k.t === "left" || k.t === "up") { s.selected = (s.selected + s.options.length - 1) % s.options.length; return; }
    if (k.t === "right" || k.t === "down") { s.selected = (s.selected + 1) % s.options.length; return; }
    if (k.t === "enter") decide(s.options[s.selected]);
  }

  render(theme: Theme, width: number): string[] {
    const s = this.state;
    if (!s) return [];
    const warning = sgr(theme.warning);
    const optionsLine = s.options
      .map((o, i) => (i === s.selected ? `\x1b[7m ${o.label} \x1b[27m` : ` ${o.label} `))
      .join("  ");
    return [
      "╭" + "─".repeat(Math.max(0, width - 2)) + "╮",
      `${warning}Permission required${SGR_RESET}`,
      toolLabel(s.request.toolName, s.request.input),
      optionsLine,
      "╰" + "─".repeat(Math.max(0, width - 2)) + "╯"
    ];
  }
}
