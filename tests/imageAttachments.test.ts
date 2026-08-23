import { describe, it, expect } from "vitest";
import { ImageAttachments } from "../src/ui/imageAttachments.js";

function makeDeps(attachmentCount = { value: 0 }) {
  const notices: string[] = [];
  let recomputed = 0;
  return {
    attachmentCount,
    notices,
    recomputed: () => recomputed,
    deps: {
      setAttachmentCount(n: number) { attachmentCount.value = n; },
      notice: (text: string) => notices.push(text),
      recompute: () => { recomputed += 1; }
    }
  };
}

describe("ImageAttachments", () => {
  it("starts empty and takeForSend drains pending images", () => {
    const { deps } = makeDeps();
    const images = new ImageAttachments(deps);
    expect(images.count).toBe(0);
    expect(images.takeForSend()).toEqual([]);
    expect(images.count).toBe(0);
  });

  it("attaches a captured clipboard image and notifies", async () => {
    const { deps, attachmentCount } = makeDeps();
    const captures: string[] = [];
    const images = new ImageAttachments(deps, async path => {
      captures.push(path);
      return { savedPath: path };
    }, path => {
      if (path.endsWith("-0.png")) return Buffer.from("fake-png");
      throw new Error("missing");
    }, () => true);
    await images.attachFromClipboard();
    expect(captures.length).toBe(1);
    expect(images.count).toBe(1);
    expect(attachmentCount.value).toBe(1);
    expect(images.takeForSend()).toEqual([{ mediaType: "image/png", base64: Buffer.from("fake-png").toString("base64") }]);
    expect(images.count).toBe(0);
  });

  it("notices when there is no clipboard image", async () => {
    const { deps, notices } = makeDeps();
    const images = new ImageAttachments(deps, async () => ({ savedPath: undefined }));
    await images.attachFromClipboard();
    expect(notices).toEqual(["No image in clipboard."]);
    expect(images.count).toBe(0);
  });

  it("notices on read failure and stays empty", async () => {
    const { deps, notices } = makeDeps();
    const images = new ImageAttachments(deps, async p => ({ savedPath: p }), () => {
      throw new Error("boom");
    }, () => true);
    await images.attachFromClipboard();
    expect(notices[0]).toContain("Failed to attach image: boom");
    expect(images.count).toBe(0);
  });

  it("clear resets pending images and the input box count", async () => {
    const { deps, attachmentCount } = makeDeps();
    const images = new ImageAttachments(deps, async p => ({ savedPath: p }), () => Buffer.from("x"), () => true);
    await images.attachFromClipboard();
    images.clear();
    expect(images.count).toBe(0);
    expect(attachmentCount.value).toBe(0);
  });
});
