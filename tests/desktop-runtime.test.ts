import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveNodeExecutable } from "../src/desktop/runtime.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("desktop runtime", () => {
  it("finds node on a POSIX PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "cloudcode-runtime-")); roots.push(root);
    const node = join(root, "node"); writeFileSync(node, ""); chmodSync(node, 0o755);
    expect(resolveNodeExecutable({ platform: "linux", execPath: "/missing/electron", env: { PATH: root } })).toBe(node);
  });

  it("prefers an explicitly configured executable", () => {
    expect(resolveNodeExecutable({ platform: process.platform, execPath: process.execPath, env: { CLOUDCODE_NODE_EXECUTABLE: process.execPath } })).toBe(process.execPath);
  });
});
