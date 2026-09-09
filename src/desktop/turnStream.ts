import { TURN_BUSY_MARKER, TURN_IDLE_MARKER } from "../ui/turnSignal.js";

/** Stateful PTY-side companion to src/ui/turnSignal.ts.
 *
 * The embedded TUI writes turn-state OSC markers into its stdout. PTY data
 * arrives in arbitrary chunks, so a marker can be split across two onData
 * callbacks; a per-chunk `includes` check would miss it and the busy flag
 * would stick. This class holds back a trailing partial-marker prefix for
 * the next chunk, strips complete markers from visible output, and tracks
 * the current turn state. Used by desktop/main.mjs (via dist/).
 */
export class TurnStream {
  private carry = "";
  private busyState = false;

  get busy(): boolean {
    return this.busyState;
  }

  /** Feed one PTY chunk; returns the visible text with markers removed. */
  push(chunk: string): string {
    let scan = this.carry + chunk;
    this.carry = "";
    // Hold back a trailing partial marker so a split marker still resolves
    // when the next chunk arrives. At most a few dozen bytes are delayed by
    // one chunk, which is invisible at terminal drain rates.
    const maxHold = Math.max(TURN_BUSY_MARKER.length, TURN_IDLE_MARKER.length) - 1;
    for (let len = Math.min(scan.length, maxHold); len > 0; len--) {
      const tail = scan.slice(-len);
      if (tail === TURN_BUSY_MARKER || tail === TURN_IDLE_MARKER) break;
      if (TURN_BUSY_MARKER.startsWith(tail) || TURN_IDLE_MARKER.startsWith(tail)) {
        this.carry = tail;
        scan = scan.slice(0, -len);
        break;
      }
    }
    const lastBusy = scan.lastIndexOf(TURN_BUSY_MARKER);
    const lastIdle = scan.lastIndexOf(TURN_IDLE_MARKER);
    if (lastBusy !== -1 || lastIdle !== -1) this.busyState = lastBusy > lastIdle;
    return scan.split(TURN_BUSY_MARKER).join("").split(TURN_IDLE_MARKER).join("");
  }

  /** Forget held bytes and return to idle (session switch / shutdown). */
  reset(): void {
    this.carry = "";
    this.busyState = false;
  }
}
