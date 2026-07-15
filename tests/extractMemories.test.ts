import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const client = {
      async *create(_req: unknown, _s: AbortSignal) {
        yield { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "Write" } };
        yield { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify({ file_path: evil, content: "x" }) } };
        yield { type: "content_block_stop" };
        yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} };
      }
    };
    const wrote = await runExtraction({
      client: client as never, model: "m", memoryDir: dir,
      messages: [user("hi")], fromIndex: 0
    });
    expect(wrote).toBe(false);
    expect(existsSync(evil)).toBe(false);
  });
});
