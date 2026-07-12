import { describe, it, expect } from "vitest";
import { FakeTerminal } from "../src/ui/term/terminal.js";

describe("FakeTerminal", () => {
  it("is never a TTY", () => {
    const t = new FakeTerminal();
    expect(t.isTTY).toBe(false);
  });

  it("reports a default size", () => {
    const t = new FakeTerminal();
    expect(t.size()).toEqual({ rows: 24, columns: 80 });
  });

  it("accepts a custom size", () => {
    const t = new FakeTerminal({ rows: 10, columns: 40 });
    expect(t.size()).toEqual({ rows: 10, columns: 40 });
  });

  it("captures every write() call's string", () => {
    const t = new FakeTerminal();
    t.write("frame one");
    t.write("frame two");
    expect(t.writes).toEqual(["frame one", "frame two"]);
  });

  it("onLine delivers synthesized lines fed via feedLine (test helper)", () => {
    const t = new FakeTerminal();
    const lines: string[] = [];
    t.onLine(line => lines.push(line));
    t.feedLine("hello");
    expect(lines).toEqual(["hello"]);
  });

  it("onResize callback fires when resize() (test helper) is called", () => {
    const t = new FakeTerminal();
    let fired = false;
    t.onResize(() => { fired = true; });
    t.resize({ rows: 30, columns: 100 });
    expect(fired).toBe(true);
    expect(t.size()).toEqual({ rows: 30, columns: 100 });
  });

  it("cleanup() is idempotent and safe to call multiple times", () => {
    const t = new FakeTerminal();
    expect(() => { t.cleanup(); t.cleanup(); }).not.toThrow();
  });
});
