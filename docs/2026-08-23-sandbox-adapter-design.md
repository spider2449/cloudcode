# Sandbox adapter (Linux netns) design

Date: 2026-08-23

## Goal

Close the last open promise of Phase 0 in the local-first roadmap: when
`offlineStrict` is active, `Bash` becomes available with a positively verified
"no network" guarantee instead of being unconditionally disabled.

The seam already exists: `bashNetworkStatus(mode, verifiedNoNetworkSandbox)` and
`AgentSessionOpts.verifiedNoNetworkSandbox` are wired everywhere but every call
site passes `false`. This design adds the component that can truthfully pass
`true`.

## Scope decisions

- **Platform: Linux first.** Windows has no built-in per-child network
  containment without native code or a full VM, so it reports unavailable. macOS
  (`sandbox-exec`) is deferred.
- **Activation: automatic.** When a probe verifies containment under
  `offlineStrict`, Bash is available immediately; no opt-in flag.
- **Mechanism: launch-time probe + per-command wrapping** via `unshare -n`
  (util-linux) or `bubblewrap` (`bwrap --unshare-net`).

Rejected alternatives: shell-profile-based blocking (trivially bypassed, not a
guarantee), and a generic adapter registry/config system (one implementation
does not justify it; the interface leaves room without building it).

## New module: `src/agent/sandbox.ts`

Lives in `src/agent/` because it describes the user's machine, not provider
turn semantics.

```ts
export interface SandboxAdapter {
  readonly kind: "netns";
  wrap(command: string): { cmd: string; args: string[] };
}

export type SandboxProbeResult =
  | { available: true; adapter: SandboxAdapter }
  | { available: false; reason: string };

export async function probeSandbox(): Promise<SandboxProbeResult>;
```

Probe logic:

1. Non-Windows platforms only; anything else returns `{ available: false }`
   with a human-readable reason for doctor/config display.
2. Locate `unshare` first, then `bwrap`.
3. Functional verification: run `sh -c 'ls /sys/class/net'` inside the sandbox
   and require that only `lo` is present and its state is DOWN. A fresh,
   down-loopback-only netns has no external connectivity.
4. Probe runs once per process, from `AgentSession.start()`. Any failure —
   missing binary, 5 s timeout, unexpected output — means "no sandbox".
   No guessing, no partial credit.

`wrap()` rewrites any command to `unshare -n sh -c <command>` (or the bwrap
equivalent) as an argument array for `execFile`.

## Modified files

| File | Change |
|------|--------|
| `src/agent/session.ts` | Probe during `start()`; store the result in the existing `verifiedNoNetworkSandbox` option slot and expose the adapter through tool context |
| `src/engine/tools/types.ts` | Add optional `sandbox?: SandboxAdapter` to tool context |
| `src/engine/tools/bash.ts` | When `ctx.sandbox` exists, wrap the command before `execFile`; background start path wraps identically |
| `src/engine/tools/backgroundShells.ts` | Wrap commands at shell start |
| `src/commands/cli/doctor.ts` | Report real probe results instead of hardcoded `false` |
| `src/commands/cli/config.ts` | Same |
| `src/ui/networkController.ts` | Live status shows contained/unavailable from the session's verified state |

## Data flow

1. `AgentSession.start()` → `probeSandbox()` → on success the tool registry
   keeps Bash, `bashNetworkStatus("offlineStrict", true)` returns
   `{ available: true, description: "contained" }`, and status/config/doctor
   surfaces say so.
2. Model calls Bash → `bash.ts` sees `ctx.sandbox`, calls `wrap()`, spawns the
   wrapped argv. Background shells wrap at `start()`.
3. If the probe fails, nothing changes from today: Bash stays disabled with its
   current reason surfaced.

## Error handling (fail closed)

- Probe failure of any kind ⇒ "no sandbox"; never infer success.
- If a wrapped spawn itself fails at execution time, the error flows through
  the existing per-tool boundary as an error tool result. No retry, and never
  a fallback to unwrapped execution.
- No mid-session re-probing in v1.

## Testing

Per-module focused tests following repository convention:

- `tests/sandbox.test.ts`: injected fake runner — probe passes; binary missing;
  extra interface besides `lo`; `lo` UP; timeout; non-Windows short-circuit.
  `wrap()` produces exact argument arrays.
- `tests/engine-bash-tool.test.ts`: with sandbox present, spawned cmd/args are
  wrapped; wrapped-spawn failure yields an error tool result and never retries
  unwrapped.
- Extend `tests/engine-bg-bash.test.ts`, `tests/networkController.test.ts`,
  `tests/cliDoctor.test.ts` for wiring.
