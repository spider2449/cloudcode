import { describe, it, expect } from "vitest";
import { InputBox } from "../src/ui/widgets/inputBox.js";
import { History } from "../src/agent/history.js";
import { stringWidth } from "../src/ui/width.js";

const ctx = {
  registry: { get: () => undefined, list: () => [] },
  providerNames: () => [],
  availableModels: () => [],
  listFiles: () => []
} as never;

const theme = { muted: "gray" } as never;

describe("InputBox CJK wrapping", () => {
  it("never renders a content row wider than the terminal", () => {
    const box = new InputBox(ctx, new History());
    for (const ch of "這是一段非常長的中文輸入內容測試字串") {
      box.handleKey({ t: "printable", ch });
    }
    const r = box.render(theme, 20, false);
    for (const row of r.contentRows) {
      expect(stringWidth(row)).toBeLessThanOrEqual(16); // innerWidth = width - 4
    }
  });

  it("does not hang or throw when a wide char alone exceeds innerWidth", () => {
    const box = new InputBox(ctx, new History());
    box.handleKey({ t: "printable", ch: "中" });
    // width = 5 => innerWidth = Math.max(1, 5 - 4) = 1, narrower than the
    // 2-column-wide CJK character; there is no way to avoid an over-width
    // row here, but wrap() must still terminate and return the character.
    const r = box.render(theme, 5, false);
    expect(() => box.render(theme, 5, false)).not.toThrow();
    const joined = r.contentRows.join("");
    expect(joined).toContain("中");
  });
});
