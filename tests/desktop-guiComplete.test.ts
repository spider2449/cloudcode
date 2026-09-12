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
  it("suggests argument values for commands (theme switching lives in the menu bar, so /model stands in)", () => {
    const labels = suggestCompletions("/model ", deps).map(s => s.label);
    expect(labels).toContain("a-model");
    expect(labels).toContain("a-other");
  });
  it("filters argument values by the typed prefix", () => {
    const labels = suggestCompletions("/model a-o", deps).map(s => s.label);
    expect(labels).toContain("a-other");
    expect(labels).not.toContain("a-model");
  });
  it("suggests command names with the prefix preserved", () => {
    const found = suggestCompletions("/mod", deps);
    expect(found.map(s => s.label)).toContain("/model");
    const model = found.find(s => s.label === "/model");
    expect(model?.value).toBe("/model ");
  });
  it("offers no /theme in the input: switching lives in the menu bar", () => {
    expect(suggestCompletions("/the", deps).map(s => s.label)).not.toContain("/theme");
    expect(suggestCompletions("/theme ", deps)).toEqual([]);
  });
  it("returns nothing for plain prompts and unknown commands", () => {
    expect(suggestCompletions("github", deps)).toEqual([]);
    expect(suggestCompletions("/nope ", deps)).toEqual([]);
    expect(suggestCompletions("", deps)).toEqual([]);
  });
});
