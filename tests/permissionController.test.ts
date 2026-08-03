import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionController } from "../src/ui/permissionController.js";
import { OverlayManager } from "../src/ui/widgets/overlay.js";
import { PermissionStore } from "../src/agent/permissionStore.js";
import type { PermissionRequest } from "../src/agent/session.js";

function setup() {
  const overlay = new OverlayManager();
  const store = new PermissionStore(mkdtempSync(join(tmpdir(), "cc-permctl-")));
  const errors: string[] = [];
  let queueEmptied = 0;
  const controller = new PermissionController({
    overlay,
    store,
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
});
