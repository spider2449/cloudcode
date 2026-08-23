# Image Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The model can see images: `Read` returns image files as image blocks, and users attach clipboard screenshots in the TUI with Ctrl+V.

**Architecture:** Images are first-class content blocks (Anthropic-native shape) flowing from two sources — the Read tool and TUI clipboard attach — through `runTurn(text, signal, images?)`. OpenAI-compatible translation maps them to vision data-URL parts; providers without vision surface their own errors via the existing per-turn boundary.

**Tech Stack:** TypeScript (strict), magic-byte sniffing over raw buffers, platform clipboard commands (PowerShell / osascript / xclip), vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-23-image-input-design.md`.
- All code/comments in English only.
- tsconfig stays strict; no `any`, no non-null assertions.
- Supported media types: image/png, image/jpeg, image/gif, image/webp; max **5 MB** per image; detection is extension first, then magic bytes must confirm.
- No new file over ~600 lines; only pre-existing lint warnings allowed (`autoInject.test.ts`, `nativeApp.ts`).
- Tests land in the same commit as the code they cover.

---

### Task 1: Image sniffing helper + Read tool support

**Files:**
- Create: `src/engine/tools/imageSniff.ts`
- Modify: `src/engine/tools/read.ts`
- Modify: `src/engine/tools/types.ts` (additive `images?` on ToolOutput)
- Test: `tests/engine-image-sniff.test.ts`

**Interfaces:**
- Produces:
  - `sniffImage(buf: Buffer): string | undefined`
  - `MAX_IMAGE_BYTES = 5 * 1024 * 1024`
  - `ToolOutput.images?: Array<{ mediaType: string; base64: string }>`

- [ ] **Step 1: Write the failing test**

Create `tests/engine-image-sniff.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sniffImage } from "../src/engine/tools/imageSniff.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const GIF = Buffer.from("GIF89a" + "0".repeat(20), "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(8)]);

describe("sniffImage", () => {
  it("detects png, jpeg, gif, and webp magic bytes", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(JPEG)).toBe("image/jpeg");
    expect(sniffImage(GIF)).toBe("image/gif");
    expect(sniffImage(WEBP)).toBe("image/webp");
  });
  it("returns undefined for text and unknown binaries", () => {
    expect(sniffImage(Buffer.from("hello world"))).toBeUndefined();
    expect(sniffImage(Buffer.alloc(32, 0))).toBeUndefined();
    expect(sniffImage(Buffer.alloc(0))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine-image-sniff.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/engine/tools/imageSniff.ts`:

```ts
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Media types the model can consume, with their magic-byte checks. */
const SIGNATURES: Array<{ mediaType: string; test: (b: Buffer) => boolean }> = [
  { mediaType: "image/png", test: b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mediaType: "image/jpeg", test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mediaType: "image/gif", test: b => b.subarray(0, 6).toString("latin1").startsWith("GIF8") },
  { mediaType: "image/webp", test: b => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" }
];

/** Returns the detected media type, or undefined when buf is not an image. */
export function sniffImage(buf: Buffer): string | undefined {
  return SIGNATURES.find(sig => sig.test(buf))?.mediaType;
}
```

In `src/engine/tools/types.ts`, extend `ToolOutput`:

```ts
export interface ToolOutput {
  content: string;
  isError?: boolean;
  /** Image blocks to show the model (Read on image files). */
  images?: Array<{ mediaType: string; base64: string }>;
}
```

In `src/engine/tools/read.ts`: import `extname` from node:path and `{ MAX_IMAGE_BYTES, sniffImage }` from `./imageSniff.js`; add near MAX_LINES:

```ts
const IMAGE_EXTS: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp"
};
```

and inside `execute`, right after computing `abs`:

```ts
    const ext = extname(abs).toLowerCase();
    if (IMAGE_EXTS[ext] !== undefined) {
      let buf: Buffer;
      try {
        buf = readFileSync(abs);
      } catch (err) {
        return { content: `Cannot read ${abs}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      if (buf.length > MAX_IMAGE_BYTES) {
        return { content: `Cannot read ${abs}: image exceeds ${MAX_IMAGE_BYTES / (1024 * 1024)} MB limit`, isError: true };
      }
      const mediaType = sniffImage(buf);
      if (!mediaType || mediaType !== IMAGE_EXTS[ext]) {
        return { content: `Cannot read ${abs}: file content does not match its image extension`, isError: true };
      }
      return {
        content: `[image: ${abs}]`,
        images: [{ mediaType, base64: buf.toString("base64") }]
      };
    }
```

(The existing utf8 text path continues unchanged below.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/engine-image-sniff.test.ts tests/engine-file-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/tools/imageSniff.ts src/engine/tools/read.ts src/engine/tools/types.ts tests/engine-image-sniff.test.ts
git commit -m "feat(tools): Read returns image blocks for image files"
```

---
### Task 2: Content pipeline — blocks in tool results and user messages

**Files:**
- Modify: `src/engine/messages.ts`
- Modify: `src/engine/loop.ts`
- Test: `tests/engine-loop-knobs.test.ts`

**Interfaces:**
- Consumes: `ToolOutput.images` (Task 1).
- Produces:
  - ContentBlock gains `{ type: "image"; source: { type: "base64"; media_type: string; data: string } }`.
  - `runTurn(userText, signal, images?)` — third additive parameter.

- [ ] **Step 1: Write the failing test**

Append to `tests/engine-loop-knobs.test.ts`:

```ts
describe("EngineLoop image plumbing", () => {
  it("tool outputs with images become block-array tool_results", async () => {
    const received: unknown[] = [];
    const imageTool = {
      name: "EchoTool",
      description: "echoes",
      input_schema: { type: "object", properties: {}, required: [] },
      execute: async () => ({ content: "[image: x.png]", images: [{ mediaType: "image/png", base64: "aGk=" }] })
    };
    const loop = new EngineLoop({
      client: fakeClient([toolUseTurn(), textTurn("seen")]),
      model: "test-model",
      systemPrompt: "sys",
      tools: [imageTool],
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      store: new PermissionStore(mkdtempSync(join(tmpdir(), "cc-loop-img-"))),
      onMessage: m => received.push(m),
      requestPermission: async () => true
    });
    await loop.runTurn("look", new AbortController().signal);
    const results = received.filter(m => (m as { type?: string }).type === "tool_result");
    expect((results[0] as { content: unknown }).content).toEqual([
      { type: "text", text: "[image: x.png]" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } }
    ]);
  });

  it("attached images turn the user message into blocks with the image first", async () => {
    const requests: unknown[] = [];
    const client = {
      async *create(req: unknown) { requests.push(req); for (const e of [textTurn("ok")]) yield e as never; }
    };
    const loop = new EngineLoop({
      client,
      model: "test-model",
      systemPrompt: "sys",
      tools: [],
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      store: new PermissionStore(mkdtempSync(join(tmpdir(), "cc-loop-imgu-"))),
      onMessage: () => {},
      requestPermission: async () => true
    });
    await loop.runTurn("what is this", new AbortController().signal, [
      { mediaType: "image/png", base64: "aGk=" }
    ]);
    const req = requests[0] as { messages: Array<{ role: string; content: unknown }> };
    const lastUser = [...req.messages].reverse().find(m => m.role === "user");
    if (!lastUser) throw new Error("no user message");
    expect(Array.isArray(lastUser.content)).toBe(true);
    const content = lastUser.content as Array<{ type: string; source?: { media_type: string }; text?: string }>;
    expect(content[0].type).toBe("image");
    expect(content[0].source?.media_type).toBe("image/png");
    expect(content[1].type).toBe("text");
    expect(content[1].text).toBe("what is this");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine-loop-knobs.test.ts`
Expected: FAIL — tool_result content stays a plain string.

- [ ] **Step 3: Implement**

(a) In `src/engine/messages.ts`, extend `ContentBlock`:

```ts
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };
```

(b) In `src/engine/loop.ts`, change the signature:

```ts
  async runTurn(
    userText: string,
    signal: AbortSignal,
    images?: Array<{ mediaType: string; base64: string }>
  ): Promise<void> {
```

and replace `this.messages.push({ role: "user", content: userText });` with:

```ts
    if (images && images.length > 0) {
      this.messages.push({
        role: "user",
        content: [
          ...images.map(im => ({
            type: "image",
            source: { type: "base64", media_type: im.mediaType, data: im.base64 }
          })),
          { type: "text", text: userText }
        ]
      });
    } else {
      this.messages.push({ role: "user", content: userText });
    }
```

(c) In `runTool`, before the existing success return, add an image-aware branch:

```ts
      if (out.images && out.images.length > 0) {
        const blocks: unknown[] = [{ type: "text", text: out.content }];
        for (const im of out.images) {
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: im.mediaType, data: im.base64 }
          });
        }
        return { type: "tool_result", tool_use_id: block.id, content: blocks, is_error: out.isError === true };
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/engine-loop-knobs.test.ts tests/engine-loop.test.ts tests/printMode.test.ts tests/session-integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/messages.ts src/engine/loop.ts tests/engine-loop-knobs.test.ts
git commit -m "feat(engine): image blocks flow through tool results and user messages"
```

---

### Task 3: OpenAI-compatible vision translation

**Files:**
- Modify: `src/engine/openaiApi.ts`
- Test: `tests/engine-openai-api.test.ts`

**Interfaces:**
- Consumes: image blocks in history (Task 2).
- Produces: in `translateMessages` — (1) user block-array messages containing image blocks become OpenAI multimodal `content` arrays with `{ type: "image_url", image_url: { url: "data:<mediaType>;base64,<data>" } }` parts; (2) tool_result block-array content that contains images emits the normal `role:"tool"` message (text only) followed by a `role:"user"` message carrying the image parts.

- [ ] **Step 1: Write the failing test**

Append to `tests/engine-openai-api.test.ts`. First export the translator for testing: in `src/engine/openaiApi.ts` change `function translateMessages` to `export function translateMessages`; then:

```ts
import { translateMessages } from "../src/engine/openaiApi.js";

describe("vision translation", () => {
  it("maps user image blocks to multimodal data-URL parts", () => {
    const out = translateMessages([
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
          { type: "text", text: "what is this" }
        ]
      }
    ]) as Array<{ role: string; content: unknown }>;
    expect(out).toHaveLength(1);
    expect(out[0].content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } },
      { type: "text", text: "what is this" }
    ]);
  });

  it("emits tool results as text plus a follow-up user message for images", () => {
    const out = translateMessages([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "result text" },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "eHg=" } }
        ]
      }
    ]) as Array<{ role: string; content: unknown }>;
    expect(out[0]).toMatchObject({ role: "tool", tool_call_id: "t1", content: "result text" });
    expect(out[1]).toEqual({
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,eHg=" } }]
    });
  });
});
```

If `tests/engine-openai-api.test.ts` already imports from openaiApi.js, merge this import into it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine-openai-api.test.ts`
Expected: FAIL — translateMessages is not exported / images dropped.

- [ ] **Step 3: Implement**

In `src/engine/openaiApi.ts`, inside `translateMessages`'s block-array branch, rework the non-assistant path. Replace the `for (const block of blocks)` loop's body so it collects parts instead of pushing directly:

```ts
    // role === "user": tool_result blocks and/or text/image blocks.
    let pendingImages: Array<Record<string, unknown>> = [];
    const flushImages = () => {
      if (pendingImages.length > 0) {
        out.push({ role: "user", content: pendingImages });
        pendingImages = [];
      }
    };
    for (const block of blocks) {
      if (block.type === "tool_result") {
        flushImages();
        out.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: flattenToolResultContent(block.content)
        });
      } else if (block.type === "image") {
        const source = block.source as { media_type?: string; data?: string };
        pendingImages.push({
          type: "image_url",
          image_url: { url: `data:${source.media_type};base64,${source.data}` }
        });
      } else if (block.type === "text") {
        flushImages();
        out.push({ role: "user", content: (block.text as string) ?? "" });
      }
    }
    flushImages();
```

(Keep everything after the loop unchanged; remove whatever old text/tool_result handling this replaces.)

Note: a user message whose content is ONLY image blocks still produces one multimodal user message via flushImages at the end. To make that case emit proper multimodal content (not a bare array on its own message), also handle the pure-image case up front:

```ts
    if (msg.role === "user") {
      const arr = blocks;
      if (arr.length > 0 && arr.every(b => b.type === "image" || b.type === "text")) {
        out.push({
          role: "user",
          content: arr.map(b => b.type === "image"
            ? { type: "image_url", image_url: { url: `data:${(b.source as { media_type: string }).media_type};base64,${(b.source as { data: string }).data}` } }
            : { type: "text", text: (b.text as string) ?? "" })
        });
        continue;
      }
    }
```

placed right before the tool_result loop. With both paths present, the loop handles mixed tool_result cases and the fast path handles pure user content.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/engine-openai-api.test.ts tests/engine-openai-api.test.ts tests/session-integration.test.ts`
Expected: PASS (dedupe the repeated file when actually running).

- [ ] **Step 5: Commit**

```bash
git add src/engine/openaiApi.ts tests/engine-openai-api.test.ts
git commit -m "feat(engine): map image blocks to OpenAI-compatible vision parts"
```

---
### Task 4: TUI clipboard attach (Ctrl+V)

**Files:**
- Create: `src/ui/clipboard.ts`
- Modify: `src/ui/keyRouter.ts`
- Modify: `src/ui/widgets/inputBox.ts`
- Modify: `src/ui/nativeApp.ts` (pending-attachment state + submit path)
- Modify: `src/agent/session.ts` (`send(text, images?)`)
- Test: `tests/clipboard.test.ts`, `tests/keyRouter.test.ts`, `tests/inputBox.test.ts`

**Interfaces:**
- Consumes: `runTurn(text, signal, images?)` (Task 2).
- Produces:
  - `captureClipboardImage(targetPath: string, run?): Promise<{ savedPath?: string; error?: string }>` from `src/ui/clipboard.ts`.
  - `KeyRouterHost.attachImage(): void` invoked on Ctrl+V while not streaming.
  - `InputBox.attachmentCount: number`, rendered in the hint row when > 0.
  - `AgentSession.send(text: string, images?: Array<{ mediaType: string; base64: string }>): void`.

- [ ] **Step 1: Write the failing tests**

Create `tests/clipboard.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { captureClipboardImage } from "../src/ui/clipboard.js";

describe("captureClipboardImage", () => {
  it("reports a command failure as an error string, never throws", async () => {
    const result = await captureClipboardImage("D:/does/not/matter.png", async () => {
      throw new Error("spawn failed");
    });
    expect(result.savedPath).toBeUndefined();
    expect(result.error).toContain("spawn failed");
  });

  it("returns the target path when the runner reports success", async () => {
    const result = await captureClipboardImage("D:/tmp/x.png", async () => undefined);
    expect(result).toEqual({ savedPath: "D:/tmp/x.png" });
  });
});
```

(The second parameter is an injectable runner so tests never touch a real clipboard.)

Append to `tests/keyRouter.test.ts` (adapt `baseHost` to the fixture name already used there):

```ts
it("Ctrl+V asks the host to attach a clipboard image while idle", () => {
  let attached = 0;
  const router = new KeyRouter({
    ...baseHost,
    isStreaming: () => false,
    attachImage: () => { attached += 1; }
  });
  router.handleKey({ t: "ctrl", ch: "v" });
  expect(attached).toBe(1);
});

it("ignores Ctrl+V while streaming", () => {
  let attached = 0;
  const router = new KeyRouter({
    ...baseHost,
    isStreaming: () => true,
    attachImage: () => { attached += 1; }
  });
  router.handleKey({ t: "ctrl", ch: "v" });
  expect(attached).toBe(0);
});
```

Append to `tests/inputBox.test.ts` (merge imports if THEMES/InputBox are already imported):

```ts
it("shows an attachment count in the hint row when images are pending", () => {
  const box = new InputBox();
  box.attachmentCount = 2;
  const render = box.render(THEMES.dark, 80, false);
  expect(render.hintRow).toContain("[image 2]");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/clipboard.test.ts tests/keyRouter.test.ts tests/inputBox.test.ts`
Expected: FAIL — clipboard module missing, no ctrl+v handling, no attachmentCount.

- [ ] **Step 3: Implement**

(a) Create `src/ui/clipboard.ts`. Structure:

```ts
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";

export type ClipboardRunner = (targetPath: string) => Promise<void>;

const platformRunner: ClipboardRunner = (targetPath) => new Promise((resolvePromise, reject) => {
  if (process.platform === "win32") {
    // PowerShell System.Drawing saves the clipboard bitmap as PNG.
    const script =
      "Add-Type -AssemblyName System.Windows.Forms;" +
      "$img = [Windows.Forms.Clipboard]::GetImage();" +
      `if ($img) { $img.Save('${targetPath}', [Drawing.Imaging.ImageFormat]::Png) }`;
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true }, err => err ? reject(err) : resolvePromise());
    return;
  }
  if (process.platform === "darwin") {
    // macOS: osascript writes the clipboard PNG class to the target file.
    execFile("osascript", ["-e",
      `set pngData to (the clipboard as class PNGf)` +
      "\nset fh to open for access POSIX file \"" + targetPath + "\" with write permission"
    ], {}, err => err ? reject(err) : resolvePromise());
    return;
  }
  // linux / X11
  execFile("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"], {},
    (err, stdout) => {
      if (err) { reject(err); return; }
      writeFileSync(targetPath, stdout);
      resolvePromise();
    });
});

/** Writes the clipboard image (when present) to targetPath as PNG. Never throws. */
export async function captureClipboardImage(
  targetPath: string,
  run: ClipboardRunner = platformRunner
): Promise<{ savedPath?: string; error?: string }> {
  try {
    await run(targetPath);
    return { savedPath: targetPath };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
```

(b) In `src/ui/keyRouter.ts`: add `attachImage(): void;` to `KeyRouterHost`, and handle the key next to the ctrl+l case:

```ts
    if (k.t === "ctrl" && k.ch === "v" && !this.host.isStreaming()) {
      this.host.attachImage();
      return;
    }
```

(c) In `src/ui/widgets/inputBox.ts`: add public field `attachmentCount = 0;` and replace the hint-row line:

```ts
    const attachHint = this.attachmentCount > 0 ? "[image " + this.attachmentCount + "] " : "";
    const hintRow = this.attachmentCount > 0
      ? attachHint + "Ctrl+V attach - Esc clear"
      : streaming ? "working… (Esc to interrupt)" : null;
```

(d) In `src/ui/nativeApp.ts`:
- Add field `private pendingImages: Array<{ mediaType: string; base64: string }> = [];`
- Implement `attachImage()` wherever the KeyRouter host is built: derive a temp path under `os.tmpdir()`, `await captureClipboardImage(path)`, verify `existsSync(path)` and non-zero size; on success read the file, push `{ mediaType: "image/png", base64 }`, increment the input box `attachmentCount`, `recompute()`; on failure/absent file show a notice ("No image in clipboard." or the error).
- Clearing: wherever Esc clears the input while idle, also reset `pendingImages` and `attachmentCount`.
- Submit: pass attachments into `this.session?.send(text, this.pendingImages)` then reset both.

(e) In `src/agent/session.ts`, extend `send(text: string, images?: Array<{ mediaType: string; base64: string }>)`: carry `images` through the async chain to `this.loop?.runTurn(text, controller.signal, images)`.

(f) Transcript display of block-array tool_result content: `toolResultPreview` in transcript.ts already flattens arrays by reading each block's `text` field; image blocks have none and are filtered out, so no change is needed — just confirm no crash via `tests/toolResult.test.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/clipboard.test.ts tests/keyRouter.test.ts tests/inputBox.test.ts tests/app.test.ts tests/toolResult.test.ts tests/session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/clipboard.ts src/ui/keyRouter.ts src/ui/widgets/inputBox.ts src/ui/nativeApp.ts src/agent/session.ts tests/
git commit -m "feat(ui): clipboard image attach via Ctrl+V"
```

---

### Task 5: Full verification

**Files:** none created; verification only.

- [ ] **Step 1: Type-check and build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 2: Lint and size check**

Run: `npm run lint ; npm run lint:size`
Expected: only the pre-existing warnings (`autoInject.test.ts` x2, `nativeApp.ts` soft limit).

- [ ] **Step 3: Whole suite on current Node AND Node 20**

Run: `npm test` then `npx -y node@20 node_modules/vitest/vitest.mjs run`
Expected: all suites pass on both.

- [ ] **Step 4: Manual smoke check (optional)**

Run `npm run dev`, take a screenshot into the clipboard, press Ctrl+V, submit "describe this screenshot". Expect: `[image 1]` indicator, then a model description. Also have the model Read any project .png and describe it.

- [ ] **Step 5: Commit stragglers**

```bash
git status
```

Expected: clean tree.
