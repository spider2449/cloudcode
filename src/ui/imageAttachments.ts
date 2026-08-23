import { captureClipboardImage } from "./clipboard.js";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PendingImage {
  mediaType: string;
  base64: string;
}

export interface ImageAttachmentsDeps {
  setAttachmentCount(count: number): void;
  notice(text: string): void;
  recompute(): void;
}

type ClipboardCapture = (targetPath: string) => Promise<{ savedPath?: string }>;
type FileReader = (path: string) => Buffer;
type PathExists = (path: string) => boolean;

/** Owns the session's pending clipboard image attachments: capture to a temp
 * file, snapshot into base64, drain on send, clear on Esc. */
export class ImageAttachments {
  private pending: PendingImage[] = [];
  private seq = 0;

  constructor(
    private deps: ImageAttachmentsDeps,
    private capture: ClipboardCapture = captureClipboardImage,
    private readFile: FileReader = readFileSync,
    private exists: PathExists = existsSync
  ) {}

  get count(): number {
    return this.pending.length;
  }

  /** Ctrl+V: snapshot the clipboard image into the pending attachments. */
  attachFromClipboard(): void {
    const targetPath = join(tmpdir(), `cloudcode-clipboard-${Date.now()}-${this.seq++}.png`);
    void this.capture(targetPath).then(result => {
      if (!result.savedPath || !this.exists(result.savedPath)) {
        this.deps.notice("No image in clipboard.");
        return;
      }
      try {
        const buf = this.readFile(result.savedPath);
        this.pending.push({ mediaType: "image/png", base64: buf.toString("base64") });
        this.deps.setAttachmentCount(this.pending.length);
        this.deps.notice(`[image ${this.pending.length} attached]`);
        this.deps.recompute();
      } catch (err) {
        this.deps.notice(`Failed to attach image: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  /** Drains the pending attachments for an outgoing message and resets the
   * input box's visible attachment count. */
  takeForSend(): PendingImage[] {
    const images = this.pending;
    this.pending = [];
    if (images.length > 0) this.deps.setAttachmentCount(0);
    return images;
  }

  clear(): void {
    this.pending = [];
    this.deps.setAttachmentCount(0);
  }
}
