export function encodeMessage(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  return Buffer.concat([header, body]);
}

export class MessageBuffer {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
  }

  drain(): unknown[] {
    const out: unknown[] = [];
    for (;;) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const header = this.buf.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Unparseable header: drop up to the separator to avoid a stuck buffer.
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + length) break;
      const body = this.buf.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buf = this.buf.subarray(bodyStart + length);
      try {
        out.push(JSON.parse(body));
      } catch {
        // Skip a malformed body rather than throwing.
      }
    }
    return out;
  }
}
