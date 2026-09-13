import { useEffect } from "react";
import { confirmGuiTheme, loadStoredGuiTheme } from "./themeState.js";

export type Completion = { label: string; value: string; replaceStart: number; replaceEnd: number };

export type SlashInputKind =
  | { kind: "plain" }
  | { kind: "command"; token: string }
  | { kind: "args"; prefix: string };
// Pure splice behind every dropdown pick (mirrors applySuggestion in
// src/commands/completion.ts): only the option's own token range is replaced.
export function applySuggestionText(
  input: string,
  s: { value: string; replaceStart: number; replaceEnd: number }
): string {
  return input.slice(0, s.replaceStart) + s.value + input.slice(s.replaceEnd);
}

// Pure decision of what the dropdown should show for an input value.
// Spaceless inputs (including exactly-typed "/config") complete command
// names like the terminal does; argument options only load after the user
// types the space themselves. Auto-jumping to args rewrites the composer
// and traps Backspace/cancel, so it stays a manual descent (Space/Tab).
export function describeSlashInput(value: string): SlashInputKind {
  if (!value.startsWith("/")) return { kind: "plain" };
  if (!value.includes(" ")) {
    return { kind: "command", token: value };
  }
  return { kind: "args", prefix: value };
}

// Drops backend completion rows that would render as blank buttons (empty
// label/value) under the dropdown header. An empty result hides the dropdown
// instead of leaving an empty bordered "Commands" shell on screen.
export function visibleCompletions(items: Completion[]): Completion[] {
  return items.filter(item => item.label.trim() !== "" && item.value !== "");
}

// Header for the dropdown: command-name lists keep the generic "Commands",
// while backend argument options are titled with the command they belong to
// ("/config " -> "/config") so the header never mislabels option rows.
export function titleForCompletionPrefix(prefix: string): string {
  if (!prefix.startsWith("/")) return "Commands";
  const token = prefix.split(/\s+/, 1)[0] ?? "";
  if (token === "" || token === "/") return "Commands";
  return prefix.length > token.length ? token : "Commands";
}

// True when the backend asks the shell to start a fresh anonymous session
// (GUI /new and /clear emit this; the shell handles it like the New Session button).
export function isNewSessionEvent(event: { type: string }): boolean {
  return event.type === "new_session";
}

// Extracts the backend session id from a "session_id" event so the shell can
// adopt an anonymous conversation once it has content. Anything else yields
// undefined instead of throwing on malformed payloads.
export function parseSessionIdEvent(event: { type: string; sessionId?: unknown }): string | undefined {
  if (event.type !== "session_id") return undefined;
  return typeof event.sessionId === "string" && event.sessionId !== "" ? event.sessionId : undefined;
}

// Re-apply the stored GUI theme on launch so a /theme choice survives
// reloads without waiting for the next theme event.
export function useStoredGuiTheme(): void {
  useEffect(() => {
    const stored = loadStoredGuiTheme();
    if (stored) confirmGuiTheme(stored);
  }, []);
}

// Distance (px) from the bottom within which the transcript still counts
// as "at the bottom" for scroll-following purposes.
export const STICK_THRESHOLD_PX = 40;

// Pure stickiness decision behind the transcript auto-scroll: follow new
// messages only while the user is already near the bottom, so reading
// history never gets yanked away by an incoming delta.
export function shouldStickToBottom(scrollHeight: number, scrollTop: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight < STICK_THRESHOLD_PX;
}

// Whether a turn-scoped stream event belongs to the conversation on screen.
// Background sessions keep running after a switch; their late deltas must
// not pollute the transcript being viewed. History replay uses history-*
// ids and always applies.
export function isLiveTurnEvent(id: string, pendingIds: readonly string[]): boolean {
  return id.startsWith("history-") || pendingIds.includes(id);
}

// Slash commands execute backend-side and report via notice/error events,
// so echoing them as user bubbles doubles the transcript. Plain prompts
// still echo (they have no other visible record until the turn streams).
export function echoUserBubble(text: string): boolean {
  return !text.startsWith("/");
}

// Text status for an in-flight LLM turn. Null means idle (hide the label).
// The animated dots are a separate CSS span so this stays a pure function
// that node-based unit tests can import (same pattern as lastSelection.ts).
export function busyLabel(pendingCount: number): string | null {
  return pendingCount > 0 ? "Thinking" : null;
}
