import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";

class Child extends EventEmitter {
  pid = 123;
  kills = 0;
  stdin = new EventEmitter();
  stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  stderr = new EventEmitter();
  kill(): void { this.kills++; }
}

describe("desktop backend diagnostic lifecycle", () => {
  it("records old-child failures without clearing or killing the current child", () => {
    const source = readFileSync("src/desktop/shell/main.mjs", "utf8");
    const start = source.slice(source.indexOf("function startChatBackend()"), source.indexOf("// Writes to the backend never throw"));
    const children: Child[] = [];
    const records: { event: string; fields: Record<string, unknown> }[] = [];
    const sandbox = {
      spawn: () => { const child = new Child(); children.push(child); return child; },
      resolveCliPath: () => "cli.js", resolveNodeExecutable: () => "node.exe",
      projectRoot: "project", existsSync: () => true, homedir: () => "home",
      process: { execPath: "electron.exe" }, Buffer,
      debugLog: { write: (event: string, fields: Record<string, unknown>) => records.push({ event, fields }) },
      diagnosticError: () => ({ errorCode: "EPIPE" }), send: () => undefined,
    };
    runInNewContext(`let chatChild; const quitting = false; ${start}
      startChatBackend(); startChatBackend();`, sandbox);
    const first = children[0];
    const second = children[1];
    first.stdin.emit("error", new Error("private"));
    first.emit("exit", 9, "SIGKILL");
    expect(first.kills).toBe(1);
    expect(second.kills).toBe(0);
    second.stderr.emit("data", Buffer.from("FATAL ERROR: heap out of memory private payload"));
    second.emit("exit", 137, null);
    expect(records).toContainEqual({ event: "backend-exit", fields: { childPid: 123, code: 9, signal: "SIGKILL", current: false, quitting: false } });
    expect(records).toContainEqual({ event: "backend-exit", fields: { childPid: 123, code: 137, signal: null, current: true, quitting: false } });
    expect(records.find(record => record.event === "backend-stderr")?.fields.outOfMemory).toBe(true);
    expect(JSON.stringify(records)).not.toContain("private");
  });
});
