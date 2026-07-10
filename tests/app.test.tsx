import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/ui/App.js";
import { SessionIndex } from "../src/agent/sessionIndex.js";

const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));

function fakeQueryFn() {
  return (args: { prompt: AsyncIterable<unknown> }) => {
    const gen = (async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-1" };
      for await (const _ of args.prompt) {
        yield { type: "assistant", message: { content: [{ type: "text", text: "hello from model" }] } };
        yield { type: "result", subtype: "success", total_cost_usd: 0.01, duration_ms: 500 };
      }
    })();
    return Object.assign(gen, { interrupt: vi.fn(), setModel: vi.fn(), setPermissionMode: vi.fn() });
  };
}

function makeApp() {
  const index = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json"));
  return render(
    <App
      cwd="/p"
      providers={{ anthropic: {}, local: { baseUrl: "http://x", apiKey: "k" } }}
      initialProvider="anthropic"
      sessionIndex={index}
      queryFn={fakeQueryFn() as never}
    />
  );
}

describe("App", () => {
  it("round-trips a user message to assistant output", async () => {
    const { stdin, lastFrame } = makeApp();
    await wait();
    stdin.write("hi");
    await wait();
    stdin.write("\r");
    await wait(100);
    expect(lastFrame()).toContain("> hi");
    expect(lastFrame()).toContain("hello from model");
  });

  it("shows token usage and context percent after a result message", async () => {
    const index = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json"));
    const usageQueryFn = (args: { prompt: AsyncIterable<unknown> }) => {
      const gen = (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        for await (const _ of args.prompt) {
          yield { type: "assistant", message: { content: [{ type: "text", text: "hello from model" }] } };
          yield {
            type: "result", subtype: "success", total_cost_usd: 0.01, duration_ms: 5,
            usage: { input_tokens: 9000, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0, output_tokens: 345 }
          };
        }
      })();
      return Object.assign(gen, { interrupt: vi.fn(), setModel: vi.fn(), setPermissionMode: vi.fn() });
    };
    const { stdin, lastFrame } = render(
      <App cwd="/p" providers={{ anthropic: {} }} initialProvider="anthropic" sessionIndex={index} queryFn={usageQueryFn as never} />
    );
    await wait();
    stdin.write("hi");
    await wait();
    stdin.write("\r");
    await wait(100);
    expect(lastFrame()).toContain("12.3k tok");
    expect(lastFrame()).toContain("(6%)");
    expect(lastFrame()).toContain("$0.0100");
  });

  it("shows an error notice instead of crashing when a slash command rejects", async () => {
    const index = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json"));
    const rejectingQueryFn = (args: { prompt: AsyncIterable<unknown> }) => {
      const gen = (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        for await (const _ of args.prompt) { /* drain */ }
      })();
      return Object.assign(gen, {
        interrupt: vi.fn(),
        setModel: vi.fn().mockRejectedValue(new Error("not a recognized model id")),
        setPermissionMode: vi.fn()
      });
    };
    const { stdin, lastFrame } = render(
      <App
        cwd="/p"
        providers={{ anthropic: {} }}
        initialProvider="anthropic"
        sessionIndex={index}
        queryFn={rejectingQueryFn as never}
      />
    );
    await wait();
    stdin.write("/model bogus");
    await wait();
    stdin.write("\r");
    await wait(100);
    expect(lastFrame()).toContain("not a recognized model id");
  });

  it("handles unknown slash command with a notice", async () => {
    const { stdin, lastFrame } = makeApp();
    await wait();
    stdin.write("/nope");
    await wait();
    stdin.write("\r");
    await wait(100);
    expect(lastFrame()).toContain("Unknown command: /nope");
  });

  it("switches provider via /provider and shows it in status bar", async () => {
    const { stdin, lastFrame } = makeApp();
    await wait();
    stdin.write("/provider local");
    await wait();
    stdin.write("\r");
    await wait(100);
    expect(lastFrame()).toContain("local");
  });

  it("streams partial text then replaces it with the final message", async () => {
    const index = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json"));
    let releaseFinal: () => void = () => {};
    const gate = new Promise<void>(r => { releaseFinal = r; });
    const streamingQueryFn = (args: { prompt: AsyncIterable<unknown> }) => {
      const gen = (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        for await (const _ of args.prompt) {
          yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "par" } } };
          yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "tial" } } };
          await gate;
          yield { type: "assistant", message: { content: [{ type: "text", text: "partial and final" }] } };
          yield { type: "result", subtype: "success", total_cost_usd: 0.01, duration_ms: 100 };
        }
      })();
      return Object.assign(gen, { interrupt: vi.fn(), setModel: vi.fn(), setPermissionMode: vi.fn() });
    };
    const { stdin, lastFrame } = render(
      <App cwd="/p" providers={{ anthropic: {} }} initialProvider="anthropic" sessionIndex={index} queryFn={streamingQueryFn as never} />
    );
    await wait();
    stdin.write("go");
    await wait();
    stdin.write("\r");
    await wait(100);
    expect(lastFrame()).toContain("partial");          // partial text visible while gated
    releaseFinal();
    await wait(100);
    expect(lastFrame()).toContain("partial and final"); // final replaces it
    const finalFrame = lastFrame()!;
    expect(finalFrame.match(/partial/g)!.length).toBe(1); // no duplicate partial+final
  });

  it("shows the working indicator while streaming", async () => {
    const index = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json"));
    const neverEndingQueryFn = (args: { prompt: AsyncIterable<unknown> }) => {
      const gen = (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        for await (const _ of args.prompt) {
          await new Promise(() => {}); // never resolves
        }
      })();
      return Object.assign(gen, { interrupt: vi.fn(), setModel: vi.fn(), setPermissionMode: vi.fn() });
    };
    const { stdin, lastFrame } = render(
      <App cwd="/p" providers={{ anthropic: {} }} initialProvider="anthropic" sessionIndex={index} queryFn={neverEndingQueryFn as never} />
    );
    await wait();
    stdin.write("go");
    await wait();
    stdin.write("\r");
    await wait(100);
    expect(lastFrame()).toContain("Thinking…");
  });

  function permissionProbeQueryFn(filePath: string, outcomes: unknown[]) {
    return (args: { prompt: AsyncIterable<unknown>; options: { canUseTool: (t: string, i: object) => Promise<unknown> } }) => {
      const gen = (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        for await (const _ of args.prompt) {
          outcomes.push(await args.options.canUseTool("Write", { file_path: filePath }));
          yield { type: "result", subtype: "success", total_cost_usd: 0, duration_ms: 1 };
        }
      })();
      return Object.assign(gen, { interrupt: vi.fn(), setModel: vi.fn(), setPermissionMode: vi.fn() });
    };
  }

  it("auto-allows when a stored rule matches, without showing the dialog", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cc-app-perm-"));
    const { PermissionStore } = await import("../src/agent/permissionStore.js");
    new PermissionStore(cwd).remember("Write", join(cwd, "src", "seed.ts"), "allow");
    const outcomes: unknown[] = [];
    const index = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json"));
    const { stdin, lastFrame } = render(
      <App cwd={cwd} providers={{ anthropic: {} }} initialProvider="anthropic" sessionIndex={index}
           queryFn={permissionProbeQueryFn(join(cwd, "src", "file.ts"), outcomes) as never} />
    );
    await wait();
    stdin.write("go");
    await wait();
    stdin.write("\r");
    await wait(150);
    expect(outcomes[0]).toMatchObject({ behavior: "allow" });
    expect(lastFrame()).toContain("auto-allowed: Write");
    expect(lastFrame()).not.toContain("Permission required");
  });

  it("choosing 'Always' saves a rule so the next request auto-resolves", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cc-app-perm-"));
    const outcomes: unknown[] = [];
    const index = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json"));
    const { stdin, lastFrame } = render(
      <App cwd={cwd} providers={{ anthropic: {} }} initialProvider="anthropic" sessionIndex={index}
           queryFn={permissionProbeQueryFn(join(cwd, "src", "file.ts"), outcomes) as never} />
    );
    await wait();
    stdin.write("first");
    await wait();
    stdin.write("\r");
    await wait(150);
    expect(lastFrame()).toContain("Permission required");
    stdin.write("a"); // Always for this directory
    await wait(150);
    expect(outcomes[0]).toMatchObject({ behavior: "allow" });
    stdin.write("second");
    await wait();
    stdin.write("\r");
    await wait(150);
    expect(outcomes[1]).toMatchObject({ behavior: "allow" });
    expect(lastFrame()).toContain("auto-allowed: Write");
  });

  it("a deny rule auto-denies without a dialog", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cc-app-perm-"));
    const { PermissionStore } = await import("../src/agent/permissionStore.js");
    new PermissionStore(cwd).remember("Write", join(cwd, "secret", "seed.txt"), "deny");
    const outcomes: unknown[] = [];
    const index = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-")), "sessions.json"));
    const { stdin, lastFrame } = render(
      <App cwd={cwd} providers={{ anthropic: {} }} initialProvider="anthropic" sessionIndex={index}
           queryFn={permissionProbeQueryFn(join(cwd, "secret", "x.txt"), outcomes) as never} />
    );
    await wait();
    stdin.write("go");
    await wait();
    stdin.write("\r");
    await wait(150);
    expect(outcomes[0]).toMatchObject({ behavior: "deny" });
    expect(lastFrame()).toContain("auto-denied: Write");
    expect(lastFrame()).not.toContain("Permission required");
  });
});
