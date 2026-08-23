import { describe, it, expect } from "vitest";
import { sniffImage } from "../src/engine/tools/imageSniff.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const GIF = Buffer.from("GIF89a" + "0".repeat(20), "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(8)]);

describe("sniffImage", () => {
  it("detects png, jpeg, gif, and webp magic bytes", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(JPEG)).toBe("image/jpeg");
    expect(sniffImage(GIF)).toBe("image/gif");
    expect(sniffImage(WEBP)).toBe("image/webp");
  });
  it("returns undefined for text and unknown binaries", () => {
    expect(sniffImage(Buffer.from("hello world"))).toBeUndefined();
    expect(sniffImage(Buffer.alloc(32, 0))).toBeUndefined();
    expect(sniffImage(Buffer.alloc(0))).toBeUndefined();
  });
});
