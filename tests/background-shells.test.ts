import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { BackgroundShellManager, type ChildLike } from "../src/engine/tools/backgroundShells.js";

// Scriptable fake child: stdout/stderr are event emitters the manager pumps.
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & ChildLike;
  let outHandler: ((chunk: Buffer) => void) | undefined;
  const stdout = {
    on: (_e: string, h: (c: Buffer) => void) => { outHandler = h; }
  };
  Object.assign(child, { stdout, stderr: stdout, kill: () => { child.emit("exit", 1, "SIGTERM"); } });
  return {
    child,
    write(chunk: string) { outHandler?.(Buffer.from(chunk)); },
    exit(code: number) { child.emit("exit", code, null); }
  };
}

function managerWith(children: ReturnType<typeof fakeChild>[]) {
  return new BackgroundShellManager(() => {
    const fc = fakeChild();
    children.push(fc);
    return fc.child;
  });
}

describe("BackgroundShellManager", () => {
  it("assigns sequential ids and counts", () => {
    const mgr = managerWith([]);
    const r1 = mgr.start("server", "/tmp");
    const r2 = mgr.start("watcher", "/tmp");
    expect(r1.id).toBe("b1");
    expect(r2.id).toBe("b2");
    expect(mgr.count()).toBe(2);
  });

  it("accumulates output and reads incrementally", async () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const mgr = managerWith(children);
    mgr.start("cmd", "/tmp");
    await Promise.resolve();
    children[0].write("line one\n");
    expect(mgr.read("b1")).toContain("line one");
    children[0].write("line two\n");
    expect(mgr.read("b1")).toContain("line two");
    // Already consumed: next read returns nothing new.
    expect(mgr.read("b1")).toBe("");
    children[0].write("line three\n");
    expect(mgr.read("b1")).toContain("line three");
  });

  it("reports exit codes in status after exit fires", async () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const mgr = managerWith(children);
    mgr.start("cmd", "/tmp");
    await Promise.resolve();
    children[0].exit(7);
    expect(mgr.status("b1")).toBe("exited");
    expect(mgr.exitCode("b1")).toBe(7);
  });

  it("kills a shell, frees its slot, and reports remaining output", async () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const mgr = managerWith(children);
    mgr.start("cmd", "/tmp");
    await Promise.resolve();
    children[0].write("partial\n");
    const out = await mgr.kill("b1");
    expect(out).toContain("partial");
    expect(mgr.status("b1")).toBe("exited");
    expect(mgr.count()).toBe(0);
  });

  it("rejects starts beyond the cap of 10", () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const mgr = managerWith(children);
    for (let i = 0; i < 10; i++) mgr.start(`cmd${i}`, "/tmp");
    expect(mgr.start("extra", "/tmp").error).toBeDefined();
    expect(mgr.count()).toBe(10);
  });

  it("drops oldest output beyond the ring size and marks it", async () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const mgr = managerWith(children);
    mgr.start("cmd", "/tmp");
    await Promise.resolve();
    children[0].write("x".repeat(300 * 1024));
    const all = mgr.read("b1");
    expect(all.length).toBeLessThanOrEqual(200 * 1024 + "[earlier output dropped]".length);
    expect(all.startsWith("[earlier output dropped]")).toBe(true);
  });

  it("killAll terminates everything", async () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const mgr = managerWith(children);
    mgr.start("a", "/tmp");
    mgr.start("b", "/tmp");
    await Promise.resolve();
    mgr.killAll();
    expect(mgr.count()).toBe(0);
  });
});
