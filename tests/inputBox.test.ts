import { describe, it, expect, vi } from "vitest";
import { InputBox } from "../src/ui/widgets/inputBox.js";
import { History } from "../src/agent/history.js";
import { THEMES } from "../src/ui/theme.js";
import type { CompletionContext } from "../src/commands/completion.js";
import type { Command } from "../src/commands/types.js";

const theme = THEMES.dark;

function ctx(overrides: Partial<CompletionContext> = {}): CompletionContext {
  return {
    registry: new Map<string, Command>(),
    providerNames: () => [],
    availableModels: () => [],
    listFiles: () => [],
    refreshFiles: () => {},
    ...overrides
  };
}

function type(box: InputBox, text: string): void {
  for (const ch of text) box.handleKey({ t: "printable", ch }, false);
}

describe("InputBox", () => {
  it("typing characters advances value and cursor, reflected in render()", () => {
    const box = new InputBox(ctx(), new History());
    type(box, "hi");
    const r = box.render(theme, 80, false);
    expect(r.borderRows.join("\n") + r.contentRows.join("\n")).toContain("> hi");
  });

  it("shift-enter inserts a newline instead of submitting", () => {
    const box = new InputBox(ctx(), new History());
    const onSubmit = vi.fn();
    box.onSubmit = onSubmit;
    type(box, "hi");
    box.handleKey({ t: "shift-enter" }, false);
    type(box, "there");
    const r = box.render(theme, 80, false);
    expect(r.contentRows.join("\n")).toContain("hi");
    expect(r.contentRows.join("\n")).toContain("there");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("backspace removes the character before the cursor", () => {
    const box = new InputBox(ctx(), new History());
    type(box, "hi");
    box.handleKey({ t: "backspace" }, false);
    const r = box.render(theme, 80, false);
    expect(r.contentRows.join("\n")).toContain("> h");
    expect(r.contentRows.join("\n")).not.toContain("hi");
  });

  it("Enter with empty menu submits via onSubmit and clears the value", () => {
    const box = new InputBox(ctx(), new History());
    const onSubmit = vi.fn();
    box.onSubmit = onSubmit;
    type(box, "hello");
    box.handleKey({ t: "enter" }, false);
    expect(onSubmit).toHaveBeenCalledWith("hello");
    expect(box.render(theme, 80, false).contentRows.join("\n")).toContain("> ");
    expect(box.render(theme, 80, false).contentRows.join("\n")).not.toContain("hello");
  });

  it("a trailing backslash before Enter inserts a newline instead of submitting", () => {
    const box = new InputBox(ctx(), new History());
    const onSubmit = vi.fn();
    box.onSubmit = onSubmit;
    type(box, "line1\\");
    box.handleKey({ t: "enter" }, false);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(box.render(theme, 80, false).contentRows.join("\n")).toContain("line1");
  });

  it("up-arrow with no menu open recalls the previous history entry and saves a draft", () => {
    const history = new History();
    history.add("earlier command");
    const box = new InputBox(ctx(), history);
    type(box, "draft text");
    box.handleKey({ t: "up" }, false);
    expect(box.render(theme, 80, false).contentRows.join("\n")).toContain("earlier command");
  });

  it("down-arrow past the most recent history entry restores the saved draft", () => {
    const history = new History();
    history.add("earlier command");
    const box = new InputBox(ctx(), history);
    type(box, "draft text");
    box.handleKey({ t: "up" }, false);
    box.handleKey({ t: "down" }, false);
    expect(box.render(theme, 80, false).contentRows.join("\n")).toContain("draft text");
  });

  it("up-arrow keeps navigating history even when the recalled entry matches a registered command", () => {
    const history = new History();
    history.add("/older");
    history.add("/clear");
    const box = new InputBox(ctx({ registry: registryWithClear() }), history);
    box.handleKey({ t: "up" }, false);
    expect(box.render(theme, 80, false).contentRows.join("\n")).toContain("/clear");
    // Without the fix, the single-suggestion menu that opens for "/clear" hijacks
    // the next Up press into a menu-cycle no-op instead of recalling "/older".
    box.handleKey({ t: "up" }, false);
    expect(box.render(theme, 80, false).contentRows.join("\n")).toContain("/older");
  });

  it("down-arrow keeps navigating history even when the recalled entry matches a registered command", () => {
    const history = new History();
    history.add("/older");
    history.add("/clear");
    const box = new InputBox(ctx({ registry: registryWithClear() }), history);
    box.handleKey({ t: "up" }, false);
    box.handleKey({ t: "up" }, false);
    expect(box.render(theme, 80, false).contentRows.join("\n")).toContain("/older");
    box.handleKey({ t: "down" }, false);
    expect(box.render(theme, 80, false).contentRows.join("\n")).toContain("/clear");
  });

  it("typing '@' triggers a file-cache refresh exactly once per @-token session", () => {
    const refreshFiles = vi.fn();
    const box = new InputBox(ctx({ listFiles: () => ["a.ts", "b.ts"], refreshFiles }), new History());
    type(box, "@a");
    expect(refreshFiles).toHaveBeenCalledTimes(1);
    type(box, "b");
    expect(refreshFiles).toHaveBeenCalledTimes(1);
  });

  function registryWithClear(): Map<string, Command> {
    const registry = new Map<string, Command>();
    registry.set("clear", { name: "clear", description: "Clear", run: async () => {} });
    return registry;
  }

  it("suggestion menu opens on '/' and reports rows via render().menuRows", () => {
    const box = new InputBox(ctx({ registry: registryWithClear() }), new History());
    type(box, "/");
    const r = box.render(theme, 80, false);
    expect(r.menuRows.length).toBeGreaterThan(0);
  });

  it("Escape suppresses an open menu until the value changes again", () => {
    const box = new InputBox(ctx({ registry: registryWithClear() }), new History());
    type(box, "/");
    expect(box.render(theme, 80, false).menuRows.length).toBeGreaterThan(0);
    box.handleKey({ t: "esc" }, false);
    expect(box.render(theme, 80, false).menuRows.length).toBe(0);
  });

  it("render() shows the working hint and no cursor glyph while disabled", () => {
    const box = new InputBox(ctx(), new History());
    const r = box.render(theme, 80, true);
    expect(r.hintRow).toContain("working… (Esc to interrupt)");
  });

  it("handleKey is a no-op while disabled", () => {
    const box = new InputBox(ctx(), new History());
    box.handleKey({ t: "printable", ch: "x" }, true);
    expect(box.render(theme, 80, true).contentRows.join("\n")).not.toContain("x");
  });

  it("handlePaste inserts the pasted text at the cursor without submitting", () => {
    const box = new InputBox(ctx(), new History());
    type(box, "ab");
    box.handlePaste("PASTED", false);
    expect(box.render(theme, 80, false).contentRows.join("\n")).toContain("abPASTED");
  });

  it("a multi-line paste with LF inserts newlines literally instead of submitting", () => {
    const box = new InputBox(ctx(), new History());
    const onSubmit = vi.fn();
    box.onSubmit = onSubmit;
    box.handlePaste("line1\nline2\nline3", false);
    expect(onSubmit).not.toHaveBeenCalled();
    const content = box.render(theme, 80, false).contentRows.join("\n");
    expect(content).toContain("line1");
    expect(content).toContain("line2");
    expect(content).toContain("line3");
  });

  it("a multi-line paste with CRLF normalizes to single newlines and does not submit", () => {
    const box = new InputBox(ctx(), new History());
    const onSubmit = vi.fn();
    box.onSubmit = onSubmit;
    box.handlePaste("a\r\nb", false);
    expect(onSubmit).not.toHaveBeenCalled();
    // Exactly one newline between a and b: pressing Enter now submits "a\nb".
    box.handleKey({ t: "enter" }, false);
    expect(onSubmit).toHaveBeenCalledWith("a\nb");
  });

  it("a paste ending with a newline keeps it as text, still requiring Enter to submit", () => {
    const box = new InputBox(ctx(), new History());
    const onSubmit = vi.fn();
    box.onSubmit = onSubmit;
    box.handlePaste("hello\n", false);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
