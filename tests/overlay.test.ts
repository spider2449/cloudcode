import { describe, it, expect, vi } from "vitest";
import { OverlayManager } from "../src/ui/widgets/overlay.js";
import { THEMES } from "../src/ui/theme.js";
import type { SessionEntry } from "../src/agent/sessionIndex.js";

const theme = THEMES.dark;

function entries(n: number): SessionEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`, cwd: "/repo", firstMessage: `msg ${i}`, timestamp: `t${i}`, provider: "anthropic"
  }));
}

describe("OverlayManager resume sub-mode", () => {
  it("starts closed", () => {
    const mgr = new OverlayManager();
    expect(mgr.mode).toBe("none");
    expect(mgr.isOpen).toBe(false);
  });

  it("openResume switches mode to resume and isOpen becomes true", () => {
    const mgr = new OverlayManager();
    mgr.openResume(entries(2), () => {}, () => {});
    expect(mgr.mode).toBe("resume");
    expect(mgr.isOpen).toBe(true);
  });

  it("down/up arrows move the selection within bounds", () => {
    const mgr = new OverlayManager();
    mgr.openResume(entries(3), () => {}, () => {});
    mgr.handleKey({ t: "down" });
    mgr.handleKey({ t: "down" });
    mgr.handleKey({ t: "down" }); // clamps at last index
    const rows = mgr.render(theme, 80);
    expect(rows.some(r => r.includes("msg 2"))).toBe(true);
  });

  it("Enter calls onPick with the selected entry", () => {
    const onPick = vi.fn();
    const mgr = new OverlayManager();
    mgr.openResume(entries(2), onPick, () => {});
    mgr.handleKey({ t: "down" });
    mgr.handleKey({ t: "enter" });
    expect(onPick).toHaveBeenCalledWith(entries(2)[1]);
  });

  it("Escape calls onCancel and closes the overlay", () => {
    const onCancel = vi.fn();
    const mgr = new OverlayManager();
    mgr.openResume(entries(1), () => {}, onCancel);
    mgr.handleKey({ t: "esc" });
    expect(onCancel).toHaveBeenCalled();
  });

  it("caps rendered rows at MAX_ROWS entries plus border/header regardless of list length", () => {
    const mgr = new OverlayManager();
    mgr.openResume(entries(50), () => {}, () => {});
    const rows = mgr.render(theme, 80);
    expect(rows.length).toBeLessThanOrEqual(11);
  });

  it("shows a message and no crash when there are no entries", () => {
    const mgr = new OverlayManager();
    mgr.openResume([], () => {}, () => {});
    const rows = mgr.render(theme, 80);
    expect(rows.join("\n")).toContain("No past sessions");
  });

  it("close() resets mode to none", () => {
    const mgr = new OverlayManager();
    mgr.openResume(entries(1), () => {}, () => {});
    mgr.close();
    expect(mgr.mode).toBe("none");
  });
});

describe("OverlayManager project sub-mode", () => {
  it("openProject switches mode to project", () => {
    const mgr = new OverlayManager();
    mgr.openProject(["/a", "/b"], "/a", () => {}, () => {});
    expect(mgr.mode).toBe("project");
  });

  it("Enter on a different project calls onPick", () => {
    const onPick = vi.fn();
    const mgr = new OverlayManager();
    mgr.openProject(["/a", "/b"], "/a", onPick, () => {});
    mgr.handleKey({ t: "down" });
    mgr.handleKey({ t: "enter" });
    expect(onPick).toHaveBeenCalledWith("/b");
  });

  it("Enter on the current cwd's entry cancels instead of picking", () => {
    const onPick = vi.fn();
    const onCancel = vi.fn();
    const mgr = new OverlayManager();
    mgr.openProject(["/a", "/b"], "/a", onPick, onCancel);
    mgr.handleKey({ t: "enter" });
    expect(onPick).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it("marks the current cwd entry with a bullet", () => {
    const mgr = new OverlayManager();
    mgr.openProject(["/a", "/b"], "/a", () => {}, () => {});
    const rows = mgr.render(THEMES.dark, 80);
    expect(rows.some(r => r.includes("●") && r.includes("/a"))).toBe(true);
  });

  it("shows a message when there are no recent projects", () => {
    const mgr = new OverlayManager();
    mgr.openProject([], "/a", () => {}, () => {});
    expect(mgr.render(THEMES.dark, 80).join("\n")).toContain("No recent projects");
  });
});
