import { describe, it, expect } from "vitest";
import { captureClipboardImage } from "../src/ui/clipboard.js";

describe("captureClipboardImage", () => {
  it("reports a command failure as an error string, never throws", async () => {
    const result = await captureClipboardImage("D:/does/not/matter.png", async () => {
      throw new Error("spawn failed");
    });
    expect(result.savedPath).toBeUndefined();
    expect(result.error).toContain("spawn failed");
  });

  it("returns the target path when the runner reports success", async () => {
    const result = await captureClipboardImage("D:/tmp/x.png", async () => undefined);
    expect(result).toEqual({ savedPath: "D:/tmp/x.png" });
  });
});
