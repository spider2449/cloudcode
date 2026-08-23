export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Media types the model can consume, with their magic-byte checks. */
const SIGNATURES: Array<{ mediaType: string; test: (b: Buffer) => boolean }> = [
  { mediaType: "image/png", test: b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mediaType: "image/jpeg", test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mediaType: "image/gif", test: b => b.subarray(0, 6).toString("latin1").startsWith("GIF8") },
  { mediaType: "image/webp", test: b => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" }
];

/** Returns the detected media type, or undefined when buf is not an image. */
export function sniffImage(buf: Buffer): string | undefined {
  return SIGNATURES.find(sig => sig.test(buf))?.mediaType;
}
