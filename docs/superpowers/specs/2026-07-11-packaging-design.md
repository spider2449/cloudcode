# cloudcode Packaging & Release Design

Date: 2026-07-11
Status: Approved

## Goal

Package the cloudcode CLI for deployment in three forms: an npm package for
developers, portable single-file executables for double-click use without
Node, and a Windows installer.

## Outputs

All artifacts land in a gitignored `release/` directory:

- `cloudcode-0.1.0.tgz` — npm tarball from `npm pack`; publishable later
  with `npm publish`.
- `cloudcode-win-x64.exe`, `cloudcode-macos-arm64`, `cloudcode-macos-x64`,
  `cloudcode-linux-x64` — portable single-file binaries built with
  `bun build --compile --target=<target>`.
- `cloudcode-setup-0.1.0.exe` — Windows installer built by Inno Setup from
  `installer/cloudcode.iss`.

## Why Bun compile

The `@anthropic-ai/claude-agent-sdk` dependency ships `extractFromBunfs.js`,
explicit support for running inside Bun single-file executables (it extracts
its subprocess CLI from the embedded filesystem at runtime). Node SEA/pkg
have no equivalent support and handle the SDK's ESM + subprocess model
poorly. Zip-based distribution was rejected as too heavy and not
double-click friendly.

## Build pipeline

npm scripts, with a small helper in `scripts/` where a plain script line is
not enough:

- `npm run build` — existing tsc build; source of truth for the npm package.
- `npm run package:npm` — build, then `npm pack --pack-destination release`.
- `npm run package:bin` — `bun build --compile src/cli.tsx` once per target
  (Bun compiles TS/TSX directly; tsc not needed for binaries).
- `npm run package:installer` — invoke the Inno Setup compiler (`iscc`) on
  `installer/cloudcode.iss`, which wraps the win-x64 exe, installs to
  Program Files, and adds it to PATH.
- `npm run package` — all of the above.

Build-machine prerequisites: Bun and Inno Setup installed locally.

## welcome.txt handling

The app reads `welcome.txt` from the package root at runtime.

- npm package: include `welcome.txt` via the package.json `files` field.
- Compiled binaries: embed the file (Bun asset import) or, failing that,
  degrade gracefully by skipping the welcome banner when the file is
  missing. The loader will be adapted so all three formats show the
  welcome message.

## package.json hygiene

Add `files` (dist, welcome.txt, README), `license`, `description`, and
`repository` fields so the npm tarball is clean and publish-ready.

## Verification

- npm tarball: global-install from the local `.tgz` and run a startup smoke
  test on Windows.
- win-x64 exe: run directly; verify startup and welcome banner.
- Installer: install, verify PATH and launch, then uninstall.
- macOS/Linux binaries: cross-compiled but not executable on this machine;
  shipped as untested-on-target.

## Out of scope

Code signing, auto-update, CI release automation, and actually running
`npm publish`.
