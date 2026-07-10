import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { History } from "../src/agent/history.js";

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "cc-")), "history.json");
}

describe("History", () => {
  it("navigates back and forward", () => {
    const h = new History(tempFile());
    h.add("first");
    h.add("second");
    expect(h.back()).toBe("second");
    expect(h.back()).toBe("first");
    expect(h.back()).toBe("first");        // stays at oldest
    expect(h.forward()).toBe("second");
    expect(h.forward()).toBeUndefined();   // past newest -> leave history
  });

  it("persists across instances and caps at 100", () => {
    const file = tempFile();
    const a = new History(file);
    for (let i = 0; i < 150; i++) a.add(`cmd${i}`);
    const b = new History(file);
    expect(b.back()).toBe("cmd149");
    let count = 1;
    while (b.back() !== "cmd50") count++;
    expect(count).toBe(100);
  });

  it("dedupes consecutive duplicates", () => {
    const h = new History(tempFile());
    h.add("same");
    h.add("same");
    expect(h.back()).toBe("same");
    expect(h.back()).toBe("same"); // only one entry; stays at oldest
    expect(h.forward()).toBeUndefined();
  });

  it("tolerates a corrupt file", () => {
    const file = tempFile();
    writeFileSync(file, "{nope");
    const h = new History(file);
    expect(h.back()).toBeUndefined();
  });
});
