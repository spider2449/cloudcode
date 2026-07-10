# Startup Welcome Message Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Show a startup message in the transcript, loaded from an editable `welcome.txt` at the package root with `{version}`/`{provider}`/`{model}` placeholders.

**Architecture:** A new `src/ui/welcome.ts` module resolves the package root from `import.meta.url`, reads `welcome.txt`, and substitutes placeholders. `App.tsx` seeds its `items` state with the result as a `notice` display item. Missing/unreadable file â†’ no message.

**Tech Stack:** TypeScript, Node fs, Ink/React, vitest.

## Global Constraints

- All code, comments, and docs in English only.
- ESM project (`"type": "module"`); relative imports use `.js` extensions.
- Tests run with `npx vitest run <file>`.

---

### Task 1: `loadWelcome` module + `welcome.txt`

**Files:**
- Create: `welcome.txt` (package root)
- Create: `src/ui/welcome.ts`
- Test: `tests/welcome.test.ts`

**Interfaces:**
- Produces: `loadWelcome(vars: WelcomeVars, filePath?: string): string | undefined` where `WelcomeVars = { version: string; provider: string; model?: string }`. `filePath` overrides the default package-root path (used by tests). Returns rendered text or `undefined` if the file is missing/unreadable.

- [x] **Step 1: Write the failing tests**

Create `tests/welcome.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWelcome } from "../src/ui/welcome.js";

const vars = { version: "0.1.0", provider: "anthropic", model: "claude-sonnet-5" };

function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "welcome-"));
  const file = join(dir, "welcome.txt");
  writeFileSync(file, content);
  return file;
}

describe("loadWelcome", () => {
  it("substitutes placeholders", () => {
    const file = tmpFile("cloudcode {version} â€” {provider} ({model})");
    expect(loadWelcome(vars, file)).toBe("cloudcode 0.1.0 â€” anthropic (claude-sonnet-5)");
  });

  it("leaves unknown placeholders as-is", () => {
    const file = tmpFile("hello {nope}");
    expect(loadWelcome(vars, file)).toBe("hello {nope}");
  });

  it("uses empty string for undefined model", () => {
    const file = tmpFile("model: {model}");
    expect(loadWelcome({ version: "1", provider: "p" }, file)).toBe("model: ");
  });

  it("preserves multi-line content and trims trailing newline", () => {
    const file = tmpFile("line one\nline two\n");
    expect(loadWelcome(vars, file)).toBe("line one\nline two");
  });

  it("returns undefined when file is missing", () => {
    expect(loadWelcome(vars, join(tmpdir(), "does-not-exist", "welcome.txt"))).toBeUndefined();
  });

  it("reads the package-root welcome.txt by default", () => {
    const text = loadWelcome(vars);
    expect(text).toBeTruthy();
    expect(text).not.toContain("{version}");
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/welcome.test.ts`
Expected: FAIL â€” cannot resolve `../src/ui/welcome.js`.

- [x] **Step 3: Write the implementation**

Create `welcome.txt` at the package root:

```text
cloudcode {version} â€” connected to {provider} ({model})
Type a prompt to start, or / for commands.
```

Create `src/ui/welcome.ts`:

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface WelcomeVars {
  version: string;
  provider: string;
  model?: string;
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
    return undefined;
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

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/welcome.test.ts`
Expected: PASS (6 tests).

- [x] **Step 5: Commit**

```bash
git add welcome.txt src/ui/welcome.ts tests/welcome.test.ts
git commit -m "feat: loadWelcome reads package-root welcome.txt with placeholders"
```

### Task 2: Show welcome notice on startup

**Files:**
- Modify: `src/ui/App.tsx:51` (seed `items` state; add import)
- Test: `tests/app.test.tsx` (add one test)

**Interfaces:**
- Consumes: `loadWelcome(vars: {version, provider, model}): string | undefined` from `../ui/welcome.js`; `VERSION` from `../version.js`.

- [x] **Step 1: Write the failing test**

In `tests/app.test.tsx`, follow the file's existing render/setup helpers (read the file first) and add:

```tsx
it("shows the welcome message on startup", () => {
  const { lastFrame } = renderApp(); // use the file's existing helper for mounting <App>
  expect(lastFrame()).toContain("cloudcode 0.1.0");
});
```

If the file has no shared helper, mount `<App>` with the same minimal props used by the first existing test in that file.

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/app.test.tsx`
Expected: the new test FAILS (welcome text not rendered); existing tests still pass.

- [x] **Step 3: Implement**

In `src/ui/App.tsx`, add imports:

```ts
import { loadWelcome } from "./welcome.js";
import { VERSION } from "../version.js";
```

Change the `items` initializer (line 51):

```ts
const [items, setItems] = useState<DisplayItem[]>(() => {
  const welcome = loadWelcome({
    version: VERSION,
    provider: props.initialProvider,
    model: modelFor(props.initialProvider)
  });
  return welcome ? [{ kind: "notice", text: welcome }] : [];
});
```

Note: `/clear` and resume-picker both call `setItems([])`, so the welcome message is not re-shown â€” matches the spec.

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/app.test.tsx`
Expected: PASS, including the new test.

Then run the full suite: `npx vitest run`
Expected: all tests PASS.

- [x] **Step 5: Manual check**

Run: `npm run dev` â€” the welcome message with substituted version/provider/model appears at the top before the first prompt. Exit with double Ctrl+C.

- [x] **Step 6: Commit**

```bash
git add src/ui/App.tsx tests/app.test.tsx
git commit -m "feat: show welcome message from welcome.txt on startup"
```
