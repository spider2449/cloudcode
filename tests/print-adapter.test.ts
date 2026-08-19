import { describe, expect, it, vi } from "vitest";
import { PrintAdapter } from "../src/print/adapter.js";

function make(format: "text" | "json" | "stream-json") {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const adapter = new PrintAdapter({
    outputFormat: format, io: { out: text => stdout.push(text), err: text => stderr.push(text) },
    provider: "local", model: "qwen", networkMode: "offlineStrict", secrets: ["secret"], onFinished: vi.fn()
  });
  return { adapter, stdout, stderr };
}

describe("PrintAdapter", () => {
  it("keeps stream-json stdout parseable and emits stable tool ordering", () => {
    const { adapter, stdout, stderr } = make("stream-json");
    adapter.start();
    adapter.handleMessage({
      type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a" } }] }
    });
    adapter.handleMessage({ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false });
    adapter.handleMessage({ type: "result", subtype: "success", duration_ms: 5, finish_reason: "completed" });
    adapter.finalize({ durationMs: 6, provider: "local", model: "qwen" });
    const kinds = stdout.map(line => JSON.parse(line).event.kind);
    expect(kinds).toEqual(["run.started", "assistant.message", "tool.started", "tool.finished", "run.finished"]);
    expect(stderr).toEqual([]);
  });

  it("emits exactly one JSON document and redacts errors", () => {
    const { adapter, stdout } = make("json");
    adapter.start();
    adapter.handleMessage({ type: "result", subtype: "error_during_execution", result: "bad secret" });
    adapter.finalize({ durationMs: 1, provider: "local", model: "qwen" });
    expect(stdout).toHaveLength(1);
    const document = JSON.parse(stdout[0]);
    expect(document.result).toMatchObject({ finishReason: "error", exitCode: 1 });
    expect(stdout[0]).not.toContain("secret");
  });
});
