# cloudcode Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce three release artifacts for the cloudcode CLI: an npm tarball, portable single-file executables (win-x64, macos-arm64, macos-x64, linux-x64), and a Windows installer.

**Architecture:** `npm pack` distributes the existing tsc build. Bun's `bun build --compile` cross-compiles `src/cli.tsx` (via a Bun-only wrapper that embeds `welcome.txt`) into standalone binaries; the `@anthropic-ai/claude-agent-sdk` explicitly supports Bun single-file executables via its `extractFromBunfs.js`. Inno Setup wraps the win-x64 exe into an installer that adds it to PATH. Everything lands in a gitignored `release/` directory.

**Tech Stack:** TypeScript, tsc, Bun (compiler only — runtime stays Node for npm package), Inno Setup 6, npm scripts.

## Global Constraints

- All code, comments, and docs in English only.
- Node >= 18 remains the engine for the npm package; do not add runtime dependencies.
- Build prerequisites (installed on the build machine, not shipped): Bun, Inno Setup 6.
- Version strings come from `package.json` version `0.1.0`; artifact names: `cloudcode-0.1.0.tgz`, `cloudcode-win-x64.exe`, `cloudcode-macos-arm64`, `cloudcode-macos-x64`, `cloudcode-linux-x64`, `cloudcode-setup-0.1.0.exe`.
- `npm publish` is out of scope; never run it.
- macOS/Linux binaries are cross-compiled and cannot be executed on this machine; they ship untested-on-target.

---

### Task 1: package.json hygiene + release dir + npm tarball script

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `npm run package:npm` → `release/cloudcode-0.1.0.tgz`; `release/` directory convention used by all later tasks.

- [ ] **Step 1: Add metadata, files whitelist, and package:npm script to package.json**

Merge these fields into `package.json` (keep all existing fields):

```json
{
  "description": "Terminal AI coding agent built on the Claude Agent SDK",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/spider/cloudcode.git"
  },
  "files": [
    "dist",
    "welcome.txt",
    "README.md"
  ],
  "scripts": {
    "dev": "tsx src/cli.tsx",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "package:npm": "npm run build && npm pack --pack-destination release"
  }
}
```

Note: check `git remote -v` first; if a real remote URL exists, use it for `repository.url` instead of the placeholder above. If none exists, omit the `repository` field entirely.

- [ ] **Step 2: Gitignore release/**

Append to `.gitignore`:

```
release/
```

- [ ] **Step 3: Build the tarball**

Run: `New-Item -ItemType Directory -Force release; npm run package:npm`
Expected: creates `release/cloudcode-0.1.0.tgz` with no errors.

- [ ] **Step 4: Verify tarball contents**

Run: `tar -tzf release/cloudcode-0.1.0.tgz`
Expected: contains `package/package.json`, `package/README.md`, `package/welcome.txt`, `package/dist/cli.js` (and other dist files); does NOT contain `src/`, `tests/`, `docs/`, `node_modules/`.

- [ ] **Step 5: Smoke test global install from tarball**

Run: `npm install -g .\release\cloudcode-0.1.0.tgz; cloudcode --version`
Expected: prints `cloudcode 0.1.0`.
Then clean up: `npm uninstall -g cloudcode`

- [ ] **Step 6: Commit**

```powershell
git add package.json .gitignore
git commit -m "feat: npm packaging script and publish-ready metadata"
```

---

### Task 2: Embedded welcome text support in loadWelcome

The compiled binary has no `welcome.txt` on disk next to it. Add a module-level embedded-text override that the Bun entry wrapper (Task 3) sets before the app renders. File on disk (npm/dev path) stays the default; embedded text is the fallback when the file read fails.

**Files:**
- Modify: `src/ui/welcome.ts`
- Test: `tests/welcome.test.ts` (add cases to the existing file; if welcome tests live elsewhere, add them to that file instead)

**Interfaces:**
- Consumes: existing `loadWelcome(vars: WelcomeVars, filePath?: string): string | undefined`.
- Produces: `setEmbeddedWelcome(text: string): void` exported from `src/ui/welcome.ts`. `loadWelcome` behavior: file read wins; on file-read failure, embedded text (if set) is used with the same placeholder substitution; otherwise `undefined`.

- [ ] **Step 1: Write the failing tests**

Add to the welcome test file:

```typescript
import { loadWelcome, setEmbeddedWelcome } from "../src/ui/welcome.js";

describe("embedded welcome", () => {
  it("falls back to embedded text when the file is missing", () => {
    setEmbeddedWelcome("Embedded {version} on {provider}");
    const out = loadWelcome(
      { version: "9.9.9", provider: "anthropic" },
      "Z:/definitely/missing/welcome.txt"
    );
    expect(out).toBe("Embedded 9.9.9 on anthropic");
  });

  it("still prefers the file on disk when it exists", () => {
    setEmbeddedWelcome("Embedded {version}");
    // welcome.txt at package root exists in the repo
    const out = loadWelcome({ version: "1.0.0", provider: "anthropic" });
    expect(out).not.toBe("Embedded 1.0.0");
    expect(out).toContain("1.0.0");
  });
});
```

Adjust the import path/relative depth to match how existing tests import `welcome.ts`. If existing tests use `test(...)` instead of `it(...)`, match that.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/welcome.test.ts`
Expected: FAIL — `setEmbeddedWelcome` is not exported.

- [ ] **Step 3: Implement**

In `src/ui/welcome.ts`, add a module-level variable and setter, and use it in the catch path. The full updated file:

```typescript
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface WelcomeVars {
  version: string;
  provider: string;
  model?: string;
}

let embeddedWelcome: string | undefined;

/** Used by single-file binary builds, where welcome.txt is embedded rather than on disk. */
export function setEmbeddedWelcome(text: string): void {
  embeddedWelcome = text;
}

function defaultPath(): string {
  // src/ui/ (dev) and dist/ui/ (build) are both two levels below package root.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "welcome.txt");
}

export function loadWelcome(vars: WelcomeVars, filePath = defaultPath()): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    if (embeddedWelcome === undefined) return undefined;
    raw = embeddedWelcome;
  }
  const values: Record<string, string> = {
    version: vars.version,
    provider: vars.provider,
    model: vars.model ?? ""
  };
  return raw
    .replace(/\{(version|provider|model)\}/g, (_, key: string) => values[key])
    .replace(/\r\n/g, "\n")
    .replace(/\n+$/, "");
}
```

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all tests PASS (new ones included).

- [ ] **Step 5: Commit**

```powershell
git add src/ui/welcome.ts tests/
git commit -m "feat: embedded welcome text fallback for single-file binaries"
```

---

### Task 3: Bun-compiled portable binaries

**Files:**
- Create: `scripts/bin-entry.ts` (Bun-only entrypoint; lives outside tsconfig `include` so tsc never sees its import attribute)
- Create: `scripts/build-binaries.ps1`
- Modify: `package.json` (add `package:bin` script)

**Interfaces:**
- Consumes: `setEmbeddedWelcome(text: string)` from Task 2.
- Produces: `npm run package:bin` → `release/cloudcode-win-x64.exe`, `release/cloudcode-macos-arm64`, `release/cloudcode-macos-x64`, `release/cloudcode-linux-x64`. The win-x64 exe path is consumed by Task 4's installer script.

- [ ] **Step 1: Install Bun if missing**

Run: `bun --version` — if it fails: `winget install --id Oven-sh.Bun -e`, then open a new shell context (or use `$env:USERPROFILE\.bun\bin\bun.exe` directly) and confirm `bun --version` prints a version.

- [ ] **Step 2: Create the Bun entrypoint wrapper**

Create `scripts/bin-entry.ts`:

```typescript
// Bun-only entrypoint for single-file executable builds.
// Embeds welcome.txt into the binary, then hands off to the normal CLI.
// Not compiled by tsc (outside tsconfig include) because of the import attribute.
import welcomeText from "../welcome.txt" with { type: "text" };
import { setEmbeddedWelcome } from "../src/ui/welcome.js";

setEmbeddedWelcome(welcomeText);
await import("../src/cli.js");
```

Note: Bun resolves `../src/cli.js` to `../src/cli.tsx` under NodeNext-style resolution. If `bun build` reports it cannot resolve the specifier, change both imports to the extensionless or explicit `.ts`/`.tsx` forms (`../src/ui/welcome.ts`, `../src/cli.tsx`) — verify with the build in Step 4.

- [ ] **Step 3: Create the build script**

Create `scripts/build-binaries.ps1`:

```powershell
$ErrorActionPreference = "Stop"
$targets = @(
    @{ target = "bun-windows-x64"; out = "release/cloudcode-win-x64.exe" },
    @{ target = "bun-darwin-arm64"; out = "release/cloudcode-macos-arm64" },
    @{ target = "bun-darwin-x64";  out = "release/cloudcode-macos-x64" },
    @{ target = "bun-linux-x64";   out = "release/cloudcode-linux-x64" }
)
New-Item -ItemType Directory -Force release | Out-Null
foreach ($t in $targets) {
    Write-Host "Building $($t.out) ..."
    bun build --compile --target=$($t.target) scripts/bin-entry.ts --outfile $t.out
    if ($LASTEXITCODE -ne 0) { throw "bun build failed for $($t.target)" }
}
```

Add to `package.json` scripts:

```json
"package:bin": "powershell -ExecutionPolicy Bypass -File scripts/build-binaries.ps1"
```

- [ ] **Step 4: Build**

Run: `npm run package:bin`
Expected: four files in `release/`, each roughly 60–120 MB. If Bun errors on JSX/tsx resolution, fix per the note in Step 2.

- [ ] **Step 5: Smoke test the Windows binary**

Run: `.\release\cloudcode-win-x64.exe --version`
Expected: prints `cloudcode 0.1.0`.

Then run `.\release\cloudcode-win-x64.exe` interactively (or with a pseudo-TTY) and confirm the welcome banner renders (embedded welcome.txt) and the app starts without missing-file errors. Exit with Ctrl+C. If the SDK subprocess fails to start, check that `extractFromBunfs` ran (the SDK extracts to a temp dir on first launch) before debugging further.

- [ ] **Step 6: Commit**

```powershell
git add scripts/bin-entry.ts scripts/build-binaries.ps1 package.json
git commit -m "feat: Bun-compiled portable binaries for win/mac/linux"
```

---

### Task 4: Windows installer (Inno Setup)

**Files:**
- Create: `installer/cloudcode.iss`
- Modify: `package.json` (add `package:installer` and aggregate `package` scripts)

**Interfaces:**
- Consumes: `release/cloudcode-win-x64.exe` from Task 3.
- Produces: `npm run package:installer` → `release/cloudcode-setup-0.1.0.exe`; `npm run package` → all artifacts.

- [ ] **Step 1: Install Inno Setup if missing**

Run: `iscc` — if not found: `winget install --id JRSoftware.InnoSetup -e`. The compiler lands at `C:\Program Files (x86)\Inno Setup 6\ISCC.exe` (use the full path in scripts; it is not added to PATH).

- [ ] **Step 2: Create the installer script**

Create `installer/cloudcode.iss`:

```ini
#define AppName "cloudcode"
#define AppVersion "0.1.0"

[Setup]
AppId={{B7E4C1D2-5A3F-4E8B-9C6D-0F1A2B3C4D5E}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=spider
DefaultDirName={autopf}\cloudcode
DefaultGroupName=cloudcode
DisableProgramGroupPage=yes
OutputDir=..\release
OutputBaseFilename=cloudcode-setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
ChangesEnvironment=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

[Files]
Source: "..\release\cloudcode-win-x64.exe"; DestDir: "{app}"; DestName: "cloudcode.exe"; Flags: ignoreversion

[Registry]
; Append install dir to the user PATH if not already present.
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; \
    ValueData: "{olddata};{app}"; Check: NeedsAddPath(ExpandConstant('{app}'))

[Code]
function NeedsAddPath(Param: string): boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath) then
  begin
    Result := True;
    exit;
  end;
  Result := Pos(';' + Uppercase(Param) + ';', ';' + Uppercase(OrigPath) + ';') = 0;
end;
```

- [ ] **Step 3: Wire npm scripts**

Add to `package.json` scripts:

```json
"package:installer": "\"C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe\" installer\\cloudcode.iss",
"package": "npm run package:npm && npm run package:bin && npm run package:installer"
```

- [ ] **Step 4: Build the installer**

Run: `npm run package:installer`
Expected: `release/cloudcode-setup-0.1.0.exe` created; ISCC output ends with "Successful compile".

- [ ] **Step 5: Test install / PATH / uninstall**

1. Run `.\release\cloudcode-setup-0.1.0.exe /SILENT` (installs per-user with `PrivilegesRequired=lowest`).
2. Open a NEW shell and run `cloudcode --version` — expected `cloudcode 0.1.0`.
3. Uninstall: `& "$env:LOCALAPPDATA\Programs\cloudcode\unins000.exe" /SILENT` (per-user default dir; if installed elsewhere check the uninstall entry in Settings > Apps). Confirm `cloudcode` is gone from a new shell.

Note: the PATH registry entry added at install is not removed on uninstall by this script (Inno limitation without extra code); acceptable for now — a stale PATH entry pointing at a removed dir is harmless.

- [ ] **Step 6: Full pipeline check and commit**

Run: `npm run package`
Expected: all six artifacts present in `release/` (tarball, four binaries, setup exe).

```powershell
git add installer/cloudcode.iss package.json
git commit -m "feat: Windows installer via Inno Setup and aggregate package script"
```
