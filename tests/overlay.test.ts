import { describe, it, expect, vi } from "vitest";
import { OverlayManager } from "../src/ui/widgets/overlay.js";
import { THEMES } from "../src/ui/theme.js";
import type { SessionEntry } from "../src/agent/sessionIndex.js";
import { STATUS_LINE_ITEMS } from "../src/statusLineItems.js";

const theme = THEMES.dark;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\[7m|\x1b\[27m/g, "");

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
  const otherRequest = { toolName: "SomeOtherTool", input: {} };
  const webFetchRequest = { toolName: "WebFetch", input: { url: "https://example.com/docs" } };

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

  it("offers Always/Never for a Grep request, whose rule is keyed on its search path", () => {
    const onDecision = vi.fn();
    const mgr = new OverlayManager();
    mgr.openPermission({ toolName: "Grep", input: { pattern: "x", path: "/logs" } } as never, onDecision);
    expect(mgr.render(THEMES.dark, 80).join("\n")).toContain("Always for this directory");
    mgr.handleKey({ t: "printable", ch: "a" }, "a");
    expect(onDecision).toHaveBeenCalledWith(true, "allow");
  });

  it("does not offer Always/Never for a path input no rule would be checked against", () => {
    const mgr = new OverlayManager();
    // Not a search tool: a remembered directory rule would never be consulted.
    mgr.openPermission({ toolName: "WebFetch", input: { path: "/v1/users" } } as never, () => {});
    expect(mgr.render(THEMES.dark, 80).join("\n")).not.toContain("Always for this directory");
  });

  it("offers Always/Never allow '<prefix>' commands for Bash requests", () => {
    const mgr = new OverlayManager();
    mgr.openPermission(bashRequest as never, () => {});
    const joined = mgr.render(THEMES.dark, 80).join("\n");
    expect(joined).toContain("Always allow 'ls' commands");
    expect(joined).toContain("Never allow 'ls' commands");
  });

  it("offers Always/Never allow '<host>' for WebFetch requests", () => {
    const onDecision = vi.fn();
    const mgr = new OverlayManager();
    mgr.openPermission(webFetchRequest as never, onDecision);
    const joined = mgr.render(THEMES.dark, 80).join("\n");
    expect(joined).toContain("Always allow example.com");
    expect(joined).toContain("Never allow example.com");
    mgr.handleKey({ t: "printable", ch: "a" }, "a");
    expect(onDecision).toHaveBeenCalledWith(true, "allow");
  });

  it("offers plain Yes/No when the WebFetch url is unusable for host scoping", () => {
    const mgr = new OverlayManager();
    mgr.openPermission({ toolName: "WebFetch", input: { url: "garbage" } } as never, () => {});
    const joined = mgr.render(THEMES.dark, 80).join("\n");
    expect(joined).not.toContain("Always allow");
    expect(joined).not.toContain("Always for this directory");
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

describe("OverlayManager trust sub-mode", () => {
  it("defaults to denial and sanitizes untrusted command text", () => {
    const onDecision = vi.fn();
    const mgr = new OverlayManager();
    mgr.openTrust("/repo", ["node evil.js\x1b[2J"], onDecision);
    expect(mgr.render(theme, 80).join("\n")).not.toContain("\x1b[2J");
    mgr.handleKey({ t: "enter" });
    expect(onDecision).toHaveBeenCalledWith(false);
  });

  it("accepts the explicit y hotkey", () => {
    const onDecision = vi.fn();
    const mgr = new OverlayManager();
    mgr.openTrust("/repo", ["node server.js"], onDecision);
    mgr.handleKey({ t: "printable", ch: "y" }, "y");
    expect(onDecision).toHaveBeenCalledWith(true);
    expect(mgr.mode).toBe("none");
  });
});

describe("OverlayManager statusline sub-mode", () => {
  const items = [...STATUS_LINE_ITEMS];

  it("opens, lists items, and reports the mode", () => {
    const mgr = new OverlayManager();
    mgr.openStatusLine(items, () => {}, () => {});
    expect(mgr.mode).toBe("statusline");
    expect(mgr.isOpen).toBe(true);
    const rows = mgr.render(theme, 100).map(strip);
    // Only MAX_ROWS fit at once; the first window shows the head of the list.
    expect(rows.some(r => r.includes("Provider / model"))).toBe(true);
    expect(rows.some(r => r.includes("Served model override"))).toBe(true);
  });

  it("enter/space toggles and fires onToggle with canonical-order list", () => {
    const toggles: string[][] = [];
    const mgr = new OverlayManager();
    mgr.openStatusLine(["model", "mode"], next => toggles.push(next), () => {});
    mgr.handleKey({ t: "down" }); // cursor onto servedModel
    mgr.handleKey({ t: "enter" }); // enable servedModel
    expect(toggles).toHaveLength(1);
    expect(toggles[0]).toContain("servedModel");
    expect(toggles[0].indexOf("model")).toBeLessThan(toggles[0].indexOf("servedModel"));
    mgr.handleKey({ t: "printable", ch: " " }, " "); // space disables it again
    expect(toggles).toHaveLength(2);
    expect(toggles[1]).not.toContain("servedModel");
    expect(mgr.mode).toBe("statusline"); // stays open while toggling
  });

  it("esc closes and fires onCancel without toggling", () => {
    const onToggle = vi.fn();
    const onCancel = vi.fn();
    const mgr = new OverlayManager();
    mgr.openStatusLine(items, onToggle, onCancel);
    mgr.handleKey({ t: "esc" });
    expect(mgr.mode).toBe("none");
    expect(onToggle).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it("renders checked markers for enabled items only", () => {
    const mgr = new OverlayManager();
    mgr.openStatusLine(["model", "cost"], () => {}, () => {});
    const rows = mgr.render(theme, 100).map(strip);
    expect(rows.some(r => r.includes("[x]") && r.includes("Session cost"))).toBe(true);
    expect(rows.some(r => r.includes("[ ]") && r.includes("Permission mode"))).toBe(true);
    expect(rows.some(r => r.includes("[x]") && r.includes("Permission mode"))).toBe(false);
  });
});
