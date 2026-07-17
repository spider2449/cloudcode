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

describe("OverlayManager permission sub-mode", () => {
  const fileRequest = { toolName: "Edit", input: { file_path: "/a/b.ts" } };
  const bashRequest = { toolName: "Bash", input: { command: "ls" } };
  const otherRequest = { toolName: "WebFetch", input: { url: "https://example.com" } };

  it("hotkey 'y' allows without remembering", () => {
    const onDecision = vi.fn();
    const mgr = new OverlayManager();
    mgr.openPermission(fileRequest as never, onDecision);
    mgr.handleKey({ t: "printable", ch: "y" }, "y");
    expect(onDecision).toHaveBeenCalledWith(true, undefined);
  });

  it("hotkey 'a' allows and remembers 'allow' (file-path requests only)", () => {
    const onDecision = vi.fn();
    const mgr = new OverlayManager();
    mgr.openPermission(fileRequest as never, onDecision);
    mgr.handleKey({ t: "printable", ch: "a" }, "a");
    expect(onDecision).toHaveBeenCalledWith(true, "allow");
  });

  it("hotkey 'd' denies and remembers 'deny'", () => {
    const onDecision = vi.fn();
    const mgr = new OverlayManager();
    mgr.openPermission(fileRequest as never, onDecision);
    mgr.handleKey({ t: "printable", ch: "d" }, "d");
    expect(onDecision).toHaveBeenCalledWith(false, "deny");
  });

  it("Escape denies without remembering", () => {
    const onDecision = vi.fn();
    const mgr = new OverlayManager();
    mgr.openPermission(fileRequest as never, onDecision);
    mgr.handleKey({ t: "esc" });
    expect(onDecision).toHaveBeenCalledWith(false);
  });

  it("a non-file-path request only offers Yes/No, not Always/Never", () => {
    const mgr = new OverlayManager();
    mgr.openPermission(otherRequest as never, () => {});
    const rows = mgr.render(THEMES.dark, 80);
    const joined = rows.join("\n");
    expect(joined).not.toContain("Always for this directory");
  });

  it("offers Always/Never allow '<prefix>' commands for Bash requests", () => {
    const mgr = new OverlayManager();
    mgr.openPermission(bashRequest as never, () => {});
    const joined = mgr.render(THEMES.dark, 80).join("\n");
    expect(joined).toContain("Always allow 'ls' commands");
    expect(joined).toContain("Never allow 'ls' commands");
  });

  it("arrow navigation plus Enter selects the currently highlighted option", () => {
    const onDecision = vi.fn();
    const mgr = new OverlayManager();
    mgr.openPermission(otherRequest as never, onDecision);
    mgr.handleKey({ t: "right" });
    mgr.handleKey({ t: "enter" });
    expect(onDecision).toHaveBeenCalledWith(false, undefined);
  });

  it("renders the tool label from transcript.toolLabel", () => {
    const mgr = new OverlayManager();
    mgr.openPermission(fileRequest as never, () => {});
    const rows = mgr.render(THEMES.dark, 80);
    expect(rows.join("\n")).toContain("Edit /a/b.ts");
  });
});

describe("OverlayManager memory sub-mode", () => {
  const options = [
    { label: "User memory", path: "/home/.cloudcode/CLAUDE.md", kind: "file" as const },
    { label: "Project memory (new)", path: "/repo/CLAUDE.md", kind: "file" as const },
    { label: "Open auto-memory folder", path: "/home/.cloudcode/projects/repo/memory", kind: "folder" as const }
  ];

  it("openMemory switches mode to memory and isOpen becomes true", () => {
    const mgr = new OverlayManager();
    mgr.openMemory(options, () => {}, () => {});
    expect(mgr.mode).toBe("memory");
    expect(mgr.isOpen).toBe(true);
  });

  it("renders all option labels", () => {
    const mgr = new OverlayManager();
    mgr.openMemory(options, () => {}, () => {});
    const rendered = mgr.render(theme, 80).join("\n");
    expect(rendered).toContain("User memory");
    expect(rendered).toContain("Project memory (new)");
    expect(rendered).toContain("Open auto-memory folder");
  });

  it("Enter picks the currently highlighted option and closes the overlay", () => {
    const onPick = vi.fn();
    const mgr = new OverlayManager();
    mgr.openMemory(options, onPick, () => {});
    mgr.handleKey({ t: "down" });
    mgr.handleKey({ t: "enter" });
    expect(onPick).toHaveBeenCalledWith(options[1]);
    expect(mgr.mode).toBe("none");
  });

  it("Esc cancels without picking", () => {
    const onPick = vi.fn();
    const onCancel = vi.fn();
    const mgr = new OverlayManager();
    mgr.openMemory(options, onPick, onCancel);
    mgr.handleKey({ t: "esc" });
    expect(onPick).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
    expect(mgr.mode).toBe("none");
  });

  it("down arrow does not move past the last option", () => {
    const onPick = vi.fn();
    const mgr = new OverlayManager();
    mgr.openMemory(options, onPick, () => {});
    mgr.handleKey({ t: "down" });
    mgr.handleKey({ t: "down" });
    mgr.handleKey({ t: "down" });
    mgr.handleKey({ t: "enter" });
    expect(onPick).toHaveBeenCalledWith(options[2]);
  });
});
