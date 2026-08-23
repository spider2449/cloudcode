# webfetch Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the model a native `WebFetch` tool that retrieves an http(s) URL and returns its content as Markdown, gated by network policy and host-scoped permission rules.

**Architecture:** New tool in `src/engine/tools/` following the existing `ToolDef` contract; HTML→Markdown conversion wrapped in a standalone module around `turndown`. Network egress is validated through a new `"webFetch"` capability on `agent/networkPolicy.ts`, plumbed to tools via `ToolContext`. "Always allow" rules are stored per-host by extending the permission store with a third rule kind.

**Tech Stack:** TypeScript (strict), Node 20 global `fetch` + `AbortSignal.any`/`AbortSignal.timeout`, `turndown`, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-23-webfetch-tool-design.md`.
- All code/comments in English only.
- `tsconfig.json` stays `"strict": true`; no `any`, no non-null `!` assertions.
- No file in `src/` may exceed ~600 lines (`npm run lint:size`).
- Tests land in the same commit as the code they cover.
- Error handling only at existing boundaries: tool throws become `is_error` tool results via `EngineLoop.runTool` — do NOT add try/catch at tool call sites except where the plan shows it (URL parsing needs a caught error to return a friendly message; that is input validation, not boundary error handling).
- Fetch limits (exact values from spec): 30-second timeout, 5 MB body cap, 50,000-character output cap.

---

### Task 1: Add the `webFetch` network capability

**Files:**
- Modify: `src/agent/networkPolicy.ts:6-12`
- Test: `tests/networkPolicy.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `"webFetch"` is a valid `NetworkCapability`. Because `decideNetwork` already denies every non-`provider` capability unless `mode === "unrestricted"`, adding the union member alone yields exactly the spec behavior: denied under `offlineStrict`/`providerOnly`, allowed under `unrestricted`.

- [ ] **Step 1: Write the failing test**

Append this `describe` block inside the top-level of `tests/networkPolicy.test.ts` (the file already imports `decideNetwork`; add nothing else):

```ts
describe("webFetch capability", () => {
  const request = { capability: "webFetch", destination: "https://example.com/docs" };

  it("is denied under offlineStrict", () => {
    expect(decideNetwork("offlineStrict", request).allowed).toBe(false);
  });
  it("is denied under providerOnly", () => {
    expect(decideNetwork("providerOnly", request).allowed).toBe(false);
  });
  it("is allowed under unrestricted", () => {
    expect(decideNetwork("unrestricted", request).allowed).toBe(true);
  });
});
```

If `decideNetwork` is not imported yet, extend the existing import from `../src/agent/networkPolicy.js` to include it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/networkPolicy.test.ts`
Expected: FAIL — TypeScript/type error or assertion failure because `"webFetch"` is not a valid `NetworkCapability` (the request object will fail to type-check).

- [ ] **Step 3: Write minimal implementation**

In `src/agent/networkPolicy.ts`, change the union (lines 6-12) from:

```ts
export type NetworkCapability =
  | "provider"
  | "mcpHttp"
  | "update"
  | "skillRepo"
  | "gitRemote"
  | "packInstaller";
```

to:

```ts
export type NetworkCapability =
  | "provider"
  | "mcpHttp"
  | "update"
  | "skillRepo"
  | "gitRemote"
  | "packInstaller"
  | "webFetch";
```

No other change — `decideNetwork`'s existing `request.capability !== "provider"` branch handles denial.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/networkPolicy.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add src/agent/networkPolicy.ts tests/networkPolicy.test.ts
git commit -m "feat(network): add webFetch capability"
```

---

### Task 2: Host-scoped permission rules in the store

**Files:**
- Modify: `src/agent/permissionStore.ts`
- Test: `tests/permissionStore.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `PermissionRule` gains optional `host?: string` (exactly one of `dir`/`prefix`/`host` is set).
  - `checkHost(tool: string, host: string): PermissionDecision | undefined`
  - `rememberHost(tool: string, host: string, decision: PermissionDecision): void`

- [ ] **Step 1: Write the failing test**

Append to `tests/permissionStore.test.ts` (reuse the file's existing imports and temp-dir helper style shown below; if the file has no helper yet, add one):

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionStore } from "../src/agent/permissionStore.js";

function freshStore(): PermissionStore {
  return new PermissionStore(mkdtempSync(join(tmpdir(), "cc-permstore-")));
}

describe("host rules", () => {
  it("rememberHost persists and checkHost recalls", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-permstore-persist-"));
    const persisted = new PermissionStore(dir);
    persisted.rememberHost("WebFetch", "example.com", "allow");
    // A fresh instance reads the same file back.
    const reloaded = new PermissionStore(dir);
    expect(reloaded.checkHost("WebFetch", "example.com")).toBe("allow");
    expect(reloaded.checkHost("WebFetch", "other.com")).toBeUndefined();
  });

  it("deny beats allow for different hosts", () => {
    const store = freshStore();
    store.rememberHost("WebFetch", "a.com", "allow");
    store.rememberHost("WebFetch", "b.com", "deny");
    expect(store.checkHost("WebFetch", "a.com")).toBe("allow");
    expect(store.checkHost("WebFetch", "b.com")).toBe("deny");
  });

  it("re-membering the same host replaces the old rule", () => {
    const store = freshStore();
    store.rememberHost("WebFetch", "a.com", "deny");
    store.rememberHost("WebFetch", "a.com", "allow");
    expect(store.checkHost("WebFetch", "a.com")).toBe("allow");
    expect(store.list().filter(r => r.tool === "WebFetch")).toHaveLength(1);
  });
});
```

(If the file already has imports/helpers with these names, merge rather than duplicate.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/permissionStore.test.ts`
Expected: FAIL — `rememberHost`/`checkHost` do not exist.

- [ ] **Step 3: Write minimal implementation**

In `src/agent/permissionStore.ts` make three changes.

(a) Extend the rule type:

```ts
export interface PermissionRule {
  tool: string;
  decision: PermissionDecision;
  // Exactly one of the following is set: `dir` for path rules,
  // `prefix` for Bash command rules (matched on the first token),
  // `host` for WebFetch host rules.
  dir?: string;
  prefix?: string;
  host?: string;
}
```

(b) Change `isValidRule` so exactly one of the three scopes is set:

```ts
function isValidRule(r: unknown): r is PermissionRule {
  const rule = r as PermissionRule;
  const scopeCount = [rule.dir, rule.prefix, rule.host]
    .filter(value => typeof value === "string").length;
  return (
    !!rule &&
    typeof rule.tool === "string" &&
    (rule.decision === "allow" || rule.decision === "deny") &&
    scopeCount === 1
  );
}
```

(c) Add two methods to the `PermissionStore` class, after `rememberCommand`:

```ts
checkHost(tool: string, host: string): PermissionDecision | undefined {
  const key = host.toLowerCase();
  const matches = this.rules.filter(
    r => r.tool === tool && r.host !== undefined && r.host.toLowerCase() === key
  );
  if (matches.some(r => r.decision === "deny")) return "deny";
  if (matches.some(r => r.decision === "allow")) return "allow";
  return undefined;
}

rememberHost(tool: string, host: string, decision: PermissionDecision): void {
  const key = host.toLowerCase();
  this.rules = this.rules.filter(r => !(r.tool === tool && r.host?.toLowerCase() === key));
  // Store the host as given (for display in /permissions list) while
  // matching stays case-insensitive via checkHost's toLowerCase calls.
  this.rules.push({ tool, host, decision });
  this.persist();
}
```

Note: existing persisted files never contain `host`, and `scopeCount === 1` still accepts every previously valid rule, so no migration is needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/permissionStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/permissionStore.ts tests/permissionStore.test.ts
git commit -m "feat(permissions): host-scoped permission rules"
```

---

### Task 3: `WebFetch` permission decisions

**Files:**
- Modify: `src/engine/permissions.ts`
- Test: `tests/engine-permissions.test.ts`

**Interfaces:**
- Consumes: `PermissionStore.checkHost` from Task 2.
- Produces: `hostScope(toolName: string, input: Record<string, unknown>): string | undefined` — returns the lowercase hostname when the call is a `WebFetch` with a parseable http(s) `input.url`, otherwise `undefined`. Used by Task 6 (overlay + controller).

- [ ] **Step 1: Write the failing test**

Append to `tests/engine-permissions.test.ts`:

```ts
describe("WebFetch permissions", () => {
  it("asks by default", () => {
    const store = freshStore();
    expect(decidePermission("WebFetch", { url: "https://example.com/x" }, "default", store, CWD)).toBe("ask");
  });
  it("honors remembered host allow/deny", () => {
    const store = freshStore();
    store.rememberHost("WebFetch", "docs.example.com", "allow");
    store.rememberHost("WebFetch", "evil.example.com", "deny");
    expect(decidePermission("WebFetch", { url: "https://docs.example.com/page#sec" }, "default", store, CWD)).toBe("allow");
    expect(decidePermission("WebFetch", { url: "https://evil.example.com/" }, "default", store, CWD)).toBe("deny");
  });
  it("host matching ignores case", () => {
    const store = freshStore();
    store.rememberHost("WebFetch", "Docs.Example.com", "allow");
    expect(decidePermission("WebFetch", { url: "https://DOCS.EXAMPLE.COM/x" }, "default", store, CWD)).toBe("allow");
  });
  it("an unparseable url falls through to ask", () => {
    const store = freshStore();
    expect(decidePermission("WebFetch", { url: "not a url" }, "default", store, CWD)).toBe("ask");
  });
});

describe("hostScope", () => {
  it("returns the hostname for a WebFetch call", () => {
    expect(hostScope("WebFetch", { url: "https://Example.com/a" })).toBe("example.com");
  });
  it("returns undefined for other tools or bad urls", () => {
    expect(hostScope("Read", { url: "https://example.com" })).toBeUndefined();
    expect(hostScope("WebFetch", {})).toBeUndefined();
    expect(hostScope("WebFetch", { url: "ftp://example.com" })).toBeUndefined();
  });
});
```

Extend the existing import line to:

```ts
import { decidePermission, hostScope } from "../src/engine/permissions.js";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine-permissions.test.ts`
Expected: FAIL — `hostScope` does not exist; WebFetch currently falls to the final `"ask"` (so the default-ask case passes but the others fail).

- [ ] **Step 3: Write minimal implementation**

In `src/engine/permissions.ts`, add after `ruleScope`:

```ts
/**
 * The host a remembered WebFetch rule would be matched against, or undefined
 * for anything else. Kept separate from RuleScope because hosts have no path
 * component: the controller stores them via rememberHost, not rememberDir.
 */
export function hostScope(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName !== "WebFetch" || typeof input.url !== "string") return undefined;
  try {
    const url = new URL(input.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
```

In `decidePermission`, insert between the Bash block (ends with the compound-command check) and the `READ_ONLY` line:

```ts
  // Remembered host rules for WebFetch (deny beats allow), then always ask —
  // fetching is outbound network access, so it is never unconditionally allowed.
  if (toolName === "WebFetch") {
    const host = hostScope(toolName, input);
    if (host) {
      const ruling = store.checkHost(toolName, host);
      if (ruling) return ruling;
    }
    return "ask";
  }
```

(`bypassPermissions` already returns `"allow"` earlier at the top of the function, which is correct: that mode is an explicit user opt-out.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine-permissions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/permissions.ts tests/engine-permissions.test.ts
git commit -m "feat(engine): WebFetch host permission decisions"
```

---

### Task 4: HTML → Markdown conversion module

**Files:**
- Create: `src/engine/tools/htmlToMarkdown.ts`
- Test: `tests/engine-webfetch-html.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `htmlToMarkdown(html: string): string` — used by Task 5.

- [ ] **Step 1: Install the dependency**

```bash
npm install turndown
npm install --save-dev @types/turndown
```

Expected: added to `dependencies` / `devDependencies` in `package.json`.

- [ ] **Step 2: Write the failing test**

Create `tests/engine-webfetch-html.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { htmlToMarkdown } from "../src/engine/tools/htmlToMarkdown.js";

describe("htmlToMarkdown", () => {
  it("converts headings and paragraphs", () => {
    expect(htmlToMarkdown("<h1>Title</h1><p>Hello world</p>"))
      .toContain("# Title");
    expect(htmlToMarkdown("<h1>Title</h1><p>Hello world</p>"))
      .toContain("Hello world");
  });
  it("keeps links", () => {
    expect(htmlToMarkdown('<p>see <a href="/next">the docs</a></p>'))
      .toContain("[the docs](/next)");
  });
  it("drops script and style contents entirely", () => {
    const out = htmlToMarkdown("<style>p { color: red }</style><script>alert(1)</script><p>text</p>");
    expect(out).not.toContain("alert(1)");
    expect(out).not.toContain("color: red");
    expect(out).toContain("text");
  });
  it("converts fenced code blocks", () => {
    const out = htmlToMarkdown("<pre><code>npm run dev</code></pre>");
    expect(out).toContain("```");
    expect(out).toContain("npm run dev");
  });
  it("flattens lists", () => {
    const out = htmlToMarkdown("<ul><li>one</li><li>two</li></ul>");
    expect(out).toContain("one");
    expect(out).toContain("two");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/engine-webfetch-html.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Write minimal implementation**

Create `src/engine/tools/htmlToMarkdown.ts`:

```ts
import TurndownService from "turndown";

const service = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced"
});
// Turndown copies unknown elements' text through by default, which would leak
// script bodies and CSS into the model's context as garbage text.
service.remove(["script", "style", "noscript"]);

export function htmlToMarkdown(html: string): string {
  return service.turndown(html);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/engine-webfetch-html.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/engine/tools/htmlToMarkdown.ts tests/engine-webfetch-html.test.ts
git commit -m "feat(tools): html-to-markdown conversion via turndown"
```

---

### Task 5: The `WebFetch` tool

**Files:**
- Create: `src/engine/tools/webfetch.ts`
- Modify: `src/engine/tools/types.ts:13-20` (ToolContext)
- Modify: `src/engine/loop.ts` (EngineOptions + runTool ctx)
- Modify: `src/agent/session.ts:109-125` (pass policy into EngineLoop)
- Modify: `src/engine/registry.ts` (register tool)
- Test: `tests/engine-webfetch-tool.test.ts`

**Interfaces:**
- Consumes: `htmlToMarkdown` (Task 4); `ToolContext.networkPolicy` structural type defined here; `NetworkPolicy` passed from session.
- Produces: `webfetchTool: ToolDef` named `"WebFetch"` registered in `builtinTools()`.

- [ ] **Step 1: Write the failing test**

Create `tests/engine-webfetch-tool.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { webfetchTool } from "../src/engine/tools/webfetch.js";
import type { ToolContext } from "../src/engine/tools/types.js";

const baseCtx: ToolContext = { cwd: process.cwd() };

function okResponse(body: string, contentType: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function run(url: string, ctx: ToolContext = baseCtx) {
  return webfetchTool.execute({ url }, ctx);
}

describe("WebFetch tool", () => {
  it("rejects non-http(s) schemes without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await run("file:///etc/passwd");
    expect(out.isError).toBe(true);
    expect(out.content).toContain("Unsupported protocol");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unparseable urls", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const out = await run("not a url");
    expect(out.isError).toBe(true);
    expect(out.content).toContain("Invalid URL");
  });

  it("consults the network guard before fetching", async () => {
    const require = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse("<p>hi</p>", "text/html")));
    const out = await run("https://example.com/x", { ...baseCtx, networkPolicy: { require } });
    expect(require).toHaveBeenCalledWith(expect.objectContaining({ capability: "webFetch", destination: "https://example.com/x" }));
    expect(out.isError).toBeUndefined();
  });

  it("propagates a network-policy denial as a thrown error (the loop's per-tool boundary converts it)", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(run("https://example.com/x", {
      ...baseCtx,
      networkPolicy: { require: () => { throw new Error("Network policy providerOnly denied webFetch access to example.com (capabilityDenied)."); } }
    })).rejects.toThrow("Network policy");
    // The guard runs before any fetch happens.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("converts html responses to markdown", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse("<h1>Docs</h1><p>Body text</p>", "text/html; charset=utf-8")));
    const out = await run("https://example.com/x");
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain("# Docs");
    expect(out.content).toContain("Body text");
  });

  it("passes plain text through unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse("plain words", "text/plain")));
    const out = await run("https://example.com/x");
    expect(out.content).toBe("plain words");
  });

  it("pretty-prints json", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse('{"a":1}', "application/json")));
    const out = await run("https://example.com/api");
    expect(out.content).toContain('"a": 1');
  });

  it("rejects binary content types", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse("\x89PNG", "image/png")));
    const out = await run("https://example.com/img.png");
    expect(out.isError).toBe(true);
    expect(out.content).toContain("Unsupported content type");
  });

  it("maps http error statuses to friendly messages", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 404, headers: { "content-type": "text/html" } })));
    const out = await run("https://example.com/missing");
    expect(out.isError).toBe(true);
    expect(out.content).toContain("404");
    expect(out.content).toContain("not found");
  });

  it("truncates oversized output with a marker", async () => {
    const bigHtml = `<p>${"x".repeat(60_000)}</p>`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(bigHtml, "text/html")));
    const out = await run("https://example.com/big");
    expect(out.content.length).toBeLessThan(60_000);
    expect(out.content).toContain("[truncated");
  });

  it("enforces the 5 MB body cap while streaming", async () => {
    // A stream that would exceed the cap: more than 5 MB total.
    const chunk = "y".repeat(1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 8) { controller.close(); return; }
        sent += 1;
        controller.enqueue(new TextEncoder().encode(chunk));
      }
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { status: 200, headers: { "content-type": "text/plain" } })));
    const out = await run("https://example.com/huge");
    expect(out.isError).toBe(true);
    expect(out.content).toContain("5 MB");
  });

  it("reports fetch failures (dns, refused) as errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const out = await run("https://nonexistent.invalid/");
    expect(out.isError).toBe(true);
    expect(out.content).toContain("Fetch failed");
  });

  it("reports timeouts as errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("This operation was aborted", "TimeoutError")));
    const out = await run("https://slow.example.com/");
    expect(out.isError).toBe(true);
    expect(out.content).toContain("timed out");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine-webfetch-tool.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the tool**

Create `src/engine/tools/webfetch.ts`:

```ts
import type { ToolDef } from "./types.js";
import { htmlToMarkdown } from "./htmlToMarkdown.js";

const FETCH_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 50_000;

const STATUS_LABELS: Record<number, string> = {
  401: "unauthorized",
  403: "forbidden",
  404: "not found",
  410: "gone",
  429: "rate limited",
  500: "server error",
  502: "bad gateway",
  503: "service unavailable"
};

function statusMessage(status: number): string | undefined {
  return status >= 400 ? `${status} ${STATUS_LABELS[status] ?? "request failed"}` : undefined;
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("Empty response body");
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error(`Response exceeded the ${MAX_BODY_BYTES / (1024 * 1024)} MB limit`);
    }
    chunks.push(value);
  }
  return chunks.map(chunk => Buffer.from(chunk).toString("utf8")).join("");
}

export const webfetchTool: ToolDef = {
  name: "WebFetch",
  description: "Fetch a web page over HTTP(S) and return its content converted to Markdown.",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL to fetch" }
    },
    required: ["url"]
  },
  async execute(input, ctx) {
    const raw = typeof input.url === "string" ? input.url.trim() : "";
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { content: `Invalid URL: ${raw || "(empty)"}`, isError: true };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { content: `Unsupported protocol: ${url.protocol} — use http or https`, isError: true };
    }
    ctx.networkPolicy?.require({ capability: "webFetch", destination: url.toString() });

    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(url, { redirect: "follow", signal });
    } catch (err) {
      // An aborted signal also surfaces as an AbortError; check the user's
      // interrupt first so it is not misreported as a timeout.
      if (ctx.signal?.aborted) return { content: "Interrupted by user", isError: true };
      const name = err instanceof Error ? err.name : "";
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: name === "TimeoutError" || message.includes("aborted")
          ? `Fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${raw}`
          : `Fetch failed: ${message}`,
        isError: true
      };
    }

    // Redirects may land somewhere the policy was never asked about.
    if (res.url && res.url !== url.toString()) {
      ctx.networkPolicy?.require({ capability: "webFetch", destination: res.url });
    }
    const status = statusMessage(res.status);
    if (status) return { content: `Fetch failed: ${status} for ${res.url || raw}`, isError: true };

    const contentType = res.headers.get("content-type") ?? "text/plain";
    const mime = contentType.split(";")[0].trim().toLowerCase();
    let text: string;
    try {
      const body = await readCapped(res);
      if (mime === "text/html" || mime === "application/xhtml+xml") {
        text = htmlToMarkdown(body);
      } else if (mime === "application/json" || mime.endsWith("+json")) {
        text = JSON.stringify(JSON.parse(body), null, 2);
      } else if (mime.startsWith("text/")) {
        text = body;
      } else {
        return { content: `Unsupported content type: ${contentType}`, isError: true };
      }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
    if (text.length > MAX_OUTPUT_CHARS) {
      text = text.slice(0, MAX_OUTPUT_CHARS) +
        `\n\n[truncated ${text.length - MAX_OUTPUT_CHARS} characters]`;
    }
    return { content: text || "(empty response)" };
  }
};
```

Notes for the implementer:
- The `readCapped` catch also covers JSON parse failures — a malformed JSON body surfaces as `Unexpected token ...`, which is an acceptable error message.
- A network-policy denial (`require` throws) deliberately propagates out of `execute`: `EngineLoop.runTool`'s per-tool boundary converts it into an error tool_result, and the print adapter already knows how to serialize `NetworkPolicyError`.

- [ ] **Step 4: Plumb the network guard into ToolContext**

In `src/engine/tools/types.ts`, extend `ToolContext`:

```ts
export interface ToolContext {
  cwd: string;
  // Aborts when the user interrupts the turn; long-running tools should
  // honor it and stop early.
  signal?: AbortSignal;
  lsp?: LspManager;
  fileMutations?: FileMutationObserver;
  /** Outbound-network gate for tools like WebFetch. Structural on purpose:
   * engine code must not depend on the agent-layer NetworkPolicy class. */
  networkPolicy?: {
    require(request: { capability: "webFetch"; destination: string }): void;
  };
}
```

(The method-shaped signature keeps assignment from the real `NetworkPolicy` class valid — TS method parameters are bivariant — while keeping `engine/` free of an import from `agent/`.)

In `src/engine/loop.ts`:
1. Add to the imports at the top:

```ts
import type { NetworkPolicy } from "../agent/networkPolicy.js";
```

2. Add to `EngineOptions` (after `fileMutations?: FileMutationObserver;`):

```ts
  networkPolicy?: NetworkPolicy;
```

3. In `runTool`, add `networkPolicy` to the context passed to `tool.execute`:

```ts
      const out = await tool.execute(block.input, {
        cwd: this.opts.cwd,
        signal,
        lsp: this.opts.lsp,
        fileMutations: this.opts.fileMutations,
        networkPolicy: this.opts.networkPolicy
      });
```

In `src/agent/session.ts`, add `networkPolicy,` to the `new EngineLoop({...})` options object (after `fileMutations: this.changes,`):

```ts
      fileMutations: this.changes,
      networkPolicy,
```

- [ ] **Step 5: Register the tool**

In `src/engine/registry.ts`, add the import and include it in the array:

```ts
import { webfetchTool } from "./tools/webfetch.js";
```

```ts
  const tools = [
    readTool, writeTool, editTool, bashTool, globTool, grepTool, webfetchTool,
    definitionTool, referencesTool, hoverTool, symbolsTool, diagnosticsTool
  ];
```

(WebFetch deliberately sets no `capabilities.arbitraryChildNetwork`: its own egress is policy-gated directly, unlike Bash whose child processes cannot be.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/engine-webfetch-tool.test.ts tests/engine-loop.test.ts tests/session.test.ts tests/printMode.test.ts`
Expected: PASS — including the loop/session/print suites, since those exercise `EngineLoop` construction and `runTool` contexts changed above. Fix any compile fallout before moving on.

- [ ] **Step 7: Commit**

```bash
git add src/engine/tools/webfetch.ts src/engine/tools/types.ts src/engine/loop.ts src/agent/session.ts src/engine/registry.ts tests/engine-webfetch-tool.test.ts
git commit -m "feat(tools): WebFetch tool with network-policy gating"
```

---

### Task 6: UI wiring — "always allow <host>" option

**Files:**
- Modify: `src/ui/widgets/overlay.ts` (options constants + `openPermission`)
- Modify: `src/ui/permissionController.ts:38-55` (persisting the choice)
- Modify: `src/ui/nativeApp.ts:338-342` (`/permissions list` rendering)
- Test: `tests/overlay.test.ts`, `tests/permissionController.test.ts`

**Interfaces:**
- Consumes: `hostScope` (Task 3), `PermissionStore.rememberHost` (Task 2).
- Produces: nothing exported; behavior only.

- [ ] **Step 1: Write the failing tests**

**Important:** `tests/overlay.test.ts` currently uses `WebFetch` (with a valid URL) as its stand-in for "a tool that only gets Yes/No". After this task WebFetch DOES get Always/Never, so that fixture must move to a genuinely unscopeable tool. Both files are edited below.

(a) In `tests/overlay.test.ts`, inside `describe("OverlayManager permission sub-mode")`, replace the `otherRequest` definition:

```ts
  const otherRequest = { toolName: "WebFetch", input: { url: "https://example.com" } };
```

with two definitions:

```ts
  const otherRequest = { toolName: "SomeOtherTool", input: {} };
  const webFetchRequest = { toolName: "WebFetch", input: { url: "https://example.com/docs" } };
```

Then update the two tests that relied on WebFetch meaning "no remember option":

In `"a non-file-path request only offers Yes/No, not Always/Never"` — no body change needed (it already asserts `not.toContain("Always for this directory")`), but point it at `otherRequest` explicitly if it isn't.

In `"arrow navigation plus Enter selects the currently highlighted option"`, keep using `otherRequest` so Yes/No semantics stay intact — with the new definition it passes unchanged.

Append these new tests inside the same `describe`:

```ts
  it("offers Always/Never allow '<host>' for WebFetch requests", () => {
    const onDecision = vi.fn();
    const mgr = new OverlayManager();
    mgr.openPermission(webFetchRequest as never, onDecision);
    const joined = mgr.render(THEMES.dark, 80).join("\n");
    expect(joined).toContain("Always allow example.com");
    expect(joined).toContain("Never allow example.com");
    mgr.handleKey({ t: "printable", ch: "a" }, "a");
    expect(onDecision).toHaveBeenCalledWith(true, "allow");
  });

  it("offers plain Yes/No when the WebFetch url is unusable for host scoping", () => {
    const mgr = new OverlayManager();
    mgr.openPermission({ toolName: "WebFetch", input: { url: "garbage" } } as never, () => {});
    const joined = mgr.render(THEMES.dark, 80).join("\n");
    expect(joined).not.toContain("Always allow");
    expect(joined).not.toContain("Always for this directory");
  });
```

(b) In `tests/permissionController.test.ts`, append inside `describe("PermissionController")` (reuses the file's existing `setup`/`request` helpers exactly as the neighboring "remembers a directory rule" test does):

```ts
  it("remembers a WebFetch decision scoped to the host", () => {
    const { overlay, store, controller } = setup();
    const answers: boolean[] = [];
    controller.enqueue(request("WebFetch", { url: "https://docs.example.com/page" }, answers));
    overlay.handleKey({ t: "printable", ch: "a" }, "a"); // "always allow" hotkey
    expect(answers).toEqual([true]);
    expect(store.checkHost("WebFetch", "docs.example.com")).toBe("allow");
    expect(store.checkHost("WebFetch", "other.com")).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/overlay.test.ts tests/permissionController.test.ts`
Expected: FAIL — the new overlay tests find no "Always allow example.com" row, the controller test finds no stored host rule (`checkHost` returns undefined).

- [ ] **Step 3: Implement**

(a) In `src/ui/widgets/overlay.ts`, add next to `commandOptions`:

```ts
function hostOptions(host: string): PermOption[] {
  return [
    { label: "Yes (y)", hotkey: "y", allow: true },
    { label: `Always allow ${host} (a)`, hotkey: "a", allow: true, rememberAs: "allow" },
    { label: "No (n)", hotkey: "n", allow: false },
    { label: `Never allow ${host} (d)`, hotkey: "d", allow: false, rememberAs: "deny" }
  ];
}
```

Extend the import from `../../engine/permissions.js`:

```ts
import { hostScope, ruleScope } from "../../engine/permissions.js";
```

Then rewrite the option selection in `openPermission`:

```ts
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
```

(b) In `src/ui/permissionController.ts`, extend the import:

```ts
import { hostScope, ruleScope } from "../engine/permissions.js";
```

and rewrite the remembering branch in `decide`:

```ts
      try {
        const host = hostScope(active.toolName, active.input);
        if (host) {
          this.deps.store.rememberHost(active.toolName, host, rememberAs);
        } else {
          const scope = ruleScope(active.toolName, active.input);
          if (scope) {
            // "dir" inputs (Glob/Grep) already name the directory to scope to;
            // "file" inputs are scoped to their containing directory.
            if (scope.kind === "dir") this.deps.store.rememberDir(active.toolName, scope.path, rememberAs);
            else this.deps.store.remember(active.toolName, scope.path, rememberAs);
          } else if (active.toolName === "Bash" && typeof active.input.command === "string") {
            this.deps.store.rememberCommand(commandPrefix(String(active.input.command)), rememberAs);
          }
        }
      } catch (err) {
```

(c) In `src/ui/nativeApp.ts`, update `listPermissionRules` so host rules render legibly:

```ts
      listPermissionRules: () => {
        const rules = this.permissionStore.list();
        if (rules.length === 0) return "No permission rules.";
        return rules.map(r => {
          const scope = r.dir ?? (r.host !== undefined ? `${r.host}` : `'${r.prefix}' commands`);
          return `${r.decision === "allow" ? "✓" : "✗"} ${r.tool} ${scope}`;
        }).join("\n");
      },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/overlay.test.ts tests/permissionController.test.ts tests/app.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/widgets/overlay.ts src/ui/permissionController.ts src/ui/nativeApp.ts tests/overlay.test.ts tests/permissionController.test.ts
git commit -m "feat(ui): remember WebFetch permissions per host"
```

---

### Task 7: Full verification

**Files:** none created; verification only.

- [ ] **Step 1: Type-check and build**

Run: `npm run build`
Expected: exits 0, no type errors.

- [ ] **Step 2: Lint and size check**

Run: `npm run lint ; npm run lint:size`
Expected: no errors; no new size warnings (`webfetch.ts` should be well under 600 lines).

- [ ] **Step 3: Whole suite**

Run: `npm test`
Expected: all suites pass, including pre-existing ones (networkPolicy, permissionStore, engine-permissions, printMode, packaging).

- [ ] **Step 4: Manual smoke check (optional but recommended)**

Run: `npm run dev` in any project, then prompt the model to "fetch https://example.com and summarize". Expect: a permission prompt offering "Always allow example.com"; after allowing, a markdown rendering of the page in the transcript. With saved `networkMode: offlineStrict` in settings, expect the fetch to be denied by network policy instead.

- [ ] **Step 5: Commit any remaining stragglers**

```bash
git status
```

Expected: clean tree (or only intentionally unstaged files). If README needs a mention of the new tool, add one line under the features list and:

```bash
git add README.md
git commit -m "docs: mention WebFetch tool"
```
