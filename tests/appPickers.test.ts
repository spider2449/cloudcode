import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openResumePicker, openProjectPicker, openMemoryPicker, type PickerDeps } from "../src/ui/appPickers.js";
import { OverlayManager } from "../src/ui/widgets/overlay.js";
import { SessionIndex } from "../src/agent/sessionIndex.js";

function setup(cwd = "/repo") {
  const overlay = new OverlayManager();
  const sessionIndex = new SessionIndex(join(mkdtempSync(join(tmpdir(), "cc-pickers-")), "sessions.json"));
  const notices: string[] = [];
  let repaints = 0;
  const deps: PickerDeps = {
    overlay,
    cwd,
    sessionIndex,
    notice: t => { notices.push(t); },
    recompute: () => { repaints += 1; }
  };
  return { deps, overlay, sessionIndex, notices, repaints: () => repaints };
}

describe("appPickers", () => {
  it("openResumePicker offers only this project's sessions and repaints", () => {
    const { deps, overlay, sessionIndex, repaints } = setup();
    sessionIndex.record({ id: "here", cwd: "/repo", firstMessage: "a", timestamp: "2026-01-01", provider: "anthropic" });
    sessionIndex.record({ id: "elsewhere", cwd: "/other", firstMessage: "b", timestamp: "2026-01-02", provider: "anthropic" });
    const picked: string[] = [];
    openResumePicker(deps, e => picked.push(e.id));
    expect(overlay.mode).toBe("resume");
    expect(repaints()).toBe(1);
    overlay.handleKey({ t: "enter" });
    expect(picked).toEqual(["here"]);
  });

  it("Esc closes a picker and repaints", () => {
    const { deps, overlay, repaints } = setup();
    openResumePicker(deps, () => {});
    overlay.handleKey({ t: "esc" });
    expect(overlay.mode).toBe("none");
    expect(repaints()).toBe(2); // once on open, once on cancel
  });

  it("openProjectPicker notices an unusable path instead of switching to it", () => {
    const { deps, overlay, notices } = setup();
    const switched: string[] = [];
    openProjectPicker(deps, p => switched.push(p));
    expect(overlay.mode).toBe("project");
    // A path that cannot be resolved to a directory must not switch projects.
    for (const ch of "/definitely/not/here") overlay.handleKey({ t: "printable", ch }, ch);
    overlay.handleKey({ t: "enter" });
    expect(switched).toEqual([]);
    expect(notices).toHaveLength(1);
  });

  it("openMemoryPicker lists the memory targets for the cwd", () => {
    const { deps, overlay, repaints } = setup(mkdtempSync(join(tmpdir(), "cc-mem-")));
    openMemoryPicker(deps, () => {});
    expect(overlay.mode).toBe("memory");
    expect(repaints()).toBe(1);
    overlay.handleKey({ t: "esc" });
    expect(overlay.mode).toBe("none");
  });
});
