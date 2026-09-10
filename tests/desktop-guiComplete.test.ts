import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "../src/agent/providers.js";
import { suggestCompletions } from "../src/desktop/guiComplete.js";

const deps = {
  cwd: mkdtempSync(join(tmpdir(), "gui-complete-")),
  providers: { alpha: { model: "a-model" } } as unknown as Record<string, ProviderConfig>,
  availableModels: ["a-model", "a-other"]
};

describe("gui completion parity with the terminal input", () => {
  it("suggests argument values for commands (reported case: /theme github)", () => {
    const labels = suggestCompletions("/theme ", deps).map(s => s.label);
    expect(labels).toContain("github");
  });
  it("filters argument values by the typed prefix", () => {
    const labels = suggestCompletions("/theme gi", deps).map(s => s.label);
    expect(labels).toContain("github");
    expect(labels).not.toContain("dark");
  });
  it("suggests command names with the prefix preserved", () => {
    const found = suggestCompletions("/the", deps);
    expect(found.map(s => s.label)).toContain("/theme");
    const theme = found.find(s => s.label === "/theme");
    expect(theme?.value).toBe("/theme ");
  });
  it("returns nothing for plain prompts and unknown commands", () => {
    expect(suggestCompletions("github", deps)).toEqual([]);
    expect(suggestCompletions("/nope ", deps)).toEqual([]);
    expect(suggestCompletions("", deps)).toEqual([]);
  });
});
