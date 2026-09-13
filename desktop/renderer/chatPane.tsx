import { useEffect, useRef, useState } from "react";
import { buildRegistry } from "../../src/commands/builtins.js";
import { confirmGuiTheme, loadStoredGuiTheme, parseThemeEvent } from "./themeState.js";
import {
  emptyHistoryNav,
  loadInputHistoryEntries,
  pushInputHistoryEntry,
  recallHistoryBack,
  recallHistoryForward,
  resetHistoryNav,
  shouldRecallHistory,
  storeInputHistoryEntries,
  type HistoryNav,
} from "./inputHistory.js";

// Slash parity (enforced by tests/desktop-chatParity.test.ts): every
// GUI-visible command from buildRegistry must appear here as /name so the
// static autocomplete check can find it. The runtime autocomplete source is
// SLASH_NAMES below, derived from buildRegistry (not from this comment).
// /help /clear /compact /config /context /init /model /new /permissions /provider /resume /set /cost /changes /diff /undo /review /effort /memory /statusline /mcp /skills /skill
// (/theme is intentionally absent: desktop theme switching lives in the
// titlebar Theme menu. Keep this list in sync with the registry above.)
const SLASH_NAMES = [...buildRegistry({ ...globalThis.process?.env, CLOUDCODE_DESKTOP: "1" }).keys()].map(name => `/${name}`);

type ChatMsg = { id: string; role: "user" | "assistant" | "notice" | "error"; text: string };

// Per-module counter suffix keeps ids unique across rapid sends within the same millisecond.
let sendSeq = 0;
// Separate counter for session-switch status seeds (must never collide with
// turn ids: a seed response is only honored when its id matches exactly).
let seedSeq = 0;

type Completion = { label: string; value: string; replaceStart: number; replaceEnd: number };

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

export function ChatPane({ workspaceId, repoId, sessionId, onSend, onRequestNewSession, onAdoptSession }: { workspaceId: string | undefined; repoId: string | undefined; sessionId: string | undefined; onSend?: (request: { id: string; sessionId: string | undefined; text: string; workspaceId: string | undefined; repoId: string | undefined }) => void; onRequestNewSession?: (workspaceId: string | undefined) => void; onAdoptSession?: (workspaceId: string | undefined, repoId: string | undefined, sessionId: string) => void }) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [completions, setCompletions] = useState<Completion[]>([]);
  const [completionTitle, setCompletionTitle] = useState("Commands");
  const [highlight, setHighlight] = useState(0);
  const [permission, setPermission] = useState<{ id: string; toolName: string; toolInput?: Record<string, unknown> } | undefined>(undefined);
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const completeListRef = useRef<HTMLUListElement | null>(null);
  // Whether the transcript is currently pinned to the bottom. Reset on
  // every session switch (fresh transcript replays to the latest message);
  // cleared by the scroll handler when the user scrolls up to read history.
  const stickRef = useRef(true);
  // IME composition flag: Enter while composing confirms the candidate and
  // must not send the message (critical for CJK input).
  const composingRef = useRef(false);
  // Latest in-flight argument-completion request; stale responses are dropped.
  const completeReq = useRef<{ id: string; prefix: string } | undefined>(undefined);
  const completeSeq = useRef(0);
  // Which list the open dropdown currently shows. Entering argument mode
  // clears a stale command-name list (e.g. "/config" suggesting itself while
  // the backend args load); arg-to-arg typing keeps the current options to
  // avoid flicker between backend roundtrips.
  const completionSource = useRef<"commands" | "args">("commands");
  // Latest new-session callback; stored in a ref so the chat-event
  // subscription below never goes stale when the parent re-renders.
  const newSessionRef = useRef(onRequestNewSession);
  newSessionRef.current = onRequestNewSession;
  // Live selection mirror for the adoption guard below: only adopt when the
  // pane is still showing the anonymous session the event belongs to.
  const liveRef = useRef({ workspaceId, repoId, sessionId });
  liveRef.current = { workspaceId, repoId, sessionId };
  const adoptRef = useRef(onAdoptSession);
  adoptRef.current = onAdoptSession;
  // Remembers an adopted id across the prop change it triggers, so the
  // session-switch effect below keeps the on-screen transcript instead of
  // clearing and replaying the identical history.
  const adoptedRef = useRef<string>();
  // Synchronous mirror of the permission prompt for the chat-event
  // subscription below (closures capture stale state; the ref is current).
  const permissionRef = useRef<{ id: string } | undefined>(undefined);
  // Latest pending turn ids for the same reason: the subscription filters
  // background-session deltas against this, not the render-time state.
  const pendingRef = useRef<string[]>([]);
  pendingRef.current = pendingIds;
  // Composer input history (Up/Down recall, TUI parity). Entries persist to
  // localStorage; cursor/draft track the in-progress recall. Lazily loaded
  // so node-based unit tests can import this module without a window.
  const historyNavRef = useRef<HistoryNav | null>(null);
  if (historyNavRef.current === null) {
    const entries = loadInputHistoryEntries();
    historyNavRef.current = { ...emptyHistoryNav(), entries, cursor: entries.length };
  }
  // Outstanding session-switch status seed (see below); only a status
  // response bearing this exact id may reseed pending state.
  const seedReq = useRef<string>();
  function setPermissionState(next: { id: string; toolName: string; toolInput?: Record<string, unknown> } | undefined) {
    permissionRef.current = next;
    setPermission(next);
  }
  useStoredGuiTheme();

  // Backend scope for this pane: multi-repo workspaces add repoId so the IPC
  // layer resolves the turn against one repo; single-repo panes send none and
  // keep the wire shape exactly as before.
  const scope = repoId === undefined ? {} : { repoId };

  // Session switch: drop the previous transcript, permission prompt, and
  // pending state, then ask the backend to replay the stored history.
  // Adopting an anonymous session skips the reset: the visible transcript
  // already is that session's content.
  useEffect(() => {
    const adopted = adoptedRef.current !== undefined && adoptedRef.current === sessionId;
    adoptedRef.current = undefined;
    if (!adopted) {
      setMessages([]);
      setPendingIds([]);
      setPermissionState(undefined);
      stickRef.current = true;
      completeReq.current = undefined;
      void window.cloudcode.chatHistory(sessionId, workspaceId, repoId);
      // Resync busy state: a turn left running in the background survives
      // the switch (per-session backend), but local pending was just reset.
      // Without reseeding, the next send fails with "already running" while
      // nothing looks busy. The footer polls use different ids and are
      // owned by src.tsx; only this exact seed id is honored below.
      const seedId = `seed-${Date.now()}-${++seedSeq}`;
      seedReq.current = seedId;
      void window.cloudcode.chatStatus({ id: seedId, sessionId, workspaceId, ...scope });
    }
    return window.cloudcode.onChatEvent((event: { id: string; type: string; text?: string; toolName?: string; toolInput?: Record<string, unknown>; items?: Completion[]; sessionId?: unknown; status?: { inFlightId?: unknown } }) => {
      if (isNewSessionEvent(event)) {
        newSessionRef.current?.(workspaceId);
        return;
      }
      const themeName = parseThemeEvent(event);
      if (themeName !== undefined) {
        // Backend-confirmed (persisted) theme: apply and remember as the
        // titlebar menu's revert target.
        confirmGuiTheme(themeName);
        return;
      }
      const adoptedId = parseSessionIdEvent(event);
      if (adoptedId !== undefined) {
        const live = liveRef.current;
        if (live.sessionId === undefined) {
          adoptedRef.current = adoptedId;
          adoptRef.current?.(live.workspaceId, live.repoId, adoptedId);
        }
        return;
      }
      if (event.type === "complete") {
        // Drop stale responses: only the latest request for the unchanged
        // input may populate the dropdown.
        const pending = completeReq.current;
        if (pending && event.id === pending.id && inputRef.current?.value === pending.prefix && event.items) {
          const current = inputRef.current?.value ?? "";
          const items = visibleCompletions(event.items);
          const [only] = items;
          if (items.length === 1 && only && applySuggestionText(current, only) === current) {
            // Pure echo: the option adds nothing (e.g. "/config theme" answered
            // with ["theme"]). Only hide the dropdown here: auto-appending a
            // space rewrites the composer from the async response, which undoes
            // a manual Backspace of that same space and traps incomplete
            // commands ("/config provider" can then only be sent via Enter).
            // Users descend with Space/Tab explicitly instead.
            showCompletions([]);
          } else {
            completionSource.current = "args";
            showCompletions(items, titleForCompletionPrefix(pending.prefix));
          }
        }
        return;
      }
      if (event.id === "backend" && event.type === "error") {
        // Backend died mid-turn: its in-memory turn/permission state is gone
        // with it. Drop the local pending ids and prompt too, or every later
        // Send is silently swallowed (send() early-returns while pending)
        // with no response and no error. The error branch below still posts
        // the "backend exited" bubble; src.tsx raises the retry banner.
        setPendingIds([]);
        setPermissionState(undefined);
      }
      if (event.type === "status") {
        if (event.id === seedReq.current) {
          seedReq.current = undefined;
          const resumed = event.status?.inFlightId;
          if (typeof resumed === "string" && resumed !== "") {
            setPendingIds(current => current.includes(resumed) ? current : [...current, resumed]);
          }
        }
        return;
      }
      if (event.type === "permission_request") {
        setPermissionState({ id: event.id, toolName: event.toolName ?? "tool", toolInput: event.toolInput });
        return;
      }
      if ((event.type === "done" || event.type === "error") && permissionRef.current?.id === event.id) {
        // Turn over: a stale prompt for it can never resolve anymore.
        setPermissionState(undefined);
      }
      if (event.type === "done" || event.type === "error") {
        setPendingIds(current => current.includes(event.id) ? current.filter(id => id !== event.id) : current);
      }
      if (event.type === "user_text" && event.text) {
        setMessages(current => [...current, { id: event.id, role: "user", text: event.text ?? "" }]);
      } else if (event.type === "text_delta" && event.text) {
        // Drop background-session deltas: without this, a turn left running
        // on another session streams into the transcript being viewed.
        if (!isLiveTurnEvent(event.id, pendingRef.current)) return;
        setMessages(current => {
          const last = current[current.length - 1];
          if (last?.id === event.id && last.role === "assistant") {
            return [...current.slice(0, -1), { ...last, text: last.text + (event.text ?? "") }];
          }
          return [...current, { id: event.id, role: "assistant", text: event.text ?? "" }];
        });
      } else if ((event.type === "notice" || event.type === "error") && event.text) {
        setMessages(current => [...current, { id: event.id, role: event.type, text: event.text ?? "" }]);
      }
    });
  }, [sessionId, workspaceId, repoId]);

  function showCompletions(items: Completion[], title = "Commands") {
    setCompletions(items);
    setCompletionTitle(title);
    setHighlight(0);
  }

  function requestArgCompletions(prefix: string) {
    // Backend-driven argument values (live provider/model data).
    completeSeq.current += 1;
    const id = `complete-${Date.now()}-${completeSeq.current}`;
    completeReq.current = { id, prefix };
    void window.cloudcode.chatComplete({ id, prefix, sessionId, workspaceId, ...scope });
  }

  function onChange(value: string) {
    // Every edit is manual now (no async auto-rewrite): abandon any
    // in-progress history recall.
    {
      const nav = historyNavRef.current;
      if (nav && (nav.cursor !== nav.entries.length || nav.draft !== undefined)) {
        historyNavRef.current = resetHistoryNav(nav);
      }
    }
    setInput(value);
    const kind = describeSlashInput(value);
    if (kind.kind === "plain") {
      completeReq.current = undefined;
      showCompletions([]);
      return;
    }
    if (kind.kind === "command") {
      // Command names complete instantly from the local registry copy.
      completeReq.current = undefined;
      completionSource.current = "commands";
      showCompletions(SLASH_NAMES.filter(name => name.startsWith(kind.token)).map(name => ({
        label: name,
        value: `${name} `,
        replaceStart: 0,
        replaceEnd: value.length
      })));
      return;
    }
    if (completionSource.current === "commands") {
      // Leaving the command-name list for backend argument options: drop the
      // stale command rows now so they never flash under the slower backend
      // answers (what stranded the empty-looking "Commands" shell on screen).
      completionSource.current = "args";
      showCompletions([]);
    }
    // No input normalization here: the visible text is only ever what the
    // user typed or explicitly picked (Space/Tab/click). Rewriting it (e.g.
    // "/config" -> "/config ") undoes a manual Backspace and traps the
    // composer so an incomplete command can only leave via Enter.
    requestArgCompletions(kind.prefix);
  }

  // Same splice as applySuggestion in src/commands/completion.ts (duplicated
  // to keep node-only modules out of the renderer bundle): the option only
  // replaces its own token, so the command prefix is never lost — clicking
  // "github" for "/theme gi" yields "/theme github", not a bare prompt.
  function applyCompletion(option: Completion) {
    const current = inputRef.current?.value ?? input;
    onChange(applySuggestionText(current, option));
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  // Transcript scroll-following: after every message update, pin to the
  // bottom only while stuck (session switch replays to the latest message;
  // reading history is never yanked by an incoming delta).
  function onChatListScroll() {
    const el = listRef.current;
    if (!el) return;
    stickRef.current = shouldStickToBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
  }
  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Auto-grow the composer up to a cap, then scroll internally.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [input]);

  // Keep the highlighted completion visible: the dropdown caps at header +
  // ~5 rows with its own scrollbar, so navigating past the visible rows must
  // follow the highlight instead of leaving it hidden below the fold (which
  // looks like the selection fell back into the input area). Focus never
  // leaves the composer; only the list scrolls.
  useEffect(() => {
    const active = completeListRef.current?.querySelector("button.active") as HTMLButtonElement | null | undefined;
    active?.scrollIntoView({ block: "nearest" });
  }, [completions, highlight]);

  // TUI parity: Esc interrupts the running turn (same path as Stop). A
  // textarea-level handler is not enough: after mouse-clicking Send the
  // focus sits on the button, and clicks into the transcript move it out
  // of the composer entirely, so Esc never reaches the input. The window
  // listener covers the whole chat pane; the dropdown keeps its own
  // Esc-to-dismiss (no listener while it is open, so the first Esc only
  // closes it). Scoped out of sidebar/inspector/dialogs, and skipped
  // while IME-composing so confirming a CJK candidate never kills a turn.
  useEffect(() => {
    if (completions.length > 0 || pendingIds.length === 0) return;
    function onWindowKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (!target?.closest?.(".chat-pane")) return;
      event.preventDefault();
      const last = pendingIds[pendingIds.length - 1];
      if (last) abort(last);
    }
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [completions.length, pendingIds]);

  // History recall behind Up/Down (TUI parity): replaces the whole composer
  // value, suppresses the slash dropdown (like the TUI's suppressed flag),
  // and parks the caret at the end. Returns true when a recall happened.
  function recallInputHistory(direction: "up" | "down"): boolean {
    const el = inputRef.current;
    const value = el?.value ?? input;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    if (!shouldRecallHistory(value, start, end, direction)) return false;
    const nav = historyNavRef.current;
    if (!nav) return false;
    const recalled = direction === "up" ? recallHistoryBack(nav, value) : recallHistoryForward(nav);
    if (!recalled) return false;
    historyNavRef.current = recalled.nav;
    setInput(recalled.text);
    completeReq.current = undefined;
    showCompletions([]);
    requestAnimationFrame(() => {
      const ta = inputRef.current;
      if (ta) ta.selectionStart = ta.selectionEnd = ta.value.length;
    });
    return true;
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "ArrowDown" && completions.length > 0) {
      event.preventDefault();
      setHighlight(current => (current + 1) % completions.length);
      return;
    }
    if (event.key === "ArrowUp" && completions.length > 0) {
      event.preventDefault();
      setHighlight(current => (current - 1 + completions.length) % completions.length);
      return;
    }
    if (event.key === "ArrowUp" && completions.length === 0) {
      if (recallInputHistory("up")) event.preventDefault();
      return;
    }
    if (event.key === "ArrowDown" && completions.length === 0) {
      if (recallInputHistory("down")) event.preventDefault();
      return;
    }
    if (event.key === "Tab" && completions.length > 0) {
      event.preventDefault();
      const option = completions[highlight] ?? completions[0];
      if (option) applyCompletion(option);
      return;
    }
    if (event.key === "Escape" && completions.length > 0) {
      event.preventDefault();
      completeReq.current = undefined;
      showCompletions([]);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      // Let IME candidate confirmation through; only a clean Enter sends.
      if (event.nativeEvent.isComposing || composingRef.current) return;
      event.preventDefault();
      send();
    }
  }

  function send() {
    const text = input.trim();
    if (!text) return;
    if (pendingIds.length > 0) return;
    const id = `${Date.now()}-${++sendSeq}`;
    setPendingIds(current => [...current, id]);
    if (echoUserBubble(text)) {
      setMessages(current => [...current, { id, role: "user", text }]);
    }
    // Record every sent prompt (including slash commands, like the TUI) so
    // Up/Down can re-run it later.
    const nav = historyNavRef.current;
    if (nav) {
      const entries = pushInputHistoryEntry(nav.entries, text);
      storeInputHistoryEntries(entries);
      historyNavRef.current = { entries, cursor: entries.length, draft: undefined };
    }
    setInput("");
    completeReq.current = undefined;
    showCompletions([]);
    // Mouse-clicking Send leaves focus on the button; park it back in the
    // composer so Up/Down history recall keeps working without re-clicking.
    requestAnimationFrame(() => inputRef.current?.focus());
    onSend?.({ id, sessionId, text, workspaceId, repoId });
    void window.cloudcode.chatSend({ id, sessionId, text, workspaceId, ...scope });
  }

  function abort(id: string) {
    setPendingIds(current => current.filter(pending => pending !== id));
    // A prompt for the aborted turn can never resolve (the backend denies
    // the outstanding request on abort); drop it instead of stranding it.
    if (permissionRef.current?.id === id) setPermissionState(undefined);
    setMessages(current => [...current, { id, role: "notice", text: "Cancelled." }]);
    // The Stop button unmounts once nothing is pending; without this, focus
    // is lost to the page and composer shortcuts (Up/Down history) go dead.
    requestAnimationFrame(() => inputRef.current?.focus());
    void window.cloudcode.chatAbort(id);
  }

  function respond(allow: boolean) {
    if (!permission) return;
    void window.cloudcode.chatRespond({ id: permission.id, allow });
    setPermissionState(undefined);
  }

  return (
    <section className={completions.length > 0 ? "chat-pane has-complete" : "chat-pane"}>
      {permission && (
        <div className="permission-overlay" role="alertdialog" aria-label="Permission request">
          <strong>Allow {permission.toolName}?</strong>
          <pre>{JSON.stringify(permission.toolInput ?? {}, null, 2)}</pre>
          <button onClick={() => respond(true)}>Allow</button>
          <button onClick={() => respond(false)}>Deny</button>
        </div>
      )}
      <div className="chat-list" role="log" aria-label="Conversation" ref={listRef} onScroll={onChatListScroll}>
        {messages.map((message, index) => (
          <article key={`${message.id}-${message.role}-${index}`} className={`bubble ${message.role}`}>
            <pre>{message.text}</pre>
          </article>
        ))}
      </div>
      {completions.length > 0 && (
        <ul ref={completeListRef} className="slash-complete" aria-label="Slash commands" data-title={completionTitle}>
          {completions.map((option, index) => <li key={option.label}><button className={index === highlight ? "active" : ""} onClick={() => applyCompletion(option)}>{option.label}</button></li>)}
        </ul>
      )}
      <div className="chat-input">
        <textarea
          ref={inputRef}
          rows={1}
          aria-label="Message input"
          value={input}
          onChange={event => onChange(event.target.value)}
          onKeyDown={onInputKeyDown}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          placeholder="Message, or / for commands (Shift+Enter for newline)"
        />
        <button className="chat-send" onClick={send} disabled={pendingIds.length > 0}>Send</button>
        {pendingIds.length > 0 && <button className="chat-stop" aria-label="Abort turn" onClick={() => { const last = pendingIds[pendingIds.length - 1]; if (last) abort(last); }}>Stop</button>}
      </div>
      {busyLabel(pendingIds.length) !== null && (
        <div className="chat-busy-floating" aria-hidden="false">
          <span className="chat-busy" role="status">
            {busyLabel(pendingIds.length)}<span className="chat-busy-dots" aria-hidden="true" />
          </span>
        </div>
      )}
    </section>
  );
}
