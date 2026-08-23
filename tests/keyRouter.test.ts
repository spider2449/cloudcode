import { describe, it, expect, vi } from "vitest";
import { KeyRouter, type KeyRouterHost } from "../src/ui/keyRouter.js";
import type { Key } from "../src/ui/input.js";

function host(overrides: Partial<KeyRouterHost> = {}) {
  const calls: string[] = [];
  const base: KeyRouterHost = {
    isStreaming: () => false,
    isOverlayOpen: () => false,
    interrupt: () => { calls.push("interrupt"); },
    clearScreen: () => { calls.push("clearScreen"); },
    exit: () => { calls.push("exit"); },
    notice: text => { calls.push(`notice:${text}`); },
    cyclePermissionMode: () => { calls.push("cycleMode"); },
    handleOverlayKey: (_k, input) => { calls.push(`overlay:${input ?? ""}`); },
    handlePaste: text => { calls.push(`paste:${text}`); },
    handleInputKey: () => { calls.push("inputKey"); },
    recompute: () => { calls.push("recompute"); }
  };
  return { host: { ...base, ...overrides }, calls };
}

const esc: Key = { t: "esc" };
const ctrl = (ch: string): Key => ({ t: "ctrl", ch });

describe("KeyRouter", () => {
  it("Esc interrupts only while streaming with no overlay open", () => {
    const streaming = host({ isStreaming: () => true });
    new KeyRouter(streaming.host).handleKey(esc);
    expect(streaming.calls).toEqual(["interrupt"]);

    const idle = host();
    new KeyRouter(idle.host).handleKey(esc);
    expect(idle.calls).not.toContain("interrupt");

    // An open overlay owns Esc (it closes the overlay, not the turn).
    const overlaid = host({ isStreaming: () => true, isOverlayOpen: () => true });
    new KeyRouter(overlaid.host).handleKey(esc);
    expect(overlaid.calls).toEqual(["overlay:", "recompute"]);
  });

  it("Ctrl+L clears the screen and repaints", () => {
    const h = host();
    new KeyRouter(h.host).handleKey(ctrl("l"));
    expect(h.calls).toEqual(["clearScreen", "recompute"]);
  });

  it("first Ctrl+C interrupts and warns; a second one within the window exits", () => {
    const h = host();
    const router = new KeyRouter(h.host);
    router.handleKey(ctrl("c"));
    expect(h.calls).toEqual(["interrupt", "notice:Press Ctrl+C again to exit.", "recompute"]);
    router.handleKey(ctrl("c"));
    expect(h.calls).toContain("exit");
  });

  it("a Ctrl+C after the double-press window interrupts again instead of exiting", () => {
    vi.useFakeTimers();
    try {
      const h = host();
      const router = new KeyRouter(h.host);
      router.handleKey(ctrl("c"));
      vi.advanceTimersByTime(2001);
      router.handleKey(ctrl("c"));
      expect(h.calls).not.toContain("exit");
      expect(h.calls.filter(c => c === "interrupt")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an open overlay swallows keys that would otherwise reach the input box", () => {
    const h = host({ isOverlayOpen: () => true });
    const router = new KeyRouter(h.host);
    router.handleKey({ t: "printable", ch: "x" });
    router.handleKey({ t: "backtab" });
    expect(h.calls).toEqual(["overlay:x", "recompute", "overlay:", "recompute"]);
    expect(h.calls).not.toContain("inputKey");
    expect(h.calls).not.toContain("cycleMode");
  });

  it("routes Shift+Tab to the permission-mode cycle without repainting twice", () => {
    const h = host();
    new KeyRouter(h.host).handleKey({ t: "backtab" });
    // cyclePermissionMode repaints itself once the async mode change lands.
    expect(h.calls).toEqual(["cycleMode"]);
  });

  it("routes paste and ordinary keys to the input box", () => {
    const h = host();
    const router = new KeyRouter(h.host);
    router.handleKey({ t: "paste", text: "hello" });
    router.handleKeys([{ t: "printable", ch: "a" }, { t: "enter" }]);
    expect(h.calls).toEqual(["paste:hello", "recompute", "inputKey", "recompute", "inputKey", "recompute"]);
  });
});

describe("KeyRouter clipboard attach", () => {
  it("Ctrl+V asks the host to attach a clipboard image while idle", () => {
    let attached = 0;
    const h = host({ attachImage: () => { attached += 1; } });
    new KeyRouter(h.host).handleKey(ctrl("v"));
    expect(attached).toBe(1);
  });

  it("ignores Ctrl+V while streaming", () => {
    let attached = 0;
    const h = host({ isStreaming: () => true, attachImage: () => { attached += 1; } });
    new KeyRouter(h.host).handleKey(ctrl("v"));
    expect(attached).toBe(0);
  });
});
