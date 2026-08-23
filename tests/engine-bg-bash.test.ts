import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { bashTool } from "../src/engine/tools/bash.js";
import { createBashOutputTool, createKillShellTool } from "../src/engine/tools/bashOut.js";
import { builtinTools } from "../src/engine/registry.js";
import { decidePermission } from "../src/engine/permissions.js";
import { PermissionStore } from "../src/agent/permissionStore.js";
import { BackgroundShellManager, type ChildLike } from "../src/engine/tools/backgroundShells.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function freshStore() {
  return new PermissionStore(mkdtempSync(join(tmpdir(), "cc-bgbash-")));
}

describe("background bash tools", () => {
  it("permissions: BashOutput/KillShell always allowed, Bash unchanged", () => {
    const store = freshStore();
    expect(decidePermission("BashOutput", {}, "default", store, "/p")).toBe("allow");
    expect(decidePermission("KillShell", { id: "b1" }, "default", store, "/p")).toBe("allow");
    expect(decidePermission("Bash", { command: "ls" }, "default", store, "/p")).toBe("ask");
  });

  it("registry registers output/kill tools only when bgShells provided", () => {
    expect(builtinTools().map(t => t.name)).not.toContain("BashOutput");
    const names = builtinTools({ bgShells: new BackgroundShellManager(() => fakeChildLocal().child) }).map(t => t.name);
    expect(names).toContain("BashOutput");
    expect(names).toContain("KillShell");
  });
});

function fakeChildLocal() {
  const child = new EventEmitter() as EventEmitter & ChildLike;
  let outHandler: ((chunk: Buffer) => void) | undefined;
  const stdout = { on: (_e: string, h: (c: Buffer) => void) => { outHandler = h; } };
  Object.assign(child, { stdout, stderr: stdout, kill: () => { child.emit("exit", 1, "SIGTERM"); } });
  return {
    child: child as ChildLike,
    write(chunk: string) { outHandler?.(Buffer.from(chunk)); },
    exit(code: number) { child.emit("exit", code, null); }
  };
}
type FakeChildHolder = ReturnType<typeof fakeChildLocal>;

function mgrWithLocals(locals: FakeChildHolder[]) {
  return new BackgroundShellManager(() => {
    const fc = fakeChildLocal();
    locals.push(fc);
    return fc.child;
  });
}

describe("Bash run_in_background flow", () => {
  it("starts a shell and returns its id immediately", async () => {
    const locals: FakeChildHolder[] = [];
    const mgr = mgrWithLocals(locals);
    const out = await bashTool.execute(
      { command: "npm run dev", run_in_background: true },
      { cwd: "/tmp", bgShells: mgr }
    );
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain("id: b1");
    expect(out.content).toContain("BashOutput");
    expect(locals).toHaveLength(1);
  });

  it("BashOutput reads new output and reports running status", async () => {
    const locals: FakeChildHolder[] = [];
    const mgr = mgrWithLocals(locals);
    await bashTool.execute({ command: "server", run_in_background: true }, { cwd: "/tmp", bgShells: mgr });
    await Promise.resolve();
    locals[0].write("listening on 3000\n");
    const out = await createBashOutputTool(mgr).execute({ id: "b1" }, { cwd: "/tmp" });
    expect(out.content).toContain("listening on 3000");
    expect(out.content).toContain("running");
  });

  it("unknown ids produce error results", async () => {
    const mgr = new BackgroundShellManager(() => fakeChildLocal().child);
    const out = await createBashOutputTool(mgr).execute({ id: "nope" }, { cwd: "/tmp" });
    expect(out.isError).toBe(true);
  });

  it("KillShell terminates and frees the slot", async () => {
    const locals: FakeChildHolder[] = [];
    const mgr = mgrWithLocals(locals);
    await bashTool.execute({ command: "server", run_in_background: true }, { cwd: "/tmp", bgShells: mgr });
    const out = await createKillShellTool(mgr).execute({ id: "b1" }, { cwd: "/tmp" });
    expect(out.content).toContain("killed");
    expect(mgr.count()).toBe(0);
  });
});
