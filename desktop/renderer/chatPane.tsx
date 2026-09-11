import { useEffect, useRef, useState } from "react";
import { buildRegistry } from "../../src/commands/builtins.js";

// Slash parity (enforced by tests/desktop-chatParity.test.ts): every
// GUI-visible command from buildRegistry must appear here as /name so the
// static autocomplete check can find it. The runtime autocomplete source is
// SLASH_NAMES below, derived from buildRegistry (not from this comment).
// /help /clear /compact /config /context /init /model /new /permissions /provider /resume /set /cost /changes /diff /undo /review /effort /memory /statusline /mcp /skills /skill /theme
const SLASH_NAMES = [...buildRegistry({ ...globalThis.process?.env, CLOUDCODE_DESKTOP: "1" }).keys()].map(name => `/${name}`);

type ChatMsg = { id: string; role: "user" | "assistant" | "notice" | "error"; text: string };

// Per-module counter suffix keeps ids unique across rapid sends within the same millisecond.
let sendSeq = 0;

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
// An exactly-typed command name ("/config") jumps straight to its argument
// options so users discover arguments without knowing the full command;
// anything else completes command names, and plain text shows nothing.
export function describeSlashInput(value: string): SlashInputKind {
  if (!value.startsWith("/")) return { kind: "plain" };
  if (!value.includes(" ")) {
    if ((SLASH_NAMES as string[]).includes(value)) return { kind: "args", prefix: `${value} ` };
    return { kind: "command", token: value };
  }
  return { kind: "args", prefix: value };
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

export function ChatPane({ workspaceId, sessionId, onSend, onRequestNewSession, onAdoptSession }: { workspaceId: string | undefined; sessionId: string | undefined; onSend?: (request: { id: string; sessionId: string | undefined; text: string; workspaceId: string | undefined }) => void; onRequestNewSession?: (workspaceId: string | undefined) => void; onAdoptSession?: (workspaceId: string | undefined, sessionId: string) => void }) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [completions, setCompletions] = useState<Completion[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [permission, setPermission] = useState<{ id: string; toolName: string; toolInput?: Record<string, unknown> } | undefined>(undefined);
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // IME composition flag: Enter while composing confirms the candidate and
  // must not send the message (critical for CJK input).
  const composingRef = useRef(false);
  // Latest in-flight argument-completion request; stale responses are dropped.
  const completeReq = useRef<{ id: string; prefix: string } | undefined>(undefined);
  const completeSeq = useRef(0);
  // One-shot guard for nested descent (below): prevents "/provider anthropic"
  // style dead-ends from appending spaces forever.
  const nestedOnce = useRef(false);
  // Latest new-session callback; stored in a ref so the chat-event
  // subscription below never goes stale when the parent re-renders.
  const newSessionRef = useRef(onRequestNewSession);
  newSessionRef.current = onRequestNewSession;
  // Live selection mirror for the adoption guard below: only adopt when the
  // pane is still showing the anonymous session the event belongs to.
  const liveRef = useRef({ workspaceId, sessionId });
  liveRef.current = { workspaceId, sessionId };
  const adoptRef = useRef(onAdoptSession);
  adoptRef.current = onAdoptSession;
  // Remembers an adopted id across the prop change it triggers, so the
  // session-switch effect below keeps the on-screen transcript instead of
  // clearing and replaying the identical history.
  const adoptedRef = useRef<string>();

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
      setPermission(undefined);
      nestedOnce.current = false;
      completeReq.current = undefined;
      void window.cloudcode.chatHistory(sessionId, workspaceId);
    }
    return window.cloudcode.onChatEvent((event: { id: string; type: string; text?: string; toolName?: string; toolInput?: Record<string, unknown>; items?: Completion[]; sessionId?: unknown }) => {
      if (isNewSessionEvent(event)) {
        newSessionRef.current?.(workspaceId);
        return;
      }
      const adoptedId = parseSessionIdEvent(event);
      if (adoptedId !== undefined) {
        const live = liveRef.current;
        if (live.sessionId === undefined) {
          adoptedRef.current = adoptedId;
          adoptRef.current?.(live.workspaceId, adoptedId);
        }
        return;
      }
      if (event.type === "complete") {
        // Drop stale responses: only the latest request for the unchanged
        // input may populate the dropdown.
        const pending = completeReq.current;
        if (pending && event.id === pending.id && inputRef.current?.value === pending.prefix && event.items) {
          const current = inputRef.current?.value ?? "";
          const [only] = event.items;
          if (event.items.length === 1 && only && applySuggestionText(current, only) === current) {
            // Pure echo: the option adds nothing (e.g. "/config theme" answered
            // with ["theme"]). Descend one nesting level automatically so the
            // next options appear; hide the dropdown if there is nothing deeper.
            if (!current.endsWith(" ") && !nestedOnce.current) {
              nestedOnce.current = true;
              onChange(`${current} `, true);
            } else {
              showCompletions([]);
            }
          } else {
            showCompletions(event.items);
          }
        }
        return;
      }
      if (event.type === "permission_request") {
        setPermission({ id: event.id, toolName: event.toolName ?? "tool", toolInput: event.toolInput });
        return;
      }
      if (event.type === "done" || event.type === "error") {
        setPendingIds(current => current.includes(event.id) ? current.filter(id => id !== event.id) : current);
      }
      if (event.type === "user_text" && event.text) {
        setMessages(current => [...current, { id: event.id, role: "user", text: event.text ?? "" }]);
      } else if (event.type === "text_delta" && event.text) {
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
  }, [sessionId, workspaceId]);

  function showCompletions(items: Completion[]) {
    setCompletions(items);
    setHighlight(0);
  }

  function requestArgCompletions(prefix: string) {
    // Backend-driven argument values (live provider/model data).
    completeSeq.current += 1;
    const id = `complete-${Date.now()}-${completeSeq.current}`;
    completeReq.current = { id, prefix };
    void window.cloudcode.chatComplete({ id, prefix, sessionId, workspaceId });
  }

  function onChange(value: string, auto = false) {
    if (!auto) nestedOnce.current = false;
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
      showCompletions(SLASH_NAMES.filter(name => name.startsWith(kind.token)).map(name => ({
        label: name,
        value: `${name} `,
        replaceStart: 0,
        replaceEnd: value.length
      })));
      return;
    }
    if (kind.prefix !== value) {
      // Exactly-typed command ("/config"): the backend offsets assume the
      // trailing space, so normalize the visible input first.
      setInput(kind.prefix);
      requestArgCompletions(kind.prefix);
      return;
    }
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

  // Auto-grow the composer up to a cap, then scroll internally.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [input]);

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
    const id = `${Date.now()}-${++sendSeq}`;
    setPendingIds(current => [...current, id]);
    setMessages(current => [...current, { id, role: "user", text }]);
    setInput("");
    completeReq.current = undefined;
    nestedOnce.current = false;
    showCompletions([]);
    onSend?.({ id, sessionId, text, workspaceId });
    void window.cloudcode.chatSend({ id, sessionId, text, workspaceId });
  }

  function abort(id: string) {
    setPendingIds(current => current.filter(pending => pending !== id));
    setMessages(current => [...current, { id, role: "notice", text: "Cancelled." }]);
    void window.cloudcode.chatAbort(id);
  }

  function respond(allow: boolean) {
    if (!permission) return;
    void window.cloudcode.chatRespond({ id: permission.id, allow });
    setPermission(undefined);
  }

  return (
    <section className="chat-pane">
      {permission && (
        <div className="permission-overlay" role="alertdialog" aria-label="Permission request">
          <strong>Allow {permission.toolName}?</strong>
          <pre>{JSON.stringify(permission.toolInput ?? {}, null, 2)}</pre>
          <button onClick={() => respond(true)}>Allow</button>
          <button onClick={() => respond(false)}>Deny</button>
        </div>
      )}
      <div className="chat-list" role="log" aria-label="Conversation">
        {messages.map((message, index) => (
          <article key={`${message.id}-${message.role}-${index}`} className={`bubble ${message.role}`}>
            <pre>{message.text}</pre>
          </article>
        ))}
      </div>
      {completions.length > 0 && (
        <ul className="slash-complete" aria-label="Slash commands">
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
        <button className="chat-send" onClick={send}>Send</button>
        {pendingIds.length > 0 && <button className="chat-stop" aria-label="Abort turn" onClick={() => { const last = pendingIds[pendingIds.length - 1]; if (last) abort(last); }}>Stop</button>}
      </div>
    </section>
  );
}
