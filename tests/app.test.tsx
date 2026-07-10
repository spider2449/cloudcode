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
});
