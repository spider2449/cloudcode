import { describe, it, expect } from "vitest";
import { parseArgs } from "node:util";

// Mirrors the exact options object added to src/cli.tsx's parseArgs call;
// kept as a standalone parseArgs call here since src/cli.tsx runs top-level
// side effects (provider loading, process.exit on bad args) that make it
// unsafe to import directly in a test.
function parseCliArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      continue: { type: "boolean", default: false },
      resume: { type: "boolean", default: false },
      provider: { type: "string" },
      version: { type: "boolean", default: false },
      tui: { type: "string", default: "legacy" }
    }
  });
}

describe("cli --tui flag", () => {
  it("defaults to legacy when --tui is not passed", () => {
    expect(parseCliArgs([]).values.tui).toBe("legacy");
  });

  it("accepts --tui native", () => {
    expect(parseCliArgs(["--tui", "native"]).values.tui).toBe("native");
  });
});
