import { describe, expect, it } from "vitest";
import { imeAnchor } from "../desktop/renderer/imePosition.js";

describe("imeAnchor", () => {
  it("positions the helper textarea at the visible cursor cell", () => {
    expect(imeAnchor(6, 18, 10, 80, 24, 800, 480)).toEqual({
      left: 60,
      top: 160,
      height: 20
    });
  });

  it("clamps stale cursor coordinates to the terminal viewport", () => {
    expect(imeAnchor(100, 4, 10, 80, 24, 800, 480)).toEqual({
      left: 790,
      top: 0,
      height: 20
    });
  });
});
