import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("completion dropdown shell", () => {
  it("clears the stale command list when entering argument mode", () => {
    // Typing "/config" exactly normalizes to "/config " and asks the backend
    // for args; the stale "/config" self-suggestion must be dropped now,
    // not left flashing until the slower backend answers.
    const pane = readFileSync("src/desktop/renderer/chatPane.tsx", "utf8");
    const argsBlock = pane.slice(pane.indexOf('completionSource.current === "commands"'));
    expect(argsBlock).toContain("showCompletions([])");
    expect(pane).toContain("data-title={completionTitle}");
  });
  it("renders the header from state and keeps Thinking clear of the list", () => {
    const css = readFileSync("src/desktop/renderer/style.css", "utf8");
    expect(css).toContain("content: attr(data-title)");
    expect(css).toContain(".chat-pane.has-complete .chat-busy-floating");
  });
  it("caps the list at header plus five rows, then scrolls", () => {
    // Grows with the option count up to five rows; longer subcommand lists
    // scroll inside the box instead of stretching it. flex-shrink: 0 keeps
    // a long transcript from squishing the box below its content height
    // (the squished one-row shell with a scrollbar from the bug report).
    const css = readFileSync("src/desktop/renderer/style.css", "utf8");
    expect(css).toContain("max-height: 208px");
    expect(css).toContain("overflow-y: auto");
    expect(css).toContain("flex-shrink: 0");
  });
  it("never rewrites the composer on pure echo so incomplete commands stay editable", () => {
    // "/config provider" answers with a pure echo (["provider"]); auto-appending
    // a space via onChange(`${current} `) undoes a manual Backspace of that same
    // space on the next backend roundtrip, trapping the composer (only Enter
    // still does anything). The echo must only hide the dropdown instead.
    const pane = readFileSync("src/desktop/renderer/chatPane.tsx", "utf8");
    expect(pane).not.toContain("onChange(`${current} `");
    expect(pane).not.toContain("nestedOnce");
  });
  it("never normalizes the composer text for exact commands (stays cancellable)", () => {
    // The sync `setInput(kind.prefix)` for "/config" -> "/config " rewrites a
    // manual Backspace synchronously, trapping the composer. Argument options
    // must load without touching the visible text.
    const pane = readFileSync("src/desktop/renderer/chatPane.tsx", "utf8");
    expect(pane).not.toContain("setInput(kind.prefix)");
  });
  it("keeps the highlighted completion visible while navigating past the row cap", () => {
    // The dropdown caps at header + ~5 rows with overflow-y: auto. Moving the
    // highlight past the visible rows must scroll the active button into view,
    // otherwise the selection looks like it fell back into the input area.
    const pane = readFileSync("src/desktop/renderer/chatPane.tsx", "utf8");
    expect(pane).toContain("slash-complete");
    expect(pane).toContain("scrollIntoView");
  });
  it("parks focus back in the composer after send and abort", () => {
    // Send/Stop are mouse targets; without refocus the key handlers on the
    // textarea (Up/Down history, Enter to send) go dead after clicking.
    const pane = readFileSync("src/desktop/renderer/chatPane.tsx", "utf8");
    const sendBlock = pane.slice(pane.indexOf("function send()"), pane.indexOf("function abort("));
    expect(sendBlock).toContain("inputRef.current?.focus()");
    const abortBlock = pane.slice(pane.indexOf("function abort("), pane.indexOf("function respond("));
    expect(abortBlock).toContain("inputRef.current?.focus()");
  });
});
