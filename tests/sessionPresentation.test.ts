import { describe, expect, it } from "vitest";
import { SessionPresentation } from "../src/ui/sessionPresentation.js";

describe("SessionPresentation", () => {
  it("owns provider model and context labels", () => {
    const presentation = new SessionPresentation({ local: { model: "qwen", model_context_window: 32_768 } });
    expect(presentation.modelFor("local")).toBe("qwen");
    expect(presentation.contextWindowFor("local")).toBe(32_768);
    expect(presentation.contextWindowFor("missing")).toBe(200_000);
  });
});
