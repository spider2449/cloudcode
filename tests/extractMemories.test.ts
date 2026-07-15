import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, dirname, sep } from "node:path";
import {
  countModelMessages, hasMemoryWrites, formatTranscript, runExtraction
} from "../src/engine/extractMemories.js";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "ccext-")); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

const user = (text: string) => ({ role: "user", content: text });
const asst = (blocks: unknown[]) => ({ role: "assistant", content: blocks });

describe("countModelMessages", () => {
  it("counts messages from the cursor", () => {
    const msgs = [user("a"), asst([{ type: "text", text: "b" }]), user("c")];
    expect(countModelMessages(msgs, 0)).toBe(3);
    expect(countModelMessages(msgs, 2)).toBe(1);
  });
});

describe("hasMemoryWrites", () => {
  it("detects Write/Edit tool_use into the memory dir after the cursor", () => {
    const dir = join(tmp(), "memory");
    const inside = asst([{ type: "tool_use", id: "1", name: "Write", input: { file_path: join(dir, "a.md") } }]);
    const outside = asst([{ type: "tool_use", id: "2", name: "Write", input: { file_path: join(tmp(), "b.md") } }]);
    expect(hasMemoryWrites([inside], 0, dir)).toBe(true);
    expect(hasMemoryWrites([outside], 0, dir)).toBe(false);
    expect(hasMemoryWrites([inside], 1, dir)).toBe(false); // before cursor
  });
});

describe("formatTranscript", () => {
  it("renders roles, text, and tool names; skips tool_result bodies", () => {
    const msgs = [
      user("fix the bug"),
      asst([{ type: "text", text: "ok" }, { type: "tool_use", id: "1", name: "Bash", input: { command: "ls" } }]),
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "big output" }] }
    ];
    const t = formatTranscript(msgs, 0);
    expect(t).toContain("USER: fix the bug");
    expect(t).toContain("ASSISTANT: ok");
    expect(t).toContain("[tool: Bash]");
    expect(t).not.toContain("big output");
  });
});

describe("runExtraction", () => {
  // Minimal fake stream client: first call returns a Write tool_use into the
  // memory dir; second call returns plain text (ends the loop).
  function fakeClient(dir: string, calls: unknown[][]) {
    let n = 0;
    return {
      async *create(req: unknown, _signal: AbortSignal) {
        calls.push([req]);
        const first = n++ === 0;
        if (first) {
          yield { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "Write" } };
          yield { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify({ file_path: join(dir, "user_role.md"), content: "---\nname: user-role\ndescription: d\ntype: user\n---\nx" }) } };
          yield { type: "content_block_stop" };
          yield { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} };
        } else {
          yield { type: "content_block_start", content_block: { type: "text", text: "done" } };
          yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} };
        }
      }
    };
  }

  it("writes memory files via the guarded Write tool", async () => {
    const dir = join(tmp(), "memory");
    mkdirSync(dir, { recursive: true });
    const calls: unknown[][] = [];
    const wrote = await runExtraction({
      client: fakeClient(dir, calls) as never, model: "m", memoryDir: dir,
      messages: [user("I'm a data scientist"), asst([{ type: "text", text: "noted" }])], fromIndex: 0
    });
    expect(wrote).toBe(true);
    expect(readFileSync(join(dir, "user_role.md"), "utf8")).toContain("type: user");
  });

  it("rejects writes outside the memory dir", async () => {
    const dir = join(tmp(), "memory");
    mkdirSync(dir, { recursive: true });
    const evil = join(tmp(), "evil.md");
    let n = 0;
    const client = {
      async *create(_req: unknown, _s: AbortSignal) {
        const first = n++ === 0;
        if (first) {
          // First turn: model attempts a Write outside the memory dir.
          // stop_reason MUST be "tool_use" so runExtraction actually
          // reaches the tool-processing block and exercises the guard —
          // otherwise the loop breaks before the guard is ever checked
          // and this test would pass vacuously even with no guard at all.
          yield { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "Write" } };
          yield { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify({ file_path: evil, content: "x" }) } };
          yield { type: "content_block_stop" };
          yield { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} };
        } else {
          // Second turn: model sees the denial and gives up with plain
          // text, ending the loop naturally (not via MAX_EXTRACT_TURNS).
          yield { type: "content_block_start", content_block: { type: "text", text: "denied, nothing to save" } };
          yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} };
        }
      }
    };
    const wrote = await runExtraction({
      client: client as never, model: "m", memoryDir: dir,
      messages: [user("hi")], fromIndex: 0
    });
    expect(wrote).toBe(false);
    expect(existsSync(evil)).toBe(false);
    expect(n).toBe(2); // loop terminated naturally after one denied attempt, not via MAX_EXTRACT_TURNS
  });

  it("rejects writes outside the memory dir via a relative path resolved against dir, not cwd", async () => {
    const dir = join(tmp(), "memory");
    mkdirSync(dir, { recursive: true });
    // Relative to the memory dir, "../evil.md" escapes it. If the guard were
    // (incorrectly) resolved against process.cwd() instead of dir, this
    // relative path could resolve to a completely different, possibly safe,
    // location — masking the fact that the tool itself resolves it against
    // dir and would actually write outside the memory directory.
    const evil = join(dir, "..", "evil.md");
    let n = 0;
    const client = {
      async *create(_req: unknown, _s: AbortSignal) {
        const first = n++ === 0;
        if (first) {
          yield { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "Write" } };
          yield { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify({ file_path: "../evil.md", content: "x" }) } };
          yield { type: "content_block_stop" };
          yield { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} };
        } else {
          yield { type: "content_block_start", content_block: { type: "text", text: "denied, nothing to save" } };
          yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} };
        }
      }
    };
    const wrote = await runExtraction({
      client: client as never, model: "m", memoryDir: dir,
      messages: [user("hi")], fromIndex: 0
    });
    expect(wrote).toBe(false);
    expect(existsSync(evil)).toBe(false);
  });

  it("evaluates the guard against the same resolved path the tool will actually write to", async () => {
    // Place `dir` as a sibling of process.cwd() (same drive, same ancestor
    // tree) rather than nested under cwd or under os.tmpdir(). This makes it
    // possible to craft a relative file_path whose ".." arithmetic lands in
    // two genuinely different places depending on the resolution base:
    //  - resolved against process.cwd() (what the OLD buggy guard did): lands
    //    INSIDE `dir` -> the old guard would have waved it through.
    //  - resolved against `dir` (what the real Write tool does via ctx.cwd):
    //    lands OUTSIDE `dir` entirely -> a genuine escape.
    // (A dir nested under cwd or under os.tmpdir() can't demonstrate this:
    // nesting under cwd just goes deeper inside dir either way, and
    // os.tmpdir() is often on a different drive on Windows, which makes
    // node:path's relative() fall back to an absolute path.)
    const cwd = process.cwd();
    const siblingRoot = mkdtempSync(join(dirname(cwd), "ccext-"));
    tmps.push(siblingRoot);
    const dir = join(siblingRoot, "memory");
    mkdirSync(dir, { recursive: true });
    const trapInsideViaCwd = join(dir, "trap.md");
    const relativeFromCwd = relative(cwd, trapInsideViaCwd);
    const wouldActuallyResolveTo = resolve(dir, relativeFromCwd);
    // Sanity-check the construction itself, independent of runExtraction:
    // the same relative string must resolve inside `dir` from cwd's
    // perspective, but outside `dir` from dir's own perspective.
    expect(resolve(cwd, relativeFromCwd)).toBe(trapInsideViaCwd);
    expect(wouldActuallyResolveTo.startsWith(dir + sep)).toBe(false);
    const client = {
      async *create(_req: unknown, _s: AbortSignal) {
        yield { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "Write" } };
        yield { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify({ file_path: relativeFromCwd, content: "x" }) } };
        yield { type: "content_block_stop" };
        yield { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} };
      }
    };
    const wrote = await runExtraction({
      client: client as never, model: "m", memoryDir: dir,
      messages: [user("hi")], fromIndex: 0
    });
    expect(wrote).toBe(false);
    expect(existsSync(trapInsideViaCwd)).toBe(false);
    expect(existsSync(wouldActuallyResolveTo)).toBe(false);
  });
});
