import { StringDecoder } from "node:string_decoder";

export type Key =
  | { t: "printable"; ch: string }
  | { t: "paste"; text: string }
  | { t: "enter" }
  | { t: "tab" }
  | { t: "backtab" }
  | { t: "backspace" }
  | { t: "delete" }
  | { t: "esc" }
  | { t: "up" }
  | { t: "down" }
  | { t: "left" }
  | { t: "right" }
  | { t: "home" }
  | { t: "end" }
  | { t: "pgup" }
  | { t: "pgdn" }
  | { t: "ctrl"; ch: string }
  | { t: "alt"; ch: string }
  | { t: "wheel"; dir: "up" | "down" };

// SGR mouse report: ESC [ < button ; col ; row (M|m). Only wheel buttons
// (64/65) become keys; presses/releases/motion are consumed and dropped.
const SGR_MOUSE_RE = /^\x1b\[<(\d+);\d+;\d+[Mm]/;

// Any complete CSI sequence we don't otherwise recognize (e.g. focus-in/out
// reports, modified arrows like Ctrl+Up). Matched so it can be discarded
// wholesale instead of leaving `tryConsumeOne` stuck re-scanning it forever.
const UNKNOWN_CSI_RE = /^\x1b\[[0-9;?]*[A-Za-z~]/;

const SEQUENCES: Record<string, Key> = {
  "\x1b[Z": { t: "backtab" },
  "\x1b[3~": { t: "delete" },
  "\x1b[A": { t: "up" }, "\x1bOA": { t: "up" },
  "\x1b[B": { t: "down" }, "\x1bOB": { t: "down" },
  "\x1b[C": { t: "right" }, "\x1bOC": { t: "right" },
  "\x1b[D": { t: "left" }, "\x1bOD": { t: "left" },
  "\x1b[H": { t: "home" }, "\x1b[1~": { t: "home" }, "\x1bOH": { t: "home" },
  "\x1b[F": { t: "end" }, "\x1b[4~": { t: "end" }, "\x1bOF": { t: "end" },
  "\x1b[5~": { t: "pgup" },
  "\x1b[6~": { t: "pgdn" }
};

const ESC_TIMEOUT_MS = 25;

export class KeyDecoder {
  private pending = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  // Escape sequences are pure ASCII, so decoding as UTF-8 leaves them intact
  // while correctly assembling multi-byte characters (e.g. Chinese IME input).
  // StringDecoder buffers a trailing incomplete multi-byte sequence across
  // feed() calls instead of emitting a replacement character for it.
  private utf8 = new StringDecoder("utf8");
  /** Test/production hook: called with keys resolved by the 25ms Escape timeout. */
  onTimeout: ((keys: Key[]) => void) | undefined;

  feed(chunk: Buffer): Key[] {
    this.clearTimer();
    this.pending += this.utf8.write(chunk);
    return this.drain();
  }

  private clearTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
  }

  private drain(): Key[] {
    const keys: Key[] = [];
    while (this.pending.length > 0) {
      const consumed = this.tryConsumeOne(keys);
      if (consumed === 0) break;
      this.pending = this.pending.slice(consumed);
    }
    if (this.pending === "\x1b") {
      this.timer = setTimeout(() => {
        this.pending = "";
        this.onTimeout?.([{ t: "esc" }]);
      }, ESC_TIMEOUT_MS);
    }
    return keys;
  }

  private tryConsumeOne(keys: Key[]): number {
    const s = this.pending;

    if (s.startsWith("\x1b[200~")) {
      const end = s.indexOf("\x1b[201~");
      if (end === -1) return 0; // wait for the rest of the paste
      keys.push({ t: "paste", text: s.slice(6, end) });
      return end + 6;
    }

    const mouse = SGR_MOUSE_RE.exec(s);
    if (mouse) {
      const button = Number(mouse[1]);
      if (button === 64) keys.push({ t: "wheel", dir: "up" });
      else if (button === 65) keys.push({ t: "wheel", dir: "down" });
      return mouse[0].length;
    }
    if (s.startsWith("\x1b[<")) return 0; // incomplete mouse sequence

    for (const [seq, key] of Object.entries(SEQUENCES)) {
      if (s.startsWith(seq)) { keys.push(key); return seq.length; }
    }

    if (s === "\x1b") return 0; // incomplete: could be Esc alone or a sequence prefix

    const unknownCsi = UNKNOWN_CSI_RE.exec(s);
    if (unknownCsi) return unknownCsi[0].length; // recognized as CSI, but not a key we act on: discard

    if (s.startsWith("\x1b[") || s.startsWith("\x1bO")) return 0; // incomplete escape sequence

    if (s.startsWith("\x1b") && s.length >= 2) {
      keys.push({ t: "alt", ch: s[1] });
      return 2;
    }

    const ch = s[0];
    if (ch === "\r" || ch === "\n") { keys.push({ t: "enter" }); return 1; }
    if (ch === "\t") { keys.push({ t: "tab" }); return 1; }
    if (ch === "\x7f") { keys.push({ t: "backspace" }); return 1; }
    const code = ch.charCodeAt(0);
    if (code >= 0x01 && code <= 0x1a) {
      keys.push({ t: "ctrl", ch: String.fromCharCode(code + 96) });
      return 1;
    }
    keys.push({ t: "printable", ch });
    return 1;
  }
}
