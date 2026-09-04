# Desktop GUI Plan

## Goal

Add an optional desktop application with a three-pane, dark interface similar in
interaction model to the supplied reference: project/session navigation on the
left, a streamed conversation in the center, and an always-visible composer at
the bottom. Preserve the current `cloudcode` terminal application and keep all
agent execution, persistence, tool authorization, and project-trust decisions
in the existing Node codebase.

## 2026-09-01 scope revision: embed the existing TUI

The center pane now hosts the existing CloudCode terminal UI through xterm.js
and a main-process PTY. The desktop renderer does not reimplement transcripts,
streaming, commands, permissions, provider controls, Todos, or tool activity.
The left pane reads the session index and names sessions from their first user
message; the right pane reads scoped Git status. Selecting a session restarts
the PTY with its exact session ID, while New session starts the CLI without a
resume target.

This revision supersedes stages 1, 2, and 4 below where they propose a second
GUI conversation controller or renderer-owned conversation components. The
existing TUI remains the single interaction model and authority boundary.

## Project isolation

Every opened project is an independent workspace. A workspace is identified by
its canonical project root and owns its own controller, active `AgentSession`,
session list, turn queue, project-level settings overrides, project-trust
decision, MCP/LSP configuration, and change journal. A request for one
workspace must never read from, write to, resume, interrupt, authorize, or
display data belonging to another workspace.

The desktop process may host multiple workspace windows or tabs, but it must
route every command and stream event through an opaque workspace ID whose main
process mapping includes the canonical project root. The renderer must not
construct a project path or substitute a workspace ID. Global user preferences
may be shared only where the existing CLI already treats them as global; no
conversation history, permission grant, trust decision, provider secret, or
project configuration may cross workspace boundaries.

## Decision

Use Electron with a React renderer, rather than placing a WebView directly on
the current terminal renderer or adding a Tauri sidecar. CloudCode is already a
Node/TypeScript application, so an Electron main process can instantiate the
existing `AgentSession` directly. This avoids a second process protocol between
Rust and Node while retaining a strict renderer boundary through a preload API.

The renderer must have `nodeIntegration: false`, `contextIsolation: true`, and
no direct file-system, shell, environment, network-credential, or child-process
access. It can call only a closed, typed preload API. The main process remains
the authority for all state changes and agent operations.

## Explicitly out of scope for the first release

- Removing or replacing the terminal UI and its packaging.
- Arbitrary shell execution or file-system access from the renderer.
- A built-in source editor, Git client, or terminal emulator.
- Synchronizing sessions between machines or introducing an account service.
- Changing provider, permission, project-trust, MCP, LSP, or tool semantics.
- Sharing a session, permission approval, project trust, workspace settings, or
  change record between projects.

## Target architecture

```text
React renderer
  -> typed window.cloudcode API (preload, allowlisted)
  -> Electron main process
  -> existing AgentSession / EngineLoop / agent persistence
  -> providers, tools, trusted project configuration, local session files
```

The main process translates the existing `EngineMessage` stream into a
sanitized event contract. It must never expose raw error objects, environment
variables, API keys, executable paths, child-process handles, or unrestricted
paths to the renderer.

## Implementation stages

### 1. Extract a UI-neutral application controller

Create an `src/agent`-owned controller that owns an `AgentSession`, forwards
typed events, starts/interrupts/disposes a turn, lists/resumes/creates sessions,
and resolves permission requests. Move only reusable orchestration out of
`ui/nativeApp.ts`; do not make the engine depend on Electron or React.

Add near-1:1 controller tests using a fake session/event sink. Prove turn
serialization, interruption, permission resolution, session restoration, and
cleanup on window close.

### 2. Define the desktop IPC contract before implementing views

Add a shared, serializable contract for the closed commands and events:

- commands: `getInitialState`, `createSession`, `resumeSession`, `sendPrompt`,
  `interrupt`, `resolvePermission`, `updateSettings`, and `closeSession`;
- events: session list/state updates, transcript items, streamed text/thinking,
  Todo snapshots, tool activity, permission requests, and sanitized errors.

Validate incoming IPC payloads in the Electron main process. Use opaque session
IDs and renderer-safe display data. Keep any operation that mutates files or
executes a tool behind the existing permission and project-trust checks.

Add contract tests that reject unknown commands, malformed payloads, and
renderer-supplied paths outside the intended project scope. Add two-workspace
tests proving that events, session IDs, permissions, interruption, settings,
and file-change data cannot cross canonical project-root boundaries.

### 3. Create a minimal Electron desktop shell

Add an isolated `desktop/` package/configuration with Electron main and preload
entrypoints, a React/Vite renderer, an application icon, development scripts,
and production packaging scripts. Do not mix browser bundler configuration into
the CLI TypeScript build.

Start with a real backend status call, visible loading/error states, and a safe
window-close lifecycle that waits for controller disposal. Include a development
smoke test that confirms the preload API exists and calls the main process.

### 4. Implement the reference-style conversation workspace

Build these renderer components from the IPC state only:

- project header and session sidebar with new/resume actions;
- transcript with Markdown, streaming text, thinking disclosure, tool status,
  and Todo checklist;
- sticky composer with send/stop controls and model/permission indicators;
- modal permission overlay with the exact requested operation and allow/deny
  actions;
- settings and provider controls that use existing settings validation.

Use a responsive layout: collapse the sidebar at narrow widths, preserve the
composer, and provide accessible keyboard focus and labels. Reuse semantic theme
roles, but create browser CSS tokens rather than transporting ANSI rendering
code into the GUI.

### 5. File-change review and quality pass

Surface the existing change-journal information as read-only file and diff
previews. Approval continues to flow through the same backend permission
decision path. Add empty, loading, error, and reconnect/restart states.

Test React components with a fake preload API and add main-process integration
tests for stream ordering, permission prompts, and close-during-turn cleanup.
Add concurrent two-workspace integration coverage: one workspace can stream or
be interrupted without changing the other workspace's transcript, active turn,
or permission overlay.
Perform native Windows acceptance: create/resume a session, stream a reply,
approve and deny a permission, interrupt a turn, close the window, and verify
the process exits with no orphan child process.

### 6. Packaging, documentation, and release gate

Add separate desktop build/package scripts and CI jobs. Keep existing npm,
compiled-binary, and installer behavior unchanged. Extend version synchronization
to desktop metadata and enforce it in `tests/packaging.test.ts` if the desktop
package carries an independent version field.

Document installation, development, security boundaries, and the distinction
between GUI and CLI. Validate lint, size checks, TypeScript builds, unit tests,
desktop packaging, and a Windows native smoke test before release.

## Commit boundaries

1. `refactor(agent): add UI-neutral application controller`
2. `feat(desktop): add validated IPC contract and Electron shell`
3. `feat(desktop): add streamed conversation workspace`
4. `feat(desktop): add permission and change-review surfaces`
5. `build(desktop): package desktop application and document usage`

Each implementation commit must include the required patch-version increment in
`src/version.ts`, `package.json`, `package-lock.json`, and
`installer/cloudcode.iss`, plus its matching tests.

## Acceptance criteria

- The existing `cloudcode` terminal flow remains functional and unchanged in
  behavior.
- The desktop renderer cannot call Node, Electron, shell, or file-system APIs
  except through the declared preload methods.
- A GUI conversation uses the current engine/session implementation and renders
  streamed output, tools, Todos, errors, and permission prompts correctly.
- Permission and project-trust controls remain backend-authoritative.
- Two simultaneously opened projects have isolated session lists, transcripts,
  permissions, trust/configuration state, execution lifecycles, and change
  previews; a command or event tagged for one cannot affect the other.
- Window close interrupts/disposes active work and leaves no agent child process.
- All static checks pass, and native Windows interaction is verified manually.
