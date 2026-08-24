import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionController } from "../src/ui/permissionController.js";
import { OverlayManager } from "../src/ui/widgets/overlay.js";
import { PermissionStore } from "../src/agent/permissionStore.js";
import type { PermissionRequest } from "../src/agent/session.js";

vi.mock("../src/agent/settings.js", () => ({ saveNetworkStorageRule: vi.fn() }));
import { saveNetworkStorageRule } from "../src/agent/settings.js";

function setup() {
  const overlay = new OverlayManager();
  const store = new PermissionStore(mkdtempSync(join(tmpdir(), "cc-permctl-")));
  const cwd = mkdtempSync(join(tmpdir(), "cc-permctl-cwd-"));
  const errors: string[] = [];
  let queueEmptied = 0;
  const controller = new PermissionController({
    overlay,
    store,
    cwd,
    onError: t => { errors.push(t); },
    onQueueEmpty: () => { queueEmptied += 1; },
    recompute: () => {}
  });
  return { overlay, store, controller, errors, emptied: () => queueEmptied };
}

function request(toolName: string, input: Record<string, unknown>, answers: boolean[]): PermissionRequest {
  return { toolName, input, resolve: allow => { answers.push(allow); } };
}

describe("PermissionController", () => {
  it("opens the overlay for the first request and answers it", () => {
    const { overlay, controller, emptied } = setup();
    const answers: boolean[] = [];
    controller.enqueue(request("Read", { file_path: "/repo/a.ts" }, answers));
    expect(overlay.mode).toBe("permission");
    overlay.handleKey({ t: "enter" }); // default option: allow once
    expect(answers).toEqual([true]);
    expect(overlay.mode).toBe("none");
    expect(emptied()).toBe(1);
  });

  it("shows queued requests one at a time, in order", () => {
    const { overlay, controller, emptied } = setup();
    const answers: boolean[] = [];
    controller.enqueue(request("Read", { file_path: "/repo/a.ts" }, answers));
    controller.enqueue(request("Read", { file_path: "/repo/b.ts" }, answers));
    // The second request must not replace the overlay the user is answering.
    expect(overlay.mode).toBe("permission");
    expect(emptied()).toBe(0);
    overlay.handleKey({ t: "esc" }); // deny the first
    expect(answers).toEqual([false]);
    // The next one opens immediately; the queue is not empty yet.
    expect(overlay.mode).toBe("permission");
    expect(emptied()).toBe(0);
    overlay.handleKey({ t: "enter" });
    expect(answers).toEqual([false, true]);
    expect(emptied()).toBe(1);
  });

  it("remembers a directory rule when the answer says to", () => {
    const { overlay, store, controller } = setup();
    const answers: boolean[] = [];
    controller.enqueue(request("Write", { file_path: "/repo/src/a.ts" }, answers));
    overlay.handleKey({ t: "printable", ch: "a" }, "a"); // "always allow" hotkey
    expect(answers).toEqual([true]);
    expect(store.check("Write", "/repo/src/b.ts")).toBe("allow");
  });

  it("remembers a search directory rule for tools that take a path", () => {
    const { overlay, store, controller } = setup();
    const answers: boolean[] = [];
    controller.enqueue(request("Grep", { pattern: "x", path: "/outside/logs" }, answers));
    overlay.handleKey({ t: "printable", ch: "a" }, "a"); // "always allow" hotkey
    expect(answers).toEqual([true]);
    // Scoped to the searched directory, not to /outside.
    expect(store.check("Grep", "/outside/logs/app.log")).toBe("allow");
    expect(store.check("Grep", "/outside/other.log")).toBeUndefined();
  });

  it("remembers a WebFetch decision scoped to the host", () => {
    const { overlay, store, controller } = setup();
    const answers: boolean[] = [];
    controller.enqueue(request("WebFetch", { url: "https://docs.example.com/page" }, answers));
    overlay.handleKey({ t: "printable", ch: "a" }, "a"); // "always allow" hotkey
    expect(answers).toEqual([true]);
    expect(store.checkHost("WebFetch", "docs.example.com")).toBe("allow");
    expect(store.checkHost("WebFetch", "other.com")).toBeUndefined();
  });

  it("reports a failed rule write without dropping the answer", () => {
    const { overlay, store, controller, errors } = setup();
    const answers: boolean[] = [];
    // Simulate an unwritable permissions file.
    store.remember = () => { throw new Error("EACCES"); };
    controller.enqueue(request("Write", { file_path: "/repo/src/a.ts" }, answers));
    overlay.handleKey({ t: "printable", ch: "a" }, "a");
    expect(answers).toEqual([true]); // the tool call still proceeds
    expect(errors[0]).toContain("Failed to save permission rule");
  });

  describe("network path remembering", () => {
    beforeEach(() => {
      vi.mocked(saveNetworkStorageRule).mockClear();
    });

    it("routes an outside-cwd network remember into global settings, not the project store", () => {
      const { overlay, store, controller } = setup();
      const answers: boolean[] = [];
      controller.enqueue(request("Write", { file_path: "//server/share/deep/f.txt" }, answers));
      overlay.handleKey({ t: "printable", ch: "a" }, "a"); // "always allow" hotkey
      expect(answers).toEqual([true]);
      expect(vi.mocked(saveNetworkStorageRule)).toHaveBeenCalledWith("//server/share", "allow");
      expect(store.list()).toEqual([]);
    });

    it("still remembers local paths in the project store without touching settings", () => {
      const { overlay, store, controller } = setup();
      const answers: boolean[] = [];
      controller.enqueue(request("Write", { file_path: "/repo/src/a.ts" }, answers));
      overlay.handleKey({ t: "printable", ch: "a" }, "a");
      expect(answers).toEqual([true]);
      expect(vi.mocked(saveNetworkStorageRule)).not.toHaveBeenCalled();
      expect(store.check("Write", "/repo/src/b.ts")).toBe("allow");
    });
  });
});
