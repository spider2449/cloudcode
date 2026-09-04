# Desktop Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `npm run desktop:package` that ships a self-contained CloudCode Desktop app (bundled CLI + renderer) for Windows, Linux, and macOS.

**Architecture:** electron-builder with inline `build` config in `package.json`; `scripts/desktop-package.mjs` orchestrates `tsc` + `vite` + `install-app-deps` + builder; `desktop/main.mjs` resolves `dist/cli.js` for both dev and `app.asar` layouts.

**Tech Stack:** Electron 44, electron-builder, Vite React renderer, node-pty, bun (CLI only, unchanged).

---

## File structure

- Modify: `package.json` — add `electron-builder` devDependency, `build` config, `desktop:dist` / `desktop:package` / `package:all` scripts.
- Create: `scripts/desktop-package.mjs` — single orchestrator, fail-fast on missing build output.
- Modify: `desktop/main.mjs:9-11` — resolve `projectRoot` for packaged (`app.asar`) and dev layouts.
- Modify: `tests/packaging.test.ts` — assert builder config, file list, scripts, version agreement.
- Modify: `.gitignore` — ignore `desktop/dist/`.
- Modify: `.github/workflows/release-smoke-test.yml` — desktop package + smoke leg per OS.
- Modify (version bump, same commit as code): `src/version.ts`, `package.json`, `package-lock.json`, `installer/cloudcode.iss` — `0.1.9` to `0.1.10` (current work is committed first as `0.1.9`; see execution note).

---

### Task 1: Desktop packaging contract tests (failing first)

**Files:**
- Modify: `tests/packaging.test.ts`
- Test: `tests/packaging.test.ts`

- [ ] **Step 1: Write the failing test**

Append this block to `tests/packaging.test.ts` after the `packaging entry points` describe:

```ts
describe("desktop packaging", () => {
  it("declares electron-builder with bundled CLI file list", () => {
    const pkg = JSON.parse(read("package.json")) as {
      devDependencies: Record<string, string>;
      build: {
        appId: string;
        files: string[];
      };
      scripts: Record<string, string>;
    };
    expect(pkg.devDependencies["electron-builder"]).toBeDefined();
    expect(pkg.build.appId).toBe("app.cloudcode");
    expect(pkg.build.directories.output).toBe("release/desktop");
    for (const pattern of ["dist/**", "desktop/dist/**", "desktop/preload.cjs"]) {
      expect(pkg.build.files).toContain(pattern);
    }
    expect(pkg.scripts["desktop:dist"]).toContain("desktop-package.mjs");
    expect(pkg.scripts["desktop:package"]).toContain("desktop-package.mjs");
  });

  it("the desktop orchestrator script exists and guards build output", () => {
    expect(existsSync(join(root, "scripts/desktop-package.mjs"))).toBe(true);
    expect(read("scripts/desktop-package.mjs")).toContain("desktop/dist");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/packaging.test.ts -t "desktop packaging"`
Expected: FAIL with `expected undefined to be defined` on `electron-builder`.

- [ ] **Step 3: Commit test only (red)**

```bash
git add tests/packaging.test.ts
git commit -m "test(packaging): assert desktop builder contract"
```

---

### Task 2: Builder config and npm scripts (green)

**Files:**
- Modify: `package.json:52-64`
- Test: `tests/packaging.test.ts`

- [ ] **Step 1: Add devDependency and scripts**

Run: `npm install --save-dev electron-builder`

Then edit `package.json` scripts to add exactly:

```json
"desktop:dist": "node scripts/desktop-package.mjs --dist-only",
"desktop:package": "node scripts/desktop-package.mjs",
"package:all": "npm run package && npm run desktop:package"
```

- [ ] **Step 2: Add inline builder config to package.json**

Add exactly this top-level `build` key (merge, do not replace other keys):

```json
"build": {
  "appId": "app.cloudcode",
  "productName": "CloudCode",
  "asar": true,
  "directories": { "output": "release/desktop" },
  "files": ["dist/**", "desktop/dist/**", "desktop/preload.cjs", "desktop/main.mjs", "package.json"],
  "win": { "target": ["nsis"] },
  "linux": { "target": ["AppImage", "deb"] },
  "mac": { "target": ["dmg"] }
},
"main": "desktop/main.mjs"
```

- [ ] **Step 3: Create minimal orchestrator stub so the file-exists test passes**

Create `scripts/desktop-package.mjs` with exactly:

```js
import { existsSync } from "node:fs";

if (!existsSync("dist") || !existsSync("desktop/dist")) {
  console.error("Missing build output. Run npm run desktop:dist first (tsc + vite).");
  process.exit(1);
}
console.log("desktop-package stub: full orchestration lands in Task 3.");
```

- [ ] **Step 4: Run tests to verify green**

Run: `npx vitest run tests/packaging.test.ts`
Expected: PASS (all suites including `desktop packaging`).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json scripts/desktop-package.mjs tests/packaging.test.ts
git commit -m "feat(desktop): add electron-builder config and package scripts"
```

---

### Task 3: Full orchestrator implementation

**Files:**
- Modify: `scripts/desktop-package.mjs`
- Test: `tests/packaging.test.ts`

- [ ] **Step 1: Replace stub with full orchestration**

Overwrite `scripts/desktop-package.mjs` with exactly:

```js
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const distOnly = args.includes("--dist-only");
const target = args.find(a => ["--win", "--linux", "--mac"].includes(a));

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit", shell: true });
}

run("npx tsc -p tsconfig.json");
run("npx vite build --config desktop/vite.config.ts");

if (!existsSync("dist/cli.js")) {
  console.error("Missing dist/cli.js after build. Aborting desktop package.");
  process.exit(1);
}
if (!existsSync("desktop/dist/index.html")) {
  console.error("Missing desktop/dist/index.html after vite build. Aborting desktop package.");
  process.exit(1);
}
if (distOnly) process.exit(0);

run("npx electron-builder install-app-deps");
run(`npx electron-builder ${target ?? ""}`.trim());
```

- [ ] **Step 2: Verify dist-only build works**

Run: `npm run desktop:dist`
Expected: exit 0, `dist/cli.js` and `desktop/dist/index.html` both exist.

- [ ] **Step 3: Verify guard message**

Run: `node -e "require('fs').renameSync('dist','dist.bak')" && node scripts/desktop-package.mjs; echo "exit=$?"; node -e "require('fs').renameSync('dist.bak','dist')"`
Expected: prints `Missing build output` style error path or rebuilds `dist/` via tsc; exit 0 after restore. If output differs, keep the explicit `existsSync` error text from the script.

- [ ] **Step 4: Run packaging tests**

Run: `npx vitest run tests/packaging.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/desktop-package.mjs
git commit -m "feat(desktop): orchestrate tsc, vite, and electron-builder"
```

---

### Task 4: Packaged path resolution in main process

**Files:**
- Modify: `desktop/main.mjs:9-11`
- Test: manual smoke (dev start still works)

- [ ] **Step 1: Patch projectRoot resolution**

Replace in `desktop/main.mjs`:

```js
const desktopDir = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = join(desktopDir, "..");
```

with exactly:

```js
const desktopDir = fileURLToPath(new URL(".", import.meta.url));
// Packaged layout: desktop/main.mjs lives inside app.asar, resources at process.resourcesPath.
// Dev layout: repo root is one level above desktop/.
const projectRoot = process.resourcesPath && desktopDir.includes(".asar")
  ? join(process.resourcesPath, "app")
  : join(desktopDir, "..");
```

- [ ] **Step 2: Verify dev start still resolves**

Run: `npm run desktop:dist && timeout 10 npm run desktop:start || true`
Expected: window opens or Electron launches without `Cannot find module .../dist/cli.js`. Kill after 10s.

- [ ] **Step 3: Run full unit tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add desktop/main.mjs
git commit -m "fix(desktop): resolve bundled CLI path in packaged layout"
```

---

### Task 5: Ignore output, CI leg, version bump, verify

**Files:**
- Modify: `.gitignore`, `.github/workflows/release-smoke-test.yml`
- Modify: `src/version.ts`, `package.json`, `package-lock.json`, `installer/cloudcode.iss`
- Test: `tests/packaging.test.ts`, `npm run lint`, `npm run lint:size`, `npm test`

- [ ] **Step 1: Ignore renderer build output**

Append to `.gitignore`:

```text
desktop/dist/
```

- [ ] **Step 2: Add CI desktop legs per OS**

Replace the single-OS sketch with a matrix that packages per OS and asserts the installer artifact. Append exactly:

```yaml
  desktop-package:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: windows-latest
            flag: --win
            glob: "release/desktop/*.exe"
          - os: ubuntu-latest
            flag: --linux
            glob: "release/desktop/*.AppImage"
          - os: macos-latest
            flag: --mac
            glob: "release/desktop/*.dmg"
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run desktop:package -- ${{ matrix.flag }}
      - run: ls ${{ matrix.glob }}
```

Existing CLI legs stay untouched.

- [ ] **Step 3: Bump patch version 0.1.9 to 0.1.10 in all four files**

Run: `node scripts/bump-version.mjs` (repo helper), then verify:

Run: `npx vitest run tests/packaging.test.ts`
Expected: PASS (version agreement holds).

- [ ] **Step 4: Full verification**

Run: `npm run lint`
Expected: 0 errors.

Run: `npm run lint:size`
Expected: `All files under 600 lines.`

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .gitignore .github/workflows/release-smoke-test.yml src/version.ts package.json package-lock.json installer/cloudcode.iss
git commit -m "build(desktop): ignore output, add CI legs, bump 0.1.10"
```
