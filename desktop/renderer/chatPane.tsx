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

export function ChatPane({ workspaceId, sessionId, onSend }: { workspaceId: string | undefined; sessionId: string | undefined; onSend?: (request: { id: string; sessionId: string | undefined; text: string; workspaceId: string | undefined }) => void }) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [completions, setCompletions] = useState<Completion[]>([]);
  const [permission, setPermission] = useState<{ id: string; toolName: string; toolInput?: Record<string, unknown> } | undefined>(undefined);
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Latest in-flight argument-completion request; stale responses are dropped.
  const completeReq = useRef<{ id: string; prefix: string } | undefined>(undefined);
  const completeSeq = useRef(0);

  // Session switch: drop the previous transcript, permission prompt, and
  // pending state, then ask the backend to replay the stored history.
  useEffect(() => {
    setMessages([]);
    setPendingIds([]);
    setPermission(undefined);
    void window.cloudcode.chatHistory(sessionId);
    return window.cloudcode.onChatEvent((event: { id: string; type: string; text?: string; toolName?: string; toolInput?: Record<string, unknown>; items?: Completion[] }) => {
      if (event.type === "complete") {
        // Drop stale responses: only the latest request for the unchanged
        // input may populate the dropdown.
        const pending = completeReq.current;
        if (pending && event.id === pending.id && inputRef.current?.value === pending.prefix && event.items) {
          setCompletions(event.items);
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
  }, [sessionId]);

  function onChange(value: string) {
    setInput(value);
    if (!value.startsWith("/")) {
      completeReq.current = undefined;
      setCompletions([]);
      return;
    }
    if (!value.includes(" ")) {
      // Command names complete instantly from the local registry copy.
      completeReq.current = undefined;
      const token = value;
      setCompletions(SLASH_NAMES.filter(name => name.startsWith(token)).map(name => ({
        label: name,
        value: `${name} `,
        replaceStart: 0,
        replaceEnd: value.length
      })));
      return;
    }
    // Argument values come from the backend (live provider/model data).
    completeSeq.current += 1;
    const id = `complete-${Date.now()}-${completeSeq.current}`;
    completeReq.current = { id, prefix: value };
    void window.cloudcode.chatComplete({ id, prefix: value, sessionId, workspaceId });
  }

  // Same splice as applySuggestion in src/commands/completion.ts (duplicated
  // to keep node-only modules out of the renderer bundle): the option only
  // replaces its own token, so the command prefix is never lost — clicking
  // "github" for "/theme gi" yields "/theme github", not a bare prompt.
  function applyCompletion(option: Completion) {
    const current = inputRef.current?.value ?? input;
    const next = current.slice(0, option.replaceStart) + option.value + current.slice(option.replaceEnd);
    onChange(next);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function send() {
    const text = input.trim();
    if (!text) return;
    const id = `${Date.now()}-${++sendSeq}`;
    setPendingIds(current => [...current, id]);
    setMessages(current => [...current, { id, role: "user", text }]);
    setInput("");
    setCompletions([]);
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
          {completions.map(option => <li key={option.label}><button onClick={() => applyCompletion(option)}>{option.label}</button></li>)}
        </ul>
      )}
      <div className="chat-input">
        <input ref={inputRef} aria-label="Message input" value={input} onChange={event => onChange(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } }} placeholder="Message, or / for commands" />
        <button onClick={send}>Send</button>
        {pendingIds.length > 0 && <button aria-label="Abort turn" onClick={() => { const last = pendingIds[pendingIds.length - 1]; if (last) abort(last); }}>Stop</button>}
      </div>
    </section>
  );
}
